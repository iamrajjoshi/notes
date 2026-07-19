---
title: PostgreSQL Storage, Query, and MVCC Internals
description: Follow a PostgreSQL statement through a backend process, parser, planner, executor, heap pages, indexes, MVCC visibility, WAL, vacuum, and crash recovery.
slug: postgresql-storage-query-and-mvcc-internals
order: 5
identifier: DB5
duration: 4 hours
difficulty: Advanced
tags:
  - PostgreSQL
  - heap
  - MVCC
  - WAL
  - vacuum
  - query planner
  - indexes
---

## Working model

PostgreSQL is not “a SQL layer over files.” One statement crosses a client session, a backend process, catalogs, parser and rewrite rules, a cost-based planner, executor nodes, shared buffers, heap and index access methods, multi-version concurrency control (MVCC) visibility, write-ahead logging (WAL), and background maintenance. The useful unit of study is one statement through those boundaries.

This note uses the built-in heap table access method and built-in B-tree indexes. Extensions and other access methods can change physical behavior while keeping the SQL interface.

## A server process coordinates many backend processes

One PostgreSQL cluster is a running server instance plus its data directory. The postmaster starts shared memory and background processes, accepts connections, and normally creates one backend process for each client connection. A backend parses, plans, and executes that session's statements. Backends share buffer metadata, locks, WAL state, catalogs, and other coordination structures.

The process-per-connection model makes a connection an allocated execution context, not merely a TCP socket. A session can own transaction state, locks, temporary relations, prepared statements, and per-node executor memory. Thousands of mostly idle backends still consume memory and coordination overhead; thousands of active backends can exceed CPU, I/O, and lock-manager capacity.

Connection pooling controls admission. Session pooling preserves one database session for one client connection. Transaction pooling can give a different backend to each transaction, which changes the behavior of session variables, temporary objects, advisory locks, and prepared statements. A pool should bound active database work and expose pool wait separately from query time.

Several background processes divide maintenance and durability work. The WAL writer flushes WAL buffers, the checkpointer establishes recovery points and coordinates dirty-buffer writeback, the background writer can move dirty shared buffers toward storage, and autovacuum workers vacuum or analyze eligible relations. Their responsibilities overlap through shared state but are not interchangeable.

## Namespaces and physical files are different hierarchies

SQL names form a logical hierarchy: cluster, database, schema, relation, and object name. Physical storage uses tablespaces, relation identifiers, relation forks, file segments, pages, and item identifiers.

A table's main fork stores heap pages. Other forks can include:

- a free-space map that records approximate free space by heap page;
- a visibility map with all-visible and all-frozen bits per heap page;
- an initialization fork for an unlogged relation;
- separate relation files for each index and Oversized-Attribute Storage Technique (TOAST) relation.

Large relations are divided into file segments; PostgreSQL documentation currently describes 1 GiB segments for the ordinary layout. A relation's file node can change during operations such as `TRUNCATE`, `REINDEX`, `CLUSTER`, and some `ALTER TABLE` forms, so a table's object identifier (OID) is not a permanent filename.

Pages are normally 8 KiB at a standard build. A heap page contains a header, an array of item identifiers, free space, and tuple bytes. An item identifier records an offset and length; its array position remains stable while tuple bytes can move during page compaction. A tuple identifier, commonly exposed as `ctid`, names a block number plus item position. It is a physical version address, not a durable application key. An update can create a new tuple with another `ctid`, and a table rewrite can change every physical address.

## A heap tuple carries data and concurrency metadata

Each heap tuple has a header in addition to user columns. Important fields include the inserting transaction ID (`xmin`), a deleting or superseding transaction ID (`xmax`) when present, command and visibility flags, null information, and a link used for newer versions. Visibility code combines this metadata with transaction status and the reader's snapshot.

The tuple does not contain a simple permanent `visible = true` flag. A version can be visible to one snapshot and invisible to another. Commit status may come from transaction-status structures, while hint bits can cache conclusions in tuple headers during later access. Updating hint bits can dirty an otherwise read page, which is one reason a read workload can cause some writes.

PostgreSQL's heap does not cluster every row under the primary-key index. An index leaf normally stores its key plus a heap tuple identifier. An index scan finds candidate tuple locations, fetches heap pages, and applies MVCC visibility. An index-only scan can return indexed columns without fetching every heap tuple only when the index covers the requested values and the visibility map says the heap page is all-visible. If not, the executor must visit the heap to decide visibility.

## Large fields move through TOAST

PostgreSQL must fit a tuple onto one heap page. TOAST can compress or move large variable-length values out of line into an associated TOAST table. The main tuple then stores a pointer to chunks kept in that table.

This makes the logical row size a poor predictor of one-row I/O. Reading columns that remain inline may avoid fetching a large body; selecting the body can require TOAST index and table reads plus decompression. Updating an unrelated column may preserve an unchanged out-of-line value, but changing the large field creates new stored state and later cleanup work.

Column projection therefore matters even in a row store. `SELECT *` can fetch and decode large attributes that an endpoint does not use. Measure returned bytes, heap pages, TOAST reads, decompression CPU, and cache behavior rather than inferring cost from row count alone.

## One `SELECT` becomes an executor tree

The backend first parses SQL into a syntax tree, performs semantic analysis against catalogs, and applies rewrite rules. The planner transforms the query into candidate paths, estimates rows and costs, and selects a plan. The executor pulls tuples through the selected plan tree until the statement completes or a parent node stops requesting rows.

Planner costs are unitless estimates built from row-count statistics and configured relative costs for page access and CPU work. They are not predicted milliseconds. An operator's startup cost is work before it can return the first row; total cost estimates work to exhaust it. A `LIMIT` can make a low-startup plan preferable even when its full-run cost is higher.

Common executor nodes include sequential and index scans, bitmap heap scans, nested-loop, hash, and merge joins, sorts, aggregates, materialization, gather nodes for parallel work, and modification nodes. The plan is a tree, so read it from the leaves that produce rows through the parents that filter, join, sort, or aggregate them.

`EXPLAIN (ANALYZE, BUFFERS)` executes the statement and reports actual rows, loops, time, and buffer activity. For a mutating statement it really performs the mutation unless enclosed in a transaction that is rolled back. Large gaps between estimated and actual rows near the bottom of a plan can change join order, memory demand, and repeated inner work above them.

## Statistics summarize distributions rather than storing every value

`ANALYZE` samples a table and records statistics such as null fraction, common values, histograms, distinct-value estimates, and physical correlation. The planner combines these summaries with predicates and relation metadata to estimate rows.

Per-column statistics can fail when columns are correlated. If `country = 'US'` and `state = 'CA'` are strongly related, multiplying independent selectivities can severely underestimate the pair. Extended statistics can describe functional dependencies, multivariate distinct counts, and common value combinations for selected column groups. They help only when created for the relevant relation and predicates and refreshed by analysis.

The planner chooses from evidence available at plan time. Prepared statements can use custom plans based on parameter values at first and later consider a generic plan. A generic plan that is acceptable for the median tenant can be poor for a tenant holding 40% of a table. Compare the parameter class, plan type, row estimates, and actual work before forcing a plan or adding an index.

## Follow a point read through a B-tree and heap

Consider this query:

```sql
SELECT status, total_cents
FROM orders
WHERE tenant_id = $1
  AND order_id = $2;
```

Assume a unique B-tree on `(tenant_id, order_id)`. The backend descends index pages from root through internal pages to a leaf entry. Root and upper pages are often cached because many lookups share them. The leaf supplies a heap tuple identifier. The executor pins the target heap buffer, checks tuple visibility under the statement snapshot, reads the requested attributes, and returns the row.

The physical path can be longer than “one index lookup”:

1. Check the buffer table for each required index or heap page.
2. Read missing pages from the relation file into shared buffers.
3. Search the B-tree and follow its heap tuple identifier.
4. Examine tuple header and transaction status for visibility.
5. Follow an update chain if the index points to a version whose chain contains the visible tuple.
6. Fetch out-of-line data if a selected column is toasted.
7. Encode the result and send it through the client protocol.

An index-only alternative could include `status` and `total_cents`, but it would enlarge and update the index. It also depends on all-visible heap pages; a hot table with frequent updates may still perform heap fetches. The correct evidence is actual heap fetches, buffers, index size, update rate, and latency under representative cache state.

## An update creates another logical row version

Suppose this statement changes an order status:

```sql
UPDATE orders
SET status = 'paid', updated_at = clock_timestamp()
WHERE tenant_id = $1
  AND order_id = $2
  AND status = 'pending';
```

The executor locates a visible candidate and acquires the required row-level write coordination. It rechecks conditions as required by the isolation and concurrency path, forms a new tuple version, and marks the old version as superseded. It also maintains indexes whose represented values or tuple references require a new entry. WAL records make the page and index changes recoverable.

The affected-row count is part of the application protocol. One row means this transaction won the `pending` to `paid` transition. Zero can mean the order is absent, belongs to another tenant, or already left `pending`; the service may issue a read to distinguish those cases. A separate unguarded read followed by an update would leave a race between the decision and mutation.

Because older snapshots may still need the original tuple, the update cannot immediately erase it. Dead tuples and index entries become maintenance debt. A workload that repeatedly updates wide rows or indexed columns can write much more than its logical changed bytes.

## HOT can avoid new entries in unchanged indexes

A heap-only tuple (HOT) update is possible when the update does not change any columns referenced by indexes, there is enough space on the same heap page for the new tuple, and other access-method conditions permit it. The old tuple points through an on-page chain to the newer version. Existing index entries can continue to reach the chain, so PostgreSQL avoids inserting a new entry into every unchanged index.

HOT reduces index write amplification and later index cleanup. It is not an application guarantee. A high fill factor leaves less room for same-page versions; lowering the table fill factor reserves page space at the cost of a larger heap. Adding an index on a frequently changed column can disqualify those updates from HOT. Track HOT update ratio, page free space, tuple width, and index set before treating fill factor as a general tuning rule.

Pruning can remove dead versions from an on-page chain when no snapshot needs them, while vacuum performs broader cleanup and index maintenance. Pruning a page is not the same as completing routine vacuum work across the relation.

## MVCC visibility changes with the isolation level

At PostgreSQL `READ COMMITTED`, each statement obtains a fresh snapshot. Two selects in one transaction can see different committed states. At `REPEATABLE READ`, the transaction sees a stable snapshot, and PostgreSQL can abort a conflicting update that cannot apply safely to the version the transaction observed. At `SERIALIZABLE`, Serializable Snapshot Isolation tracks dependency patterns and aborts executions that could produce a non-serializable result.

Ordinary `SELECT` does not take row locks that block writers. `SELECT ... FOR UPDATE` and related locking clauses change the contract by locking selected rows for later mutation. Table-level lock modes are also acquired automatically by many commands. A schema change can wait behind ordinary transactions, and a seemingly small transaction can wait behind a schema lock.

Long-lived snapshots preserve old tuples even if they do little CPU work. An idle transaction, abandoned cursor, prepared transaction, or replication slot can hold an old horizon. Measure transaction age and snapshot horizons separately from query duration.

## WAL protects recovery before heap pages reach storage

Before a dirty data page may reach durable storage, WAL describing its change must be durable through the relevant log position. A synchronous commit waits for its required commit WAL condition, not for every heap and index page to be written. This converts scattered foreground page writes into mostly sequential log durability plus deferred page writeback.

WAL records have log sequence numbers (LSNs). A page header records the LSN of its latest WAL-protected change. Recovery begins from a checkpoint redo position and replays needed records. Full-page images protect against torn-page risk by logging a complete page on its first modification after a checkpoint when `full_page_writes` is enabled.

One WAL flush can make several concurrent commits durable through group commit. This improves throughput when commits overlap, but a single low-concurrency commit still pays the underlying flush latency. `synchronous_commit` can weaken when a client is acknowledged, so the exact durability statement must include configuration and any synchronous-replication requirement.

Checkpoints bound recovery work and WAL recycling. A sharp checkpoint can generate write bursts, evict useful cache state, and increase foreground latency. PostgreSQL spreads checkpoint writes over a target interval, but sustained dirtying still needs enough storage bandwidth. Observe WAL bytes per second, checkpoint frequency and duration, buffers written by backend versus checkpoint, storage latency, and restart requirements together.

## Vacuum reclaims versions and maintains visibility metadata

Routine vacuum identifies heap tuples no longer visible to any relevant snapshot, removes their dead index entries, marks heap space reusable, updates the visibility map, and freezes old transaction identifiers. It normally does not shrink the relation file or return ordinary internal free space to the operating system.

The visibility map stores two bits per heap page: all-visible and all-frozen. All-visible lets vacuum skip some work and lets an index-only scan trust that every tuple on the page is visible without visiting the heap. All-frozen says tuples on the page no longer need future transaction-ID freezing. A data change clears the relevant bits; vacuum sets them after proving the condition.

Autovacuum decides when to process a relation using thresholds plus scale factors based on estimated relation size. A fixed scale factor can wait too long on a huge table because the trigger grows with table size. A small but intensely updated table may need different thresholds from a large append-mostly table. Configure and inspect per relation when workload shapes differ.

`ANALYZE` and `VACUUM` are separate even when autovacuum performs both kinds of work. Accurate planner statistics do not reclaim dead versions, and a clean heap does not imply accurate estimates.

## Transaction-ID freezing protects visibility across wraparound

PostgreSQL normal transaction identifiers (XIDs) use a 32-bit space and are compared with wraparound-aware ordering. A tuple left with an ordinary old insertion XID cannot remain correctly ordered forever. Vacuum marks sufficiently old tuple versions frozen so they are treated as visible to all future normal transactions.

Anti-wraparound vacuum is a correctness mechanism, not optional housekeeping. PostgreSQL invokes it for old relations even when ordinary autovacuum is disabled, and it can eventually refuse commands that assign new transaction IDs rather than risk incorrect visibility. Old prepared transactions, long transactions, replication slots, and neglected databases can prevent the frozen horizon from advancing.

Monitor database and relation XID age well before emergency thresholds. The repair is to remove the horizon blocker and allow the required vacuum work; `VACUUM FULL` is not the routine answer and itself has locking, rewrite, disk, and transaction-ID costs.

## Bloat is several different physical conditions

“Bloat” can refer to reusable free heap space, dead tuples not yet reclaimable, sparse pages after deletes, obsolete B-tree entries, or a relation file much larger than live data. These states have different causes and repairs.

Routine vacuum can reuse dead-tuple space inside the existing file. It does not normally compact all live tuples toward the start and truncate the file. `VACUUM FULL` rewrites the table under a strong lock. `CLUSTER` rewrites a table in an index order. Online rewrite tools and logical migrations introduce triggers, change capture, extra storage, and cutover state. Reindexing rebuilds an index but does not fix the heap.

First locate the retained state: old snapshot, low vacuum capacity, HOT failure, index churn, bulk delete, or a table layout whose steady live set is smaller than its historical high-water mark. Choose a rewrite only when reclaiming files or restoring physical order earns its lock, WAL, replica, disk, and rollback cost.

## Memory is allocated at several scopes

`shared_buffers` is a shared page cache, not a cap on all database memory. Each backend also uses private memory for sorts, hashes, aggregates, protocol data, and maintenance. `work_mem` is broadly a limit per eligible plan operation, not per connection or query. A parallel query or a plan with several simultaneous hash and sort nodes can multiply it across workers and nodes.

A hash join that exceeds memory can batch to temporary files; a sort can switch to an external merge. More memory can remove a spill but multiplying a large setting by active operations can exhaust the host. Inspect actual concurrent plan nodes, temp bytes, active backends, and operating-system memory before increasing a global value.

PostgreSQL also relies on the operating system cache for relation files. A shared-buffer hit avoids a PostgreSQL-managed read; a shared-buffer miss may still be served from the OS cache. `EXPLAIN BUFFERS` reports PostgreSQL buffer behavior, not direct device latency by itself.

## Worked trace: update one hot order safely

Assume `orders` has 800 million rows. A tenant's order is located by a unique B-tree on `(tenant_id, order_id)`. The row has a 20 KiB receipt body stored out of line. The service performs 12,000 guarded status changes each second, and one large tenant supplies 25% of them.

For one `pending` to `paid` request:

1. The request waits for a pooled backend; pool wait is charged to the API deadline.
2. The backend parses and plans the prepared update. Representative parameters matter because tenant distribution is skewed.
3. The B-tree lookup reaches a heap tuple and checks visibility.
4. The conditional predicate establishes whether this request can win the transition.
5. PostgreSQL coordinates with any concurrent updater of the same tuple.
6. The new tuple changes indexed `status`, so this update cannot use HOT for indexes that include status. The unchanged receipt does not need to be returned to the client.
7. Heap and index changes generate WAL. Commit acknowledgement waits at the configured WAL and replication boundary.
8. A transactionally inserted outbox row records the later receipt-delivery intent.
9. Old versions and index entries remain until no snapshot needs them and vacuum processes the relation.

Suppose the logical row change is only 40 bytes, but the engine emits 1.5 KiB of WAL across the heap, indexes, and outbox, later writes several dirty 8 KiB pages, sends WAL to replicas, and vacuums obsolete versions. Logical payload size is not the storage-bandwidth estimate.

The hotspot calculation also matters:

```text
total guarded updates = 12,000/s
largest tenant share = 25%
largest tenant updates = 3,000/s

if one order receives 400 updates/s:
that tuple's transition rule is one serialized conflict domain
```

Adding application workers can help distinct orders but cannot make conflicting changes to the same order commit simultaneously. Observe pool wait, execution time, row-lock wait, affected-row count, WAL bytes, HOT ratio, dead tuples, vacuum progress, replica replay, temp I/O, and p99 by tenant. Each signal names a different stage of the path.

## Read PostgreSQL evidence by boundary

| Boundary     | Useful evidence                                             | Typical question                                                |
| ------------ | ----------------------------------------------------------- | --------------------------------------------------------------- |
| Admission    | Pool active, waiting, timeout, backend count                | Is work queued before PostgreSQL or already inside it?          |
| Planning     | Plan type, estimated rows, statistics age                   | Did the optimizer misjudge distribution or use a generic plan?  |
| Execution    | Actual rows and loops, buffers, temp bytes                  | Which node multiplies work or spills?                           |
| Concurrency  | Lock wait, blocker, transaction age, serialization failures | Is latency execution or waiting on another transaction?         |
| Durability   | WAL rate, flush latency, checkpoint writes                  | Is commit waiting on log or are dirty pages saturating storage? |
| MVCC cleanup | Dead tuples, HOT updates, vacuum progress, oldest horizon   | Which snapshot or workload prevents reuse?                      |
| Replication  | Sent, written, flushed, replayed LSNs                       | Is the replica network-, disk-, or replay-bound?                |
| Capacity     | Relation and index bytes, cache hit context, IOPS, CPU      | Which physical resource is the present limit?                   |

The views and functions change across releases. Treat the linked current manual as the source of field semantics, and record the server version with incident evidence.

## Summary

PostgreSQL stores heap tuple versions separately from ordinary indexes and uses snapshot visibility to choose among them. WAL can make a transaction durable before every dirty heap or index page reaches its relation file. Vacuum later reclaims obsolete versions, maintains visibility metadata, and freezes old transaction IDs.

- A connection normally owns a backend process and private execution state. Pool active database work and measure admission wait.
- Logical names do not map permanently to filenames. Relations have forks, segments, pages, item identifiers, and separate index or TOAST storage.
- An index entry usually leads to a heap tuple whose visibility must be checked. Index-only scans depend on covered columns and all-visible pages.
- Updates create tuple versions. HOT avoids new entries in unchanged indexes only when all physical conditions hold.
- Query plans depend on sampled statistics, parameter distribution, cost settings, and available operators. Compare estimates with actual rows, loops, buffers, and spills.
- `work_mem` can be consumed by several plan nodes and workers at once. It is not a per-server budget.
- WAL, commit flush, checkpoint, and heap-page writeback are different events. State the configured durability boundary.
- Vacuum, analyze, freezing, pruning, and table rewrites solve different problems. Find the retained physical state before choosing a repair.
- Transaction-ID age is a correctness limit. Long snapshots, prepared transactions, and replication slots can hold back cleanup and freezing.
- A hot tuple or invariant remains serialized even when the rest of the table has abundant capacity.

## References

- [PostgreSQL server architecture](https://www.postgresql.org/docs/current/tutorial-arch.html): Introduces the client/server process model and per-connection backend processes.
- [PostgreSQL query processing](https://www.postgresql.org/docs/current/query-path.html): Traces parsing, rewrite, planning, and execution.
- [PostgreSQL physical storage](https://www.postgresql.org/docs/current/storage.html): Index to file layout, TOAST, free-space maps, visibility maps, page layout, and HOT.
- [PostgreSQL database page layout](https://www.postgresql.org/docs/current/storage-page-layout.html): Defines page headers, item identifiers, heap tuple headers, and physical tuple layout.
- [PostgreSQL TOAST](https://www.postgresql.org/docs/current/storage-toast.html): Documents compression and out-of-line storage for oversized attributes.
- [PostgreSQL heap-only tuples](https://www.postgresql.org/docs/current/storage-hot.html): Defines HOT eligibility, chains, pruning, and index implications.
- [PostgreSQL index-only scans](https://www.postgresql.org/docs/current/indexes-index-only-scans.html): Explains covering values, heap visibility checks, and use of the visibility map.
- [PostgreSQL planner statistics](https://www.postgresql.org/docs/current/planner-stats.html): Documents sampled column and extended statistics.
- [PostgreSQL `EXPLAIN`](https://www.postgresql.org/docs/current/using-explain.html): Defines plan costs, actual execution evidence, buffers, loops, joins, and spills.
- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html): Documents snapshots, update conflicts, and Serializable Snapshot Isolation.
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html): Defines table, row, page, advisory locks, and deadlock behavior.
- [PostgreSQL write-ahead logging](https://www.postgresql.org/docs/current/wal-intro.html): States WAL ordering, commit durability, recovery, and group commit.
- [PostgreSQL WAL configuration](https://www.postgresql.org/docs/current/wal-configuration.html): Covers checkpoints, full-page images, recovery positions, and write pacing.
- [PostgreSQL routine vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html): Covers tuple reuse, visibility maps, statistics, autovacuum, freezing, and wraparound prevention.
- [PostgreSQL resource consumption](https://www.postgresql.org/docs/current/runtime-config-resource.html): Defines shared buffers, per-operation memory, maintenance memory, and related limits.
- [PostgreSQL monitoring statistics](https://www.postgresql.org/docs/current/monitoring-stats.html): Index to activity, relation, WAL, vacuum, replication, and I/O views for the current release.

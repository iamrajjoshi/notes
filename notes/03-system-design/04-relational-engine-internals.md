---
title: Relational Engine Internals and Online Schema Changes
description: Follow PostgreSQL and MySQL from connections through row versions, logs, cleanup, replication, and an online index build without confusing SQL syntax with the physical engine.
slug: relational-engine-internals
order: 4
identifier: SD4
duration: 2.5 hours
difficulty: Core
tags:
  - PostgreSQL
  - MySQL
  - InnoDB
  - MVCC
  - WAL
  - vacuum
  - replication
  - indexes
  - schema migration
---

## Working model

A relational database runs several coupled protocols behind one SQL statement: connection admission, concurrency control, crash recovery, replica catch-up, cleanup, and schema change. A design is safe only when each protocol has a capacity limit and observable state.

## Start where the schema note stopped

[SD3](03-storage-data-modeling.md) chose PostgreSQL for an order authority because constraints and transactions express the product invariants. It also chose a tenant-and-time B-tree for a bounded recent-orders query. Those logical choices do not explain what happens after an application opens 8,000 connections, leaves a transaction open for four hours, loses a primary, or adds the index to a busy table.

[DB4](../07-data-systems/04-transactions-concurrency-and-recovery.md) supplies the general transaction model. [DB5](../07-data-systems/05-postgresql-storage-query-and-mvcc-internals.md) through [DB7](../07-data-systems/07-mysql-and-innodb-internals.md) carry the PostgreSQL and MySQL paths further.

This note opens that engine boundary. PostgreSQL is the main worked path; MySQL with InnoDB appears as a comparison because similar SQL can hide different physical reads and maintenance work. Exact behavior depends on the engine version and configuration, so production changes should start with the linked documentation and measured state from the actual system.

## A connection owns a backend process

PostgreSQL uses a process-per-connection model. A supervisor accepts a client connection and creates a backend process for it; that backend parses, plans, and executes the client's statements. Backends coordinate through shared memory and synchronization primitives, while background processes handle work such as WAL writing, checkpointing, and vacuum. A connection is therefore not just a socket. It reserves a server execution context and may hold transaction state, locks, prepared statements, temporary objects, and per-operation memory.

A connection pool protects the database by admitting a bounded number of active backends. If 400 application instances each open 20 direct connections, the database sees up to 8,000 sessions even when most are idle. A pool capped at 200 database connections with 2,000 waiting application requests changes the failure from process and memory exhaustion into a visible admission queue. Set a pool wait deadline below the user deadline and measure active, idle, waiting, and transaction age separately.

Transaction pooling can reuse one database connection for different clients after each transaction, but session-scoped assumptions no longer reliably follow the client. Session variables, temporary tables, advisory locks, and prepared-statement behavior need an explicit compatibility check. A pool is a capacity boundary, not extra database capacity; if queries occupy every backend for longer, enlarging the pool can increase lock and I/O contention while making the queue less visible.

_Size the connection pool from measured database concurrency, not from application instance count._

```text
400 application instances * 20 direct connections = 8,000 backends
pool cap = 200 database connections
request deadline = pool wait + query + response
diagnostic split = active + idle + waiting + old transactions
```

## A commit makes a version durable, not a page current

PostgreSQL's multiversion concurrency control lets a statement read from a snapshot while concurrent transactions create newer row versions. An `UPDATE` normally creates a new tuple version and marks the old version as superseded rather than overwriting the visible contents in place. Snapshot rules decide which version a statement can see. Row-level locks still serialize conflicting writers, and higher isolation levels may reject a transaction whose observed history cannot be allowed.

Write-ahead logging separates transaction durability from data-page flushing. WAL records describing a change must reach durable storage before the corresponding changed table or index pages may be written. A commit can therefore acknowledge after its commit WAL is flushed even while dirty data pages remain in memory. After a crash, recovery replays logged changes that were not present in the data files. Group commit can let one WAL flush make several concurrent commits durable.

A checkpoint writes dirty buffers and records a recovery starting point; it is not the event that made each earlier transaction commit. Frequent checkpoints reduce the amount of WAL to replay but create more write pressure and more frequent full-page images. Infrequent checkpoints permit more recovery work and retain more WAL. Diagnose checkpoint trouble with checkpoint duration, buffers written, WAL generation rate, storage latency, and foreground p99 together rather than treating the interval as an isolated knob.

> **Durability boundary.** A successful synchronous commit means the configured WAL durability condition was met. It does not mean every changed heap and index page was already written to its final data file.

## Follow one update through snapshots, WAL, and vacuum

Transaction A begins at `REPEATABLE READ` and sees account 7 with balance 100. Transaction B updates the balance to 80. B obtains the required row lock, writes a new tuple version, updates indexes when needed, emits WAL records, and, under synchronous commit, commits after the configured WAL durability condition. A continues to see 100 because its transaction snapshot predates B's commit; a new transaction C sees 80. Both answers are correct under their snapshots.

Suppose the server crashes after B's commit WAL is durable but before the changed heap page reaches its data file. Recovery replays WAL and restores the committed version. The old version cannot be reclaimed while A might still need it. Once A ends and no relevant snapshot can see the old tuple, `VACUUM` can mark its space reusable and clean index entries. Standard `VACUUM` usually does not return that space to the operating system; it prepares it for later rows.

Now let A remain open for four hours while the row is updated 50,000 times. Vacuum cannot remove versions still protected by the old snapshot, table and index size grow, and queries do more buffer and visibility work. Check oldest transaction age, dead tuples, autovacuum progress, WAL retention, replication slots, and table growth before scheduling `VACUUM FULL`. `VACUUM FULL` rewrites the table, needs extra space, and takes an exclusive lock; ending the forgotten transaction and restoring routine vacuum progress is often the first repair.

_MVCC visibility and WAL durability answer different questions: who can see a version and whether it survives a crash._

```text
A snapshot: balance=100
B: UPDATE -> new tuple balance=80 -> WAL -> COMMIT
A still reads 100; new C reads 80
A ends -> old version becomes reclaimable -> VACUUM reuses space
```

## Vacuum, statistics, replicas, and promotion need separate plans

Routine `VACUUM` reclaims dead row versions for reuse, maintains the visibility map used by index-only scans, and freezes sufficiently old transaction IDs to prevent wraparound. `ANALYZE` samples data to update planner statistics. They solve related but distinct problems: a table can have little dead space and still get a poor plan from stale or low-detail statistics, or have accurate estimates while a long transaction prevents cleanup. Track table-specific update rate because one global autovacuum setting can react too slowly to a small, heavily updated table.

Physical streaming replication sends WAL to a standby, which replays the same physical changes and can serve read-only hot-standby queries. Asynchronous replication allows the primary to acknowledge before the standby confirms receipt, so promotion can lose the latest acknowledged transactions within the actual lag window. Synchronous settings can make commit wait for a standby-defined stage, trading write latency and standby availability for a smaller loss window. Read replicas are also stale by the replay delay, so read-after-write routing needs a primary read, an observed replay position, or a product-visible staleness rule.

Promotion is only half a failover. The old primary must be fenced from writes, clients must discover the new writer, replication must be rebuilt around the new timeline, and the team must decide whether any transactions exist only on the old node. A replica is not a backup: an accidental `DELETE` and many corrupting changes replicate. Keep independent backups plus retained WAL, and test a restore to the stated recovery point and recovery time.

## Calculate catch-up from net replay rate

Assume a primary generates 10 MB of WAL each second. A standby is disconnected for 90 seconds, so it accumulates about 900 MB of lag before protocol overhead or rate variation. When it reconnects, it can receive and replay 40 MB each second while the primary continues generating 10 MB each second. Net catch-up is 30 MB each second, so the ideal recovery time is about 30 seconds. If replay falls to 12 MB each second because storage is saturated, net catch-up is only 2 MB each second and the same lag takes about 450 seconds.

Do not promote solely because a time-based lag graph looks small. Compare the last received, flushed, and replayed WAL positions and decide the permitted RPO. If the primary accepted a transaction at a position the candidate never received, promotion cannot invent it. During planned failover, stop or fence writes, wait for the candidate to reach the required position, promote it, update routing, and reject the old primary until it is rebuilt or proven safe to rejoin.

_Replay must outrun new WAL generation or a standby never catches up._

```text
lag = 10 MB/s * 90 s = 900 MB
net catch-up = 40 MB/s replay - 10 MB/s new WAL = 30 MB/s
ideal catch-up = 900 / 30 = 30 s
at 12 MB/s replay: 900 / (12 - 10) = 450 s
```

## Similar SQL does not imply the same storage path

MySQL handles each client connection with a server thread under its default one-thread-per-connection model, while configuration and editions can provide other thread handling. InnoDB stores table rows in the clustered primary-key B-tree. A secondary index entry contains the secondary key plus the primary-key value, so fetching non-covered columns through a secondary index normally requires a second lookup in the clustered index. PostgreSQL usually stores table tuples in a heap and keeps tuple locations in separate indexes; an index scan checks tuple visibility in the heap unless an index-only scan can trust the visibility map. The same logical index definition can therefore have different read amplification and primary-key costs.

InnoDB implements multiversion reads with undo records and read views. Old versions remain available through undo while transactions might need them, and purge removes obsolete history later. Its redo log records changes used for crash recovery. The MySQL binary log is a separate server-level change log used for replication and point-in-time recovery and is a common CDC input. PostgreSQL physical WAL, logical decoding, InnoDB redo, and the MySQL binary log should not be treated as interchangeable merely because each is called a log.

A useful interview contrast begins with the access path and operating constraints. A wide random primary key is copied into every InnoDB secondary index and can fragment clustered insertion; in PostgreSQL it affects the primary index but does not define heap row order. A long-running snapshot can delay cleanup in either engine, though the retained structures and operator signals differ. Ask which engine and version is in scope before giving index, isolation, vacuum, purge, or failover advice.

- PostgreSQL: heap tuples, separate indexes, MVCC cleanup by vacuum
- InnoDB: clustered primary-key rows, secondary entries carry the primary key, old versions in undo
- PostgreSQL WAL and InnoDB redo protect crash recovery; PostgreSQL logical decoding and MySQL binlog expose logical changes
- Query plans depend on engine statistics, distribution, cache state, and the columns the query must fetch

## Creating an index concurrently is a state machine

A regular PostgreSQL `CREATE INDEX` takes a `SHARE` lock on the table, permits reads, and blocks inserts, updates, and deletes until one table scan finishes building the index. That is simple and relatively fast, but an index build lasting several minutes can become several minutes without application writes.

`CREATE INDEX CONCURRENTLY` uses a weaker `ShareUpdateExclusiveLock`, so ordinary reads and writes may continue. “Concurrently” does not mean lock-free, instant, or free of production impact. The command performs two table scans, spans several transactions, waits for transactions and snapshots at multiple barriers, blocks conflicting schema changes, and adds CPU, I/O, cache, WAL, and replica-replay work while it runs.

Two booleans in `pg_index` expose the protocol's states:

- **Catalog only: `indisready=false`, `indisvalid=false`.** The entry exists, but DML does not maintain the index and the planner cannot use it.
- **Maintained but hidden: `indisready=true`, `indisvalid=false`.** New DML maintains the index, but the planner still cannot use it because validation is incomplete.
- **Ready for use: `indisready=true`, `indisvalid=true`.** DML maintains the index and the planner may use it.

The transition works roughly like this:

1. PostgreSQL creates an invalid catalog entry with both flags false and commits it so other transactions can learn that the index exists.
2. It waits for older transactions that could modify the table without knowing about the new index. This also protects heap-only tuple, or HOT, update chains from crossing the change in index membership rules.
3. The first scan reads one MVCC snapshot and builds entries for the heap tuples visible in that snapshot. Writes that occur while `indisready` is false do not maintain the new index.
4. PostgreSQL marks `indisready=true`, commits, and waits for transactions that began under the earlier rule to finish. From this point onward, new inserts and updates maintain the index even though queries cannot use it yet.
5. A second scan validates the index. It compares the heap with the index and inserts tuples missed during the first scan. Writes happening now are already covered by normal DML index maintenance.
6. It waits for snapshots old enough to observe a row set that the new index could not answer correctly, then marks `indisvalid=true`. New query plans may now use the index.

Both scans are necessary. A row committed before the first snapshot is found by the first scan. A row written while the first scan runs is found during validation, while a row written after `indisready` becomes true is inserted by the writing transaction itself. The wait barriers close the gaps between those sets.

> **Implementation detail.** PostgreSQL can wait for a transaction without polling its rows. Each backend holds an exclusive lock on its own virtual transaction ID. A concurrent index phase requests a conflicting share lock for the virtual transaction IDs it must drain; that request becomes grantable when the older transaction ends. A build that appears idle may therefore be waiting on transaction boundaries rather than scanning blocks.

The middle state has an operationally surprising consequence. For a unique index, uniqueness enforcement begins before the index becomes valid for query plans. Another statement can receive a uniqueness violation while the index is still unavailable for reads. If validation finds genuine duplicates, the build fails and leaves an invalid index behind. PostgreSQL ignores that index for query planning, but it can continue consuming write-maintenance work; an invalid unique index can also continue enforcing uniqueness.

## Inspect the migration instead of guessing

The client command can sit quietly while the server scans, waits for older lockers, or waits for snapshots. Query the catalog and progress view before deciding that the build has stalled:

```sql
SELECT indexrelid::regclass, indisready, indisvalid
FROM pg_index
WHERE indexrelid = 'public.events_tenant_time_id'::regclass;

SELECT pid, phase, lockers_total, lockers_done,
       blocks_total, blocks_done, tuples_total, tuples_done
FROM pg_stat_progress_create_index;
```

The usual recovery is to drop the invalid index and retry, or use the documented concurrent `REINDEX` path when appropriate. Also remember the command's boundaries: it cannot run inside an explicit transaction block; only one concurrent index build may run on a table at a time; and PostgreSQL does not build a partitioned parent index concurrently. For a partitioned table, build indexes concurrently on the leaf partitions and attach them to the parent index using the documented sequence.

Before running the migration, inspect old transactions and snapshots, estimate both table scans, reserve I/O and WAL headroom, watch replica lag, and decide how an invalid artifact will be detected and removed. The command protects write availability, not workload latency or operator attention.

## Continuing worked case: relational engine and schema migration

The PostgreSQL authority gets a bounded primary pool rather than one connection budget per application instance. If the representative create transaction occupies a backend for 20 ms at the 5,000-per-second peak, Little's Law predicts about 100 concurrent create transactions. The first pool cap is 200 primary connections, leaving room for status transitions, read-your-write requests, and variance without admitting thousands of backends. Ordinary reads use separately capped replica pools; pool wait must expire inside the API's one-second deadline and appears as its own metric.

Create and status commits use PostgreSQL's configured synchronous-commit durability boundary. MVCC lets readers keep a snapshot while writers create newer versions, and WAL makes acknowledged changes recoverable before every table page reaches its final file. The service alerts on old transactions, dead-tuple growth, autovacuum delay, WAL generation, and received-versus-replayed replica position instead of treating “database CPU” as the diagnosis.

A later support requirement adds tenant-and-status history. The migration runs `CREATE INDEX CONCURRENTLY orders_tenant_status_created ON orders (tenant_id, status, created_at DESC, id DESC)`. Before starting, the operator checks old snapshots and storage headroom. During both scans, the release gate watches `pg_stat_progress_create_index`, `pg_index.indisready`, `pg_index.indisvalid`, foreground p99, WAL rate, and replica lag. A failed build leaves an explicit cleanup task; deployment does not assume the invalid index vanished.

## Summary

A SQL statement enters a running storage engine with finite connection, memory, I/O, cleanup, and replication capacity. PostgreSQL and MySQL/InnoDB expose related relational features, but their physical storage and change logs create different read paths and operator signals.

- **Pool for measured concurrency.** PostgreSQL normally gives each connection a backend process. Bound active work, keep pool wait inside the request deadline, and inspect old transactions before raising connection limits.
- **Separate visibility from durability.** MVCC snapshots decide which tuple version a reader sees; WAL and its configured flush point decide which committed work survives a crash. A checkpoint moves dirty pages and bounds replay work rather than creating commit durability.
- **Treat vacuum and statistics independently.** Vacuum makes obsolete tuple space reusable and maintains visibility metadata, while analyze updates estimates. One can be healthy while the other causes poor queries.
- **Calculate replica recovery from net rate.** Replay must exceed ongoing WAL generation. Promotion also needs an RPO decision, writer fencing, routing, and independent backups.
- **Name the engine before describing an index.** PostgreSQL heap indexes point toward tuple locations. InnoDB secondary indexes carry the clustered primary key, and its old versions live in undo until purge can remove them.
- **Run concurrent index creation as a migration protocol.** Two scans and several transaction barriers move the index from catalog-only to write-maintained and finally planner-valid. Monitor catalog flags, progress phases, old snapshots, replica lag, and invalid leftovers.

## References

- [PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL Internals: How Connections Are Established](https://www.postgresql.org/docs/current/connect-estab.html): Describes the supervisor and process-per-connection backend model.
- [PostgreSQL: Write-Ahead Logging](https://www.postgresql.org/docs/current/wal-intro.html): Explains the WAL-before-data rule, commit durability, crash replay, and group commit.
- [PostgreSQL: Routine Vacuuming](https://www.postgresql.org/docs/current/routine-vacuuming.html): Covers dead-version reuse, statistics, visibility maps, autovacuum, and transaction ID freezing.
- [PostgreSQL: Log-Shipping Standby Servers](https://www.postgresql.org/docs/current/warm-standby.html): Covers streaming replication, hot standby, synchronous modes, replication lag, and failover.
- [PostgreSQL: Building indexes concurrently](https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY): Documents the two scans, transaction and snapshot waits, invalid-index behavior, unique-index caveats, and command restrictions.
- [PostgreSQL: `pg_index`](https://www.postgresql.org/docs/current/catalog-pg-index.html): Defines `indisready`, `indisvalid`, and the other catalog state used during an index build.
- [PostgreSQL: Progress reporting for `CREATE INDEX`](https://www.postgresql.org/docs/current/progress-reporting.html#CREATE-INDEX-PROGRESS-REPORTING): Lists observable build and wait phases in `pg_stat_progress_create_index`.
- [Seiji Chew: How PostgreSQL Builds Indexes Without Blocking Writes](https://schew2381.github.io/posts/how-postgres-concurrent-index-creation-works/): A source-guided trace of catalog transitions, virtual transaction ID waits, validation, and the unique-index edge case.
- [MySQL 8.4: InnoDB Multi-Versioning](https://dev.mysql.com/doc/refman/8.4/en/innodb-multi-versioning.html): Describes undo records, read views, and purge for InnoDB consistent reads.
- [MySQL 8.4: Connection Interfaces](https://dev.mysql.com/doc/refman/8.4/en/connection-interfaces.html): Documents connection-manager threads, the default dedicated client thread model, thread caching, and connection limits.
- [MySQL 8.4: InnoDB Clustered and Secondary Indexes](https://dev.mysql.com/doc/refman/8.4/en/innodb-index-types.html): Defines clustered primary-key storage and secondary entries that carry the primary key.
- [MySQL 8.4: InnoDB Redo Log](https://dev.mysql.com/doc/refman/8.4/en/innodb-redo-log.html)
- [MySQL 8.4: The Binary Log](https://dev.mysql.com/doc/refman/8.4/en/binary-log.html): Documents the server change log used for replication and point-in-time recovery.

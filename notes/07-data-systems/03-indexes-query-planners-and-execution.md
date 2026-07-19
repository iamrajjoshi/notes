---
title: Indexes, Query Planners, and Execution
description: Follow a query from parsed expression to access path, join, sort, memory use, and measured execution without treating an index name as a performance explanation.
slug: indexes-query-planners-and-execution
order: 3
identifier: DB3
duration: 3 hours
difficulty: Core
tags:
  - indexes
  - query planner
  - query execution
  - statistics
  - B-tree
  - joins
  - EXPLAIN
---

## Working model

A query plan is a costed program over stored data. The optimizer chooses among imperfect estimates; the executor discovers the actual rows, pages, memory, and waits.

## Follow the query through distinct stages

A SQL query does not jump from text to an index. PostgreSQL's documented path separates parsing, rewriting, planning, and execution. Parsing checks syntax and resolves names and types into an internal tree. Rewriting applies rules and expands views. Planning creates candidate access and join paths, estimates their row counts and costs, and selects one plan. Execution pulls rows through that plan's operators until the consumer stops or the plan finishes.

Other databases use different names and planner algorithms, but the separation remains useful. MongoDB maps a query shape to candidate plans and may cache a winner. ClickHouse builds a query pipeline that reads selected column ranges and runs filters and aggregation in parallel. DynamoDB exposes less planning because the client chooses `GetItem`, `Query`, or `Scan` and supplies table or index keys. The amount of planning hidden by the service does not remove the access path.

For every slow query, separate four questions:

1. Did the query express the intended predicate, order, and bound?
2. Did a suitable physical structure exist?
3. Did the planner estimate the alternatives well enough to choose it?
4. Did execution encounter the rows, cache state, I/O, memory, locks, or concurrency expected by that estimate?

Changing an index before answering those questions can trade one unexplained plan for another.

## B-tree indexes serve ordered comparisons

A B-tree keeps keys in sorted order across a shallow tree of pages. Internal pages direct a search toward a child range; leaf pages hold entries in key order. Equality finds a position, a range walks adjacent leaf entries, and an ordered query can sometimes avoid a separate sort. Inserts and deletes maintain that order through page changes, splits, merges or deletion cleanup, and log records.

The stored payload depends on the engine. A PostgreSQL heap B-tree entry normally points to a table tuple identifier. An InnoDB secondary entry includes the secondary fields and the clustered primary-key value. SQLite table B-trees can hold row data at the leaves. These layouts change the cost after the index finds a candidate.

Assume an internal B-tree page can hold 300 child separators. Three internal levels can address roughly `300³`, or 27 million, leaf-page ranges before accounting for occupancy and implementation details. The point is not the exact fan-out; it is that tree height grows slowly. A query that returns 2 million scattered rows can still be slow because the expensive work occurs after the initial seek.

```text
seek cost          = internal pages + first leaf page
range cost         = matching leaf pages + candidate record fetches
post-filter cost   = candidates rejected after lookup
output cost        = returned columns + sort/aggregate + network bytes
```

“B-tree lookup is logarithmic” describes the seek. It does not price the scan, table fetches, visibility checks, cache misses, or result transfer.

## Composite indexes obey their stored order

Consider an index on `(tenant_id, status, created_at DESC, id DESC)`. It groups entries by tenant, then status within a tenant, then time and ID within that pair. A query with equality on tenant and status plus a time boundary can seek to a narrow prefix and walk in result order:

```sql
SELECT id, created_at, assignee_id
FROM conversations
WHERE tenant_id = $1
  AND status = 'open'
  AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC
LIMIT 100;
```

Removing the status predicate leaves several status groups between the entries the query needs. Depending on the engine and available skip-scan behavior, the planner may scan more index ranges, combine another index, or prefer another plan. Filtering only by `created_at` ignores the leading tenant and status order for a global time query. The index is not a set of four independent indexes.

The common equality, sort, range guideline is a useful first draft for document and relational compound indexes, but it is not a law. A highly selective range can deserve an earlier position; several independent query shapes may need separate indexes; skip-scan support changes some cases; write cost may rule out another structure. Verify with representative values and data distribution.

Cursor pagination uses the stored order directly. An offset must count and discard earlier results, and concurrent inserts can shift positions. A cursor such as `(created_at, id)` identifies a boundary in the ordered value space. Include a unique tie-breaker so two rows with the same timestamp do not move unpredictably between pages.

## Covering changes which pages must be read

An index covers a query when it contains enough values to answer without fetching the base record, subject to the engine's visibility rules. Covering can remove scattered record reads, but it enlarges the index and charges writes for every included value.

PostgreSQL supports `INCLUDE` columns that appear as non-key payload. An index-only scan also depends on the visibility map: if a heap page is not known to contain only tuples visible to all transactions, the executor still checks the heap. InnoDB secondary entries already carry the primary key; selecting other indexed fields can be covered, while an unindexed column requires a clustered-primary lookup. A MongoDB query can be covered when predicates and returned fields fit an index and the documented conditions are met.

Suppose a query returns 100 conversations. The index path touches 8 index pages. If each candidate needs a different uncached table page, the read can need roughly 108 page accesses; adding two small projected values to the index might reduce that toward 8. If the table pages are already hot or candidates cluster on a few pages, the saved work is smaller. The decision needs actual buffer and I/O evidence.

## Specialized indexes encode different search problems

B-trees are not the answer to every predicate:

- A hash index maps equality keys into buckets and does not provide ordered ranges.
- A PostgreSQL Generalized Inverted Index (GIN) inverts composite values into searchable keys, fitting arrays and full-text tokens at a higher write and maintenance cost.
- Generalized Search Tree (GiST) and space-partitioned GiST (SP-GiST) indexes provide frameworks for spatial, range, nearest-neighbor, and partitioned search structures whose operator classes define their behavior.
- A Block Range Index (BRIN) summarizes ranges of table blocks. It stays small and works well when values correlate with physical order; it can return many candidate block ranges that need rechecking.
- MongoDB multikey indexes represent array elements and can produce several entries for one document. Compound multikey restrictions follow from avoiding ambiguous products of multiple arrays.
- ClickHouse's sparse primary index stores marks for granules in physical sort order. Data-skipping indexes summarize blocks so a predicate can avoid some granules; neither structure is a unique per-row B-tree.
- Search engines use inverted indexes to map terms to document postings, then apply scoring, filtering, and segment-level work.

An index type is a promise about supported operators and pruning. State the operator, false-positive or recheck behavior, update cost, and failure mode instead of saying that an index “supports the field.”

## Partial and expression indexes narrow maintained state

A partial index stores only records satisfying a predicate. If nearly all reads target open conversations while closed history dominates the table, a PostgreSQL partial index can avoid maintaining closed entries:

```sql
CREATE INDEX conversations_open_tenant_time
ON conversations (tenant_id, created_at DESC, id DESC)
WHERE status = 'open';
```

The query predicate must imply the index predicate in a way the planner can establish. Parameterized or logically equivalent expressions are not always recognized as expected. An expression index stores a computed key such as `lower(email)`; queries must use a matching expression, and every affected write computes and maintains it.

These structures make a targeted path cheaper by refusing to solve other paths. Document the queries that depend on them and the fallback during creation, invalidation, or removal.

## Cardinality estimates decide plan shape

The planner cannot execute every candidate plan before choosing. It estimates base table size, predicate selectivity, join cardinality, memory and I/O work, then compares cost models. A small row-count error near a leaf operator can multiply through joins and change the chosen order or algorithm.

Common statistics include:

- approximate row and page counts;
- number of distinct values;
- most common values and their frequencies;
- histograms for the remaining distribution;
- null fractions and average widths;
- extended statistics for dependency, joint distinct counts, or common combinations across columns.

Single-column statistics miss correlation. Suppose every enterprise tenant uses `plan='enterprise'`. Estimating `tenant_id = 42` and `plan = 'enterprise'` as independent predicates multiplies two selectivities even though the second predicate removes nothing after the first. PostgreSQL extended statistics can describe dependencies or joint distributions; MySQL histograms improve estimates for non-indexed columns; other engines collect different summaries.

Statistics are sampled and age as data changes. An event table that receives one new date every day can have a value beyond the latest histogram. A new hot tenant can invalidate a uniformity assumption. Increasing a statistics target costs analysis time and catalog space and only helps if the statistic represents the missing distribution.

Compare estimated rows with actual rows at each plan node. The first large divergence is often more useful than the slowest operator because it explains why later choices were made under a false input.

## Scan operators expose different I/O patterns

A sequential scan reads the table's pages and tests each record. It can beat an index when the table is small, the predicate returns much of it, pages are contiguous or cached, or random record fetches dominate. Seeing a sequential scan is not proof that the optimizer failed.

An index scan follows ordered entries and fetches records as needed. An index-only scan tries to answer from the index. PostgreSQL can combine bitmap index results, then visit matching heap pages in page order; this is useful when a predicate returns more rows than a narrow index scan but far fewer than the whole table. ClickHouse selects parts and granules, reads only requested columns, and applies pipeline operators rather than fetching heap rows.

For each scan, record:

```text
rows examined
rows returned
index or granule entries examined
base pages or column bytes read
cache hits versus storage reads
rows removed by filter or recheck
time waiting for locks, I/O, CPU, and client consumption
```

Elapsed time without this shape cannot distinguish a poor access path from cold storage or a blocked lock.

## Join algorithms pay different setup and repetition costs

A nested-loop join reads an outer input and finds matching inner rows for each outer row. It works well when the outer side is small and the inner lookup is indexed or already materialized. If an estimate says 10 outer rows and execution finds 1 million, the repeated inner work becomes disastrous.

A hash join builds an in-memory hash table for one input and probes it with the other. It fits equality joins when the build side fits the memory budget. If it spills into batches, temporary I/O enters the path. A merge join consumes two inputs ordered by the join keys; existing index order may help, while otherwise sorts add setup work. Merge joins can handle some ordered and inequality behaviors that a hash join cannot.

The algorithm name alone is insufficient. Record input rows, loops, memory, batches, spill bytes, ordering source, and output cardinality. A join that returns ten rows after combining two million-row inputs may indicate a missing early predicate or unavoidable many-to-many work.

## Sorts and aggregates can cross a memory boundary

Sorting ten thousand narrow keys in memory differs from sorting fifty million wide rows to temporary files. Hash aggregation similarly builds groups until memory policy or group cardinality forces partitioning or spill. Parallel workers can multiply per-node memory; a configuration value that looks safe for one operator can overcommit a host when several queries and workers run together.

Push filters and projections down when semantics permit. Return only needed columns, but do not assume that a common table expression, view, or client abstraction automatically prevents pushdown. Read the actual plan.

Top-N algorithms can avoid fully sorting all matching rows when the query requests a small limit. An index already ordered by the required keys can avoid the sort, though fetching extra projected columns may still dominate. Test with the real limit and predicate values.

## Cached plans can hide parameter skew

A prepared statement separates query structure from parameter values. PostgreSQL may choose a custom plan using current values or a reusable generic plan that ignores them. The generic plan saves planning time, but one plan may not fit both a tenant with 20 rows and a tenant with 200 million rows. MongoDB caches by query shape under its current planning rules; a cached winner can face a changed distribution or index set.

Do not fix parameter skew by forcing one global index hint as the first response. Capture the slow parameter class, compare custom and cached plans, inspect row estimates, and decide whether the workload needs updated statistics, a query split, a plan policy, partition isolation, or a different access path.

## Read `EXPLAIN` as a tree of evidence

`EXPLAIN` shows estimates without executing in its basic form. `EXPLAIN ANALYZE` executes the query in PostgreSQL, so a mutating statement changes data unless wrapped and rolled back. Buffer, WAL, timing, and serialization options add evidence. MySQL and MongoDB expose their own explain formats and execution statistics.

Read from the leaves upward:

1. What access path produced rows?
2. How many rows did the planner estimate and execution observe?
3. How many times did the node loop?
4. Which predicates became index conditions, filters, or rechecks?
5. Which table pages, blocks, temporary bytes, or column granules were read?
6. Where did sorting, hashing, aggregation, or network exchange occur?
7. Did the client consume all rows, or did a limit stop the pipeline early?

“Execution time” can exclude client rendering and network transfer. A database process can also wait while the client reads slowly. Combine plan evidence with statement latency, lock waits, I/O latency, cache state, CPU, and connection-pool time.

## Indexes charge every mutation and migration

Each index adds entries during insert, changes during indexed updates, cleanup after deletes, WAL or redo volume, cache residency, backup size, and replica replay. Some engines defer parts of this work, but the bill remains as compaction, vacuum, merge, or asynchronous index maintenance.

Building an index reads existing data and writes a new structure while production traffic continues or pauses under the engine's locking protocol. PostgreSQL `CREATE INDEX CONCURRENTLY` uses multiple scans and transaction barriers and can leave an invalid index after failure. MongoDB index builds have their own phases and resource controls. DynamoDB GSI creation backfills existing items and ongoing base writes must also update the index; an index hot partition can throttle the base write path.

Before an online build, estimate source bytes, scan rate, output bytes, log generation, replica apply capacity, temporary space, and the age of transactions or snapshots that can delay completion. Define how to detect and remove an incomplete artifact.

## Worked case: fix a tenant history query

A table contains 1.2 billion conversation events. The query asks for the newest 100 unresolved events for one tenant:

```sql
SELECT id, conversation_id, created_at, payload_type
FROM conversation_events
WHERE tenant_id = $1
  AND resolved_at IS NULL
  AND created_at < $2
ORDER BY created_at DESC, id DESC
LIMIT 100;
```

The existing index is `(created_at DESC)`. It provides global time order but cannot seek to one tenant. For an ordinary tenant, the executor scans 45,000 recent global entries before finding 100 matches. A large tenant happens to match quickly, so a test using only that tenant looked healthy.

A partial index on `(tenant_id, created_at DESC, id DESC) WHERE resolved_at IS NULL` matches the common path. It stores only unresolved events and supports the tenant equality plus ordered cursor. Including `conversation_id` and `payload_type` could make more executions index-only, but those fields enlarge every open-event entry. The team first builds the narrow index and measures heap fetches.

Before the change, the plan estimates 120 matching rows but examines 45,000 index entries and fetches 3,400 heap pages. After representative statistics and the new index, the plan examines roughly the returned range. If the partial predicate later covers 80% of the table because resolution stops, the structure loses much of its size advantage; monitoring open-row fraction and index bytes makes that change visible.

The fix is not “add an index.” It is: align stored order with tenant and cursor, exclude rows the path never returns, validate distribution across tenant classes, measure base-page fetches, and retain a condition for revisiting the choice.

## Summary

An index provides an ordered or specialized mapping, while a query planner decides whether its estimated work beats other plans. Execution can invalidate those estimates through skew, cache state, loops, spills, locks, or different parameter values.

- Price the seek, scanned index entries, record fetches, post-filter work, sort or aggregate, and returned bytes separately.
- Composite indexes follow stored column order. Equality prefixes, ordered ranges, and stable cursor tie-breakers determine the useful path.
- Covering can remove base-record reads but enlarges the maintained structure; engine visibility rules can still require table access.
- Specialized indexes encode operators and pruning rules. False positives, rechecks, update cost, and physical correlation remain part of the path.
- Statistics drive row estimates and join order. Compare estimated and actual rows at each node, especially where correlated columns or hot tenants break independence.
- Sequential, index, bitmap, and columnar scans serve different result fractions and storage layouts.
- Nested-loop, hash, and merge joins trade repeated lookups, build memory, ordering, and spill behavior.
- Cached plans can fail on parameter skew. Inspect the actual parameter class before forcing one plan for every tenant.
- Online index creation is a data migration with scans, logs, locks or barriers, replica work, failure artifacts, and cleanup.

## References

- [PostgreSQL query path](https://www.postgresql.org/docs/current/query-path.html): Describes parsing, rewriting, planning, and execution.
- [PostgreSQL indexes](https://www.postgresql.org/docs/current/indexes.html): Covers B-tree, hash, GiST, SP-GiST, GIN, BRIN, multicolumn, partial, expression, and index-only behavior.
- [PostgreSQL planner statistics](https://www.postgresql.org/docs/current/planner-stats.html): Defines sampled column statistics and extended statistics used for row estimates.
- [PostgreSQL `EXPLAIN`](https://www.postgresql.org/docs/current/using-explain.html): Documents scan, join, sort, aggregation, cost, actual-row, loop, and buffer evidence.
- [PostgreSQL plan cache mode](https://www.postgresql.org/docs/current/runtime-config-query.html#RUNTIME-CONFIG-QUERY-OTHER): Distinguishes custom and generic prepared-statement plans.
- [MySQL 8.4 optimization and indexes](https://dev.mysql.com/doc/refman/8.4/en/optimization-indexes.html): Documents index access, multicolumn order, statistics, covering, generated columns, and verification.
- [MySQL 8.4 `EXPLAIN` output](https://dev.mysql.com/doc/refman/8.4/en/explain-output.html): Defines access types, chosen indexes, estimated rows, filtering, temporary work, and covering output.
- [MongoDB compound indexes](https://www.mongodb.com/docs/manual/core/indexes/index-types/index-compound/): Documents field order and the equality, sort, range guideline.
- [MongoDB query plans](https://www.mongodb.com/docs/manual/core/query-plans/): Describes candidate selection, the plan cache, query shapes, and current cost-based fallback behavior.
- [ClickHouse primary indexes](https://clickhouse.com/docs/primary-indexes): Explains sparse marks, granules, physical ordering, and range pruning.
- [DynamoDB global secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html): Defines independent index keys, projections, consistency, capacity, backfill, and base-write throttling.

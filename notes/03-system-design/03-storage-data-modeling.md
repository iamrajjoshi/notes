---
title: Choose Storage from Access Patterns
shortTitle: Storage and data modeling
description: Turn product operations into a data model, select a storage family from its access paths and invariants, and design transactional and analytic projections for their real queries.
collection: system-design
slug: storage-data-modeling
order: 3
number: SD3
duration: 2 hours
difficulty: Core
tags:
  - data model
  - PostgreSQL
  - ClickHouse
  - indexes
  - transactions
  - SQL
  - columnar
  - search
  - projections
---

## Working model

A database is a set of paid access paths. The primary key buys one path; each index buys another by charging every write, consuming storage, and adding a consistency obligation.

## Questions this note answers

- Define durable state, authority, row, primary key, secondary index, transaction, and projection
- Turn operations into an access-pattern table before choosing a database
- Turn an orders-and-line-items model into relational constraints, indexes, and physical reads
- Choose a storage model by query, update, transaction, and retention behavior
- Order composite index columns for equality, range, and sort predicates while accounting for each index's write and maintenance cost
- Trace a cursor-paginated feed through its ordered index
- Explain how ClickHouse column files, sorted parts, sparse marks, and background merges serve analytic scans
- Keep object bytes, search indexes, and transactional metadata in suitable stores

## Learn the storage nouns before choosing a product

Persistent storage keeps data beyond one application process and, under its stated durability contract, beyond a crash. A database adds ways to identify, update, constrain, and query that state. The application still has to decide which copy is authoritative and what an acknowledged write promises.

| Term            | Meaning                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------- |
| Entity          | A product concept such as an order, user, or upload                                                           |
| Row or document | One stored representation of an entity or aggregate                                                           |
| Primary key     | The stable value that identifies one record in its table or collection                                        |
| Secondary index | An extra ordered or lookup structure that finds records by another field                                      |
| Transaction     | A group of reads and writes with declared all-or-nothing commit behavior and rules for concurrent observation |
| Constraint      | A rule the database enforces, such as uniqueness or a valid reference                                         |
| Authority       | The copy whose accepted state decides the product truth                                                       |
| Projection      | A derived copy shaped for another read path, such as search or analytics, which can lag and be rebuilt        |

PostgreSQL and MySQL are relational databases: they organize rows into tables, support SQL queries, constraints, indexes, and transactions, though their physical storage paths differ. Cassandra is a distributed wide-column database designed around partition-key lookups and bounded ordered ranges. ClickHouse is a columnar analytic database built to scan and aggregate selected columns across many rows. Object storage holds large byte objects by key; a search engine builds an inverted index that maps terms to the documents containing them for text and ranked retrieval. These products overlap at the edges, but they charge for different work.

Start with one authoritative store when it can serve the contract. Adding a search index, cache, event log, or analytic projection creates a second lifecycle: capture, lag, failure, rebuild, deletion, access control, and cost. Add that copy only after a named read or operating requirement justifies it.

## Inventory reads and writes before tables

For each operation, record the lookup key, filters, sort order, result size, update frequency, and required consistency. A schema that cannot answer the top query without a scan has already failed, even if its entity diagram looks tidy.

- Relational storage when joins, constraints, and multi-row transactions carry business meaning
- Key-value storage for known-key access with predictable latency
- Document storage when an aggregate changes and loads as one unit
- Wide-column storage for large ordered ranges within a partition key
- Object storage for large immutable bytes; search storage for ranked text and inverted indexes

## Write an access-pattern table

Give every operation a row. Record expected peak rate, lookup fields, ordering, maximum result count, mutation scope, acceptable staleness, and retention. Then mark the correctness rule that survives a crash or concurrent update. 'Get account by ID' and 'list a tenant's newest 100 events' look like reads, but they require different physical paths: one point lookup and one ordered range inside a tenant boundary.

Use the table to reject unsuitable layouts. A store that answers point reads well but scans every partition for the feed does not fit the main read. A document that loads an entire unbounded comment history turns one popular item into a growing read and write unit. A relational model may remain the simplest choice when uniqueness, foreign references, and multi-row state changes matter more than avoiding a join.

- Lookup: equality fields, range fields, sort direction, and result bound
- Mutation: rows or aggregates changed together and the conflict rule
- Freshness: read-your-writes, bounded lag, or eventual convergence
- Lifecycle: retention, deletion proof, backup, and projection rebuild source

For an order service, the first draft can remain concrete and small:

| Operation          | Lookup and order                                      | State changed                                            | Correctness need                                                    |
| ------------------ | ----------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| Create order       | Idempotency key                                       | Order, line items, operation result, notification intent | One order per operation ID; rows and intent commit together         |
| Get order          | Tenant ID plus order ID                               | None                                                     | Caller sees only its tenant's order; read-your-write after creation |
| List recent orders | Tenant ID, then creation time and order ID descending | None                                                     | Stable pages of at most 100 rows                                    |
| Advance status     | Order ID plus expected current version                | Status and outbox event                                  | Reject an invalid or concurrent state transition                    |

That table suggests an `orders` primary key, a uniqueness path for the idempotency key, and an index beginning with tenant plus time for the recent-order query. It also exposes an invariant that a best-effort cache cannot own. Only after writing those paths should the design compare engines.

## Trace an order model from product nouns to access paths

An order contains one order header and one or more purchased items. That is the logical model: `Order 817` belongs to tenant 42 and contains lines 1, 2, and 3. The physical relational model stores the header once in `orders` and each repeated item in `order_line_items`. Keeping the repeating lines in their own table is normalization; it avoids copying order status, customer, creation time, and currency into every item row.

Some duplication is intentional. `unit_price_minor` and `product_name_at_purchase` capture what the buyer saw, rather than joining to a product row that may change next week. `total_minor` lets the recent-orders query avoid summing all lines, but the service must compute it from the same line values inside the order-creation transaction. A normal `CHECK` constraint cannot compare one order row with an arbitrary set of line rows.

Assume a `tenants` table with primary key `id` already exists. This PostgreSQL DDL makes the remaining boundaries visible:

```sql
CREATE TABLE orders (
  tenant_id       bigint      NOT NULL REFERENCES tenants (id),
  id              bigint      GENERATED ALWAYS AS IDENTITY,
  idempotency_key text        NOT NULL,
  customer_id     bigint      NOT NULL,
  status          text        NOT NULL
                              CHECK (status IN ('pending', 'paid', 'cancelled')),
  currency        text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor     bigint      NOT NULL CHECK (total_minor >= 0),
  version         bigint      NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, idempotency_key)
);

CREATE TABLE order_line_items (
  tenant_id                bigint   NOT NULL,
  order_id                 bigint   NOT NULL,
  line_number              integer  NOT NULL CHECK (line_number > 0),
  product_id               bigint   NOT NULL,
  product_name_at_purchase text     NOT NULL,
  quantity                 integer  NOT NULL CHECK (quantity > 0),
  unit_price_minor         bigint   NOT NULL CHECK (unit_price_minor >= 0),
  PRIMARY KEY (tenant_id, order_id, line_number),
  FOREIGN KEY (tenant_id, order_id)
    REFERENCES orders (tenant_id, id)
);

CREATE INDEX orders_tenant_created_id
ON orders (tenant_id, created_at DESC, id DESC);
```

The composite foreign key prevents a line for tenant 9 from referring to tenant 42's order. The primary key on line items also gives `WHERE tenant_id = $1 AND order_id = $2 ORDER BY line_number` an ordered access path. The unique idempotency constraint makes two concurrent creates with the same tenant-scoped key compete at the database instead of both passing an application-side existence check.

Now trace the recent-orders query:

```sql
SELECT id, status, total_minor, created_at
FROM orders
WHERE tenant_id = $1
  AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC
LIMIT 100;
```

PostgreSQL descends the `orders_tenant_created_id` B-tree to tenant 42 and the cursor boundary, then walks leaf entries in result order. The executor follows each entry to the candidate row version, applies transaction visibility, and fetches `status` and `total_minor` until it has 100 results. A later covering index could include those projected columns and sometimes avoid separate table-page reads, but that larger index would charge every write for values the first version may not need.

One order insert already changes the table, the primary-key index, the unique idempotency index, and the recent-orders index. Each structure consumes cache, storage writes, and later maintenance; a page split can turn one B-tree insertion into several page writes. Updating an indexed value also creates index work, while deleting a row leaves engine-specific cleanup behind. [SD4](04-relational-engine-internals.md) explains those PostgreSQL and InnoDB paths after the product-level access paths are fixed.

Choose the store by the contract rather than the shape of its marketing example:

| Store model           | Good use in this order system                                                               | Main reason not to make it the order authority                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Relational            | Orders, lines, idempotency, state transitions, and notification intent                      | Best default here because constraints and transactions express the invariants                                                          |
| Key-value or document | One bounded aggregate fetched by a known key                                                | Cross-aggregate uniqueness and multi-record changes move into application protocols; an unbounded item array grows into one hot object |
| Wide-column           | A denormalized, tenant-partitioned activity feed with known range queries                   | Each query needs a planned table or partition key, while cross-partition transactions and joins are a poor fit                         |
| Columnar              | Rebuilt sales aggregates over months of order events                                        | Optimized for scans and merges rather than immediate row constraints and small transactional updates                                   |
| Object                | Invoice PDFs, exports, and large receipt attachments                                        | Bytes by key do not provide relational queries or order-state transactions                                                             |
| Search                | A projection for product-name or free-text lookup                                           | The inverted index can lag and must rebuild from an authoritative record                                                               |
| Time-series           | Operational metrics or append-heavy measurements queried by time range and retention policy | Time-oriented ingestion and compression do not supply the order's relational constraints or transactional state machine                |
| Vector                | A semantic product or support-search projection over embeddings                             | Approximate nearest-neighbor results are a retrieval index, not authority for payment, inventory, or exact order identity              |

## Match column order to the predicate

For WHERE tenant_id = ? AND created_at < ? ORDER BY created_at DESC, an index beginning with tenant_id and then created_at supports the equality prefix and ordered range. Add id as a tie-breaker for deterministic cursor pagination.

An index can speed reads while slowing writes through extra page updates, cache pressure, and background maintenance. Remove an index only after checking every query and constraint that depends on it.

```sql
CREATE INDEX events_tenant_time_id
ON events (tenant_id, created_at DESC, id DESC);

SELECT * FROM events
WHERE tenant_id = $1
  AND (created_at, id) < ($2, $3)
ORDER BY created_at DESC, id DESC
LIMIT 100;
```

## Trace a feed request through the index

Suppose tenant 42 requests the next 100 events before cursor (2026-07-17T09:30:00Z, 9001). The database seeks to the tenant_id prefix, then to the created_at and id tuple just below the cursor. It walks at most enough ordered index entries to return 100 matching rows. A newly inserted event with a later timestamp lands before the cursor and does not shift this page, unlike an offset that counts positions in a changing result set.

Check the plan with representative data, not an empty development table. EXPLAIN shows the chosen access path; EXPLAIN ANALYZE executes the statement and reports actual row counts and timing. Large gaps between estimated and actual rows can come from stale statistics or correlated columns. Fetching many non-indexed payload fields may turn an apparently cheap index scan into scattered heap reads, so measure buffers and I/O as well as elapsed time.

_A cursor names a position in the ordered value space; an offset names a count in a result that may move._

```text
cursor = (2026-07-17T09:30:00Z, 9001)
seek prefix = tenant_id 42
seek boundary = tuple less than cursor
walk direction = newest to oldest
stop condition = 100 visible rows
```

## Split data only when ownership is clear

Putting blobs in object storage and searchable projections in a search engine can be sensible, but the transactional database should retain authoritative metadata and lifecycle state. Define how projections rebuild, how deletion propagates, and what users see while secondary copies lag.

> **Polyglot cost.** Every additional store adds backup, migration, access-control, monitoring, and incident work. A theoretical query win must pay that operating cost.

## Sorted immutable parts replace the row-update path

A MergeTree table stores inserted batches as immutable data parts sorted by the ORDER BY key. In wide parts, each column has separate files, so a query can avoid reading unused columns. The primary index is sparse: it stores marks for granules rather than one unique entry per row. It helps skip ranges whose leading sort-key values do not match, but it does not enforce uniqueness. Partitioning controls lifecycle and part grouping; the ORDER BY expression is the main physical order used for data skipping.

Background merges combine compatible parts into larger sorted parts. Merges reduce part count and improve storage layout, but they spend CPU, memory, and I/O alongside queries. Small individual inserts create many parts and a merge backlog, so batch ingestion is part of the design. ReplacingMergeTree and other variants may resolve duplicate or aggregate rows during merges; because rows with the same key can still live in different parts before a merge, do not promise immediate transactional uniqueness from that behavior.

Columnar storage fits scans and aggregations that touch a subset of columns across many rows. It is a poor automatic replacement for a transactional store that needs point updates, immediate uniqueness checks, foreign-key-like invariants, and short multi-row transactions. A common boundary keeps business state in PostgreSQL or MySQL, captures committed changes, and builds a ClickHouse analytic projection that can be rebuilt and may lag.

> **Three different keys.** In ClickHouse, a partition key groups data parts for lifecycle operations, ORDER BY sets physical row order, and the primary-key expression defines sparse marks. They may overlap, but they are not one relational primary-key constraint.

## Count granules and columns instead of row lookups

Suppose an events table has 40 columns, monthly partitions, and ORDER BY (tenant_id, event_time, event_id). A dashboard requests count and sum(bytes) for tenant 42 over one hour. Partition pruning removes other months. The sparse primary index locates granule ranges whose tenant and time prefix can match. The query reads the key, filter, and measure columns for those ranges, runs aggregation in parallel streams, and merges partial results; it does not fetch 40-column row objects one at a time.

With the default fixed-row ceiling of 8,192 rows per granule, 12 matching granules cover at most 98,304 rows before boundary over-read. The MergeTree documentation notes that a single primary-key range may read up to roughly two granules of extra rows, so this worked estimate budgets another 16,384 rows. Real granules may be smaller because byte limits also apply. Use EXPLAIN indexes and query logs to compare selected parts, granules, rows, bytes, peak memory, and read throughput with the estimate.

If the query scans every part despite a narrow time filter, first inspect whether the predicate constrains the leading ORDER BY fields and whether data landed in too many small parts. If inserts produce 20 new parts each second while merges finish 12, the backlog grows by 8 parts each second, or 28,800 parts per hour. Batch writes, fix the ordering key for the main query shape, and reserve merge bandwidth before adding replicas that copy the same poor layout.

_Marks skip ranges; they do not turn an analytic scan into a unique-row B-tree lookup._

```text
12 granules * 8,192 rows = up to 98,304 matching-granule rows
boundary allowance = 2 * 8,192 = 16,384 rows
part backlog = 20 created/s - 12 merged/s = 8 parts/s
8 * 3,600 = 28,800 additional parts/hour
```

## Diagnose the access path before adding an index

Start with the exact slow operation and its distribution by tenant or parameter shape. Capture the query plan, rows examined versus returned, buffer hits, physical reads, lock waits, and concurrent write rate. A plan that works for a small tenant may scan millions of rows for a large one because data distribution is skewed. One aggregate latency graph will not show that split.

An extra index is the right answer only when it creates the missing access path and its write cost fits the budget. If time comes from lock contention, a new index may add more write work without shortening the critical section. If the search projection is stale, inspect relay lag, failed batches, and the last applied source position; do not repair the projection by treating it as a second authority. Rebuild from the transactional record, then compare counts and deletion markers before switching reads back.

> **Deletion check.** A user-facing delete is incomplete until the authoritative row, object bytes, search projection, caches, and scheduled rebuild inputs follow the stated retention policy.

The schema and access paths now have enough shape to ask how the relational engine keeps concurrent versions, commits changes, cleans obsolete rows, and changes an index while traffic continues. [SD4](04-relational-engine-internals.md) follows those mechanisms. Keep the distinction clear: this note decides which data paths the product needs; the next note explains the runtime and operating costs behind one common authority.

## Running design checkpoint

PostgreSQL becomes the authoritative store because order creation needs tenant isolation, uniqueness, line-item constraints, state transitions, and one local transaction. The logical schema has `orders`, `order_line_items`, `operation_results`, and `notification_outbox`. `orders` uses `(tenant_id, id)` as its identity; line items use `(tenant_id, order_id)` as a foreign key to `orders (tenant_id, id)`. `operation_results` has a unique `(tenant_id, idempotency_key)` path and retains the normalized request hash plus the first result.

The four API operations now have paid paths. Point reads use the composite primary key. Recent-order pages use `(tenant_id, created_at DESC, id DESC)` and the cursor carries the final timestamp and ID from the previous page. Status updates locate one order and compare `version`; notification relay scans an outbox index beginning with unpublished state and creation order. The design does not add a free-text search engine because no stated requirement needs ranked text retrieval.

The 30-day hot set remains about 10.4 TB before indexes and copies. Older closed orders move to object storage under a retention policy, while the database keeps the metadata needed to locate and prove the archive. Committed order changes also feed a rebuildable ClickHouse projection for merchant aggregates. PostgreSQL remains the authority when that projection lags; ClickHouse never decides whether an order exists or which status won.

## Summary

Select storage from product operations, invariants, and paid access paths. Model authority first, add each secondary copy for a named read, and record how lag, rebuild, deletion, and write cost will work before treating the copy as part of the design.

- **Start with operations, not products.** Record lookup fields, ordering, result bounds, mutation scope, freshness, retention, and the crash or concurrency rule for every important path. Those facts eliminate unsuitable layouts before a product comparison begins.
- **Use relational constraints where relationships carry business meaning.** The order model keeps repeated line items separate, retains purchase-time facts deliberately, and uses composite keys so tenant ownership survives every reference.
- **Design indexes from predicates and ordering.** For a tenant-scoped chronological feed, an index beginning with tenant ID and then timestamp supports the equality prefix and ordered range; add a unique tie-breaker for cursor pagination. Confirm with rows examined, buffers, reads, and lock waits rather than index count.
- **ClickHouse optimizes columnar scans and aggregation.** MergeTree writes immutable sorted parts; partition keys group parts for lifecycle work, while ORDER BY controls physical row order and sparse primary-index marks. Queries prune parts and granules, read only needed columns, and merge parallel aggregates; this is not a row-store uniqueness constraint.
- **Keep authority and projections explicit.** A relational store can own transactions while object, search, or columnar systems serve secondary paths. Define rebuild, staleness, deletion, and promotion behavior; every added store also adds backup, migration, access-control, and incident work.
- **Inspect the path before changing it.** Representative plans, rows examined, buffer and disk reads, write load, projection lag, and tenant skew show whether the missing piece is an index, a different physical order, or repair of an existing copy.

## References

- [PostgreSQL: Indexes](https://www.postgresql.org/docs/current/indexes.html)
- [PostgreSQL: Constraints](https://www.postgresql.org/docs/current/ddl-constraints.html): Defines check, unique, primary-key, and foreign-key constraints, including composite references.
- [PostgreSQL: Multicolumn indexes](https://www.postgresql.org/docs/current/indexes-multicolumn.html): Explains how leading equality constraints and the first inequality column limit the scanned portion of a B-tree index.
- [PostgreSQL: Using EXPLAIN](https://www.postgresql.org/docs/current/using-explain.html): Explains estimated costs, row estimates, actual execution, and plan interpretation.
- [ClickHouse: MergeTree Table Engine](https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree): Documents sorted parts, partitions, sparse primary marks, granules, and background merges.
- [ClickHouse: Table Parts](https://clickhouse.com/docs/parts): Explains immutable on-disk parts and merge behavior.
- [ClickHouse: Parallel Query Execution](https://clickhouse.com/docs/optimize/query-parallelism): Shows parallel read streams, aggregation, and query-pipeline inspection.
- [MongoDB: Data Modeling](https://www.mongodb.com/docs/manual/data-modeling/)
- [Bigtable: A Distributed Storage System for Structured Data](https://research.google/pubs/bigtable-a-distributed-storage-system-for-structured-data/)
- [Amazon S3: Working with Objects](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingObjects.html)
- [Elasticsearch: Mapping](https://www.elastic.co/guide/en/elasticsearch/reference/current/mapping.html)

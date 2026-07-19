---
title: Partition Data, Replicate It, and Defuse Hot Keys
shortTitle: Partitioning and replication
description: Distribute state across machines without confusing data volume with traffic distribution. Plan movement, replica placement, and skew before a celebrity key or current-time partition finds the limit.
collection: system-design
slug: partitioning-replication-hot-keys
order: 5
number: SD5
duration: 2.5 hours
difficulty: Core
tags:
  - sharding
  - replication
  - Cassandra
  - Dynamo
  - SSTable
  - compaction
  - tombstones
  - hot keys
  - quorum
  - rebalancing
---

## Working model

Partitioning assigns ownership; replication copies ownership for failure and locality. Neither guarantees balanced traffic, because one logical key can still consume a whole partition's budget.

## Questions this note answers

- Explain why a single storage owner reaches a size, throughput, or failure boundary
- Distinguish a partition or shard from a replica and from the machine serving it
- Choose hash or range partitioning from query and rebalancing needs
- Calculate expected and skewed load per partition
- Separate replication factor from read and write quorum policy
- Trace Cassandra writes through coordinators, commit logs, memtables, SSTables, compaction, and replica repair
- Model a Cassandra table from partition-key and clustering-order queries without creating unbounded hot partitions
- Design hot-key mitigation without losing the required ordering or consistency

## Split ownership only after naming the single-owner limit

A single database owner is the simplest place to enforce order and transactions. Keep it until a measured boundary says otherwise. Partitioning, often called sharding, divides a dataset into ownership units so different units can live on different machines. Replication makes extra copies of an ownership unit so a failure or a local read does not depend on one copy. Partitioning adds capacity across keys; replication adds copies of the same keys. They solve different problems.

Four pressures commonly force a split: the data no longer fits the storage and maintenance window of one owner, writes exceed one owner's safe rate, reads exceed the available replica capacity, or the failure and locality contract requires independent placement. Record which pressure applies. If one tenant generates half the traffic, adding shards for the other tenants may leave that tenant on one saturated owner.

The **partition key** is the value used to choose an ownership unit. A **hot key** is one key or small key range whose request rate, bytes, or work exceeds the budget of its owner even while fleet averages look healthy. A **replica set** is the group of copies assigned to that partition. A node is merely a machine or process serving some of those units at the moment.

## Hash for spread, range for locality

Hash partitioning runs the partition key through a deterministic hash and maps the result to an ownership range. A large, well-mixed keyspace tends to spread, and a point lookup can route from the same calculation, but a query for adjacent business values usually fans out because hashing destroys their order. A poor key such as a low-cardinality country code can still concentrate traffic; a hash cannot create diversity that the input lacks.

Range partitioning assigns adjacent key values to adjacent ownership ranges. It supports bounded ordered scans, but a monotonically increasing key such as current time can send every new write to the final range until that range splits. Range boundaries therefore need a split policy based on size and traffic, not only a static list chosen before production.

A partition map must move. Directly computing `hash(key) modulo node_count` remaps most keys when the node count changes. Consistent-hash rings divide the hash space into many logical token ranges and assign those ranges to nodes, so a membership change can move selected ranges instead. Virtual nodes give each physical node several smaller ranges, which improves movement granularity; they do not cure a hot logical key. Split-and-merge systems adjust ordered ranges around measured size and traffic.

## Keep logical partitions separate from machines

A partition is an ownership unit in the data model; a node is a process or machine that currently serves one or more units. Keeping more logical partitions than nodes lets the system move smaller pieces during scaling and failure recovery. The map from partition to replicas must live in durable cluster metadata, and clients need a way to refresh stale routing information after ownership changes.

Hash placement tends to even out many independent keys, but it destroys natural order between them. Range placement retains order and supports bounded scans, though size and traffic can diverge sharply between ranges. Neither policy knows business heat by itself. Before selecting one, write the point reads, ordered scans, co-location requirements, split trigger, and maximum movement rate the network can absorb without harming foreground requests.

- Partition count controls movement granularity and routing metadata
- Replica placement controls which failures remove all copies
- Split and merge policy responds to size, traffic, or both
- Rebalance rate decides how quickly the cluster recovers spare capacity

## Shard a relational database without losing the transaction boundary

Suppose the orders schema from SD3 outgrows one PostgreSQL or MySQL primary, and nearly every product operation already carries `tenant_id`. Make that tenant the first routing boundary. Keep `tenant_id` in every primary and foreign key so an order and its line items, operation result, and outbox event can remain in one shard-local transaction.

Do not compute `hash(tenant_id) modulo database_count`: changing the database count would remap most tenants. One design hashes into 64 or 256 stable logical shards and stores a small assignment map from logical shard to database cluster. Another keeps an explicit directory from tenant to shard. Hash routing is simple and spreads many ordinary tenants; a directory adds a metadata lookup and cache-invalidation problem but can move one hot or regulated tenant without changing every key. The directory is control-plane state, so version its entries and make stale routers refresh or receive an explicit wrong-shard response.

IDs must remain unambiguous outside one shard. A tenant-scoped `(tenant_id, order_id)` key is already globally unique as a pair. If one scalar ID must work across tenants, use a sufficiently collision-resistant random ID or allocate a shard or node prefix plus a local sequence. Independent `BIGSERIAL` counters on two shards can both issue `817`; pretending those numbers are globally unique creates an error in logs, URLs, and event consumers even when each local database is correct.

Secondary indexes and transactions are shard-local unless another system implements a wider protocol. `WHERE tenant_id = 42 AND created_at < ...` routes once and uses the shard's B-tree. `WHERE email = ...` without a tenant may require a separate globally partitioned lookup or a fan-out across every shard. A cross-tenant aggregate belongs in an asynchronous analytical projection when it can lag. A transaction that updates tenants on two shards needs explicit distributed commit or a saga; ordinary SQL syntax issued twice does not create one atomic decision.

Move tenant 42 as a controlled state transition:

1. Create the target schema, constraints, encryption, capacity, backups, and observability before copying data.
2. Record a source log position and take a consistent snapshot of tenant 42. Bulk-copy that snapshot at a rate that preserves foreground latency.
3. Stream changes after the recorded position into the target, retaining transaction order and stable operation IDs. A snapshot without catch-up loses writes made during the copy.
4. When lag is small, compare row counts only as a first check; also compare keyed checksums and business invariants such as order totals, idempotency uniqueness, and outbox positions.
5. Fence new source writes with a monotonically increasing directory epoch, drain in-flight transactions, apply the final log suffix, and switch the authoritative route. A stale router carrying the old epoch must be rejected or redirected instead of writing the old shard.
6. Keep the source read-only for a bounded validation window. Compare errors, latency, records, and side effects. Do not delete it merely because the first request succeeded.

Rollback is easy only before the target accepts new authoritative writes. After that, reverse replication or another reconciliation path must carry those changes back before the source can be promoted, followed by another fence and route switch. Record the point after which rollback becomes a forward repair.

A hot tenant can receive a dedicated shard through the directory. If that one tenant still exceeds one owner, choose a secondary partition key such as account, region, or time bucket only after identifying the invariants and queries that would cross it. Splitting `tenant_id` by random salt improves write spread but turns tenant-wide uniqueness, ordering, joins, and transactions into distributed problems.

## The partition key chooses placement and query scope

Apache Cassandra is a distributed wide-column database with no permanent leader for an ordinary data partition. A client writes and reads through a coordinator node, while replicas for the partition store the data. Cassandra Query Language looks similar to SQL, but the table design starts from partition-key lookups and clustering order rather than arbitrary joins. This makes placement and bounded query shape visible in the primary-key definition.

Cassandra derives a token from the partition key and uses cluster metadata plus the replication strategy to find the replica set responsible for that token range. Any node can receive a client request and act as coordinator; it routes work to the replicas for the key and waits for the selected consistency level. The coordinator is an operation role, not a permanent leader for that partition.

CQL's PRIMARY KEY contains a partition key followed by optional clustering columns. Rows with the same partition key live in one logical partition, and clustering columns order rows within it. Design one table for a bounded query shape. For a device event history, PRIMARY KEY ((tenant_id, device_id, day), event_time, event_id) lets one query read a device-day range in timestamp order. The day bucket bounds growth, while event_id distinguishes events with equal timestamps.

Leaving day out preserves one device's whole history in a single ordered partition, but that partition grows and one busy device concentrates traffic. Bucketing by hour reduces the hot unit but makes a 30-day query fan out to 720 buckets. Choose the bucket from measured bytes, rows, and peak traffic per logical entity, then record the maximum fan-out accepted by the read API. Cassandra does not make an arbitrary non-key filter cheap merely because the syntax accepts it.

_The double parentheses define a composite partition key; the remaining key columns define order inside that partition._

```sql
CREATE TABLE device_events (
  tenant_id text, device_id text, day date,
  event_time timestamp, event_id uuid, payload blob,
  PRIMARY KEY ((tenant_id, device_id, day), event_time, event_id)
) WITH CLUSTERING ORDER BY (event_time DESC);
```

## Writes append; reads reconcile immutable files

At each replica, a normal write appends to the commit log for crash recovery and updates an in-memory memtable. When the memtable reaches its flush condition, Cassandra writes an immutable sorted-string table, or SSTable. Later updates do not overwrite old SSTable bytes. New timestamped values and deletion tombstones enter through the same append path, so multiple versions of one partition can exist across memtables and several SSTables.

A read may consult the memtable and multiple SSTables. A **Bloom filter** is a compact probabilistic negative test: under its insertion-only assumptions, “absent” means the key is definitely not in that filter, while “maybe present” can be a false positive and requires checking the file. Bloom filters and partition indexes let Cassandra avoid SSTables that cannot contain the key. The replica reconciles timestamped versions into a result, and the coordinator reconciles responses from the replicas required by the read consistency level. More overlapping SSTables, wide partitions, cache misses, and tombstones increase read work even while sequential writes remain quick.

Compaction merges selected SSTables into new SSTables, keeps the winning versions, and can discard obsolete data when its safety rules allow. This trades write and temporary disk amplification for fewer files and less read amplification. Size-tiered, leveled, time-window, and unified strategies organize that work differently; choose from the update pattern, TTL behavior, read sensitivity, and available I/O rather than treating compaction as cleanup that runs for free.

- Commit log: recovery record for acknowledged replica writes
- Memtable: mutable in-memory sorted state awaiting flush
- SSTable: immutable sorted on-disk state plus lookup metadata
- Compaction: background reconciliation that also needs CPU, disk bandwidth, and temporary capacity

## Choose acknowledgement counts per operation

Replication factor states how many replicas the placement policy assigns; consistency level states how many relevant responses an operation needs. With replication factor three, QUORUM requires two replica responses. QUORUM writes and QUORUM reads intersect in at least one replica when they address the same replica set, which lets a read observe the latest acknowledged value under Cassandra's reconciliation rules. ONE uses fewer responses and can return a stale replica while repair is pending.

This arithmetic is not global serializability. Separate partitions do not share a transaction order, a concurrent write can race the read, and Cassandra normally resolves ordinary value conflicts by timestamps. Badly skewed client timestamps can make an older business action appear newer. Lightweight transactions use consensus for conditional changes such as insert-if-absent, but add coordination and should be reserved for an invariant that needs them.

In multiple datacenters, LOCAL_QUORUM confines the quorum requirement to replicas in the local datacenter. That avoids putting intercontinental latency on every operation but does not promise that another datacenter has applied the write. State whether the user needs local read-your-writes, cross-region bounded staleness, or continued writes during region isolation, then select replication and consistency settings that express that contract.

> **Quorum scope.** Write down the replica set, datacenter scope, and concurrent-write rule before using R plus W greater than N as evidence. The inequality alone is not a complete consistency model.

## Follow a quorum write past a failed replica

A partition has replicas A, B, and C. The client writes status=paid with timestamp 120 at QUORUM. A and B append the mutation to their commit logs, update memtables, and acknowledge; C is unreachable. Two acknowledgements satisfy the request, so the client sees success while C still holds status=pending at timestamp 110. A later read at ONE can reach C and return pending. A read at QUORUM reaches two replicas; if their digests differ, Cassandra obtains enough data to reconcile the value with timestamp 120 and may repair the stale replica according to its read-repair behavior.

Hints and read repair reduce divergence, but scheduled repair remains part of operating the replica set. Now suppose an application host with a clock 90 seconds ahead writes pending with timestamp 210 after retrying an old command. Timestamp reconciliation can make pending win over paid even though the business sequence says otherwise. Stable operation IDs, conditional state transitions, controlled timestamp assignment, and clock monitoring belong in the design; quorum does not infer business causality.

Diagnose this incident by collecting consistency level, coordinator, replica endpoints, mutation timestamps, timeout class, hinted-handoff backlog, repair history, and per-replica values. A timeout is ambiguous: too few acknowledgements reached the coordinator, but some replicas may have stored the write. Retry only with the same intended mutation identity and verify the final state at the consistency level required by the product.

_Replica acknowledgement and conflict ordering are separate parts of the correctness contract._

```text
RF=3: replicas A, B, C
QUORUM write needs 2 acknowledgements
A=paid@120, B=paid@120, C=pending@110
ONE may read C; QUORUM intersects A or B and reconciles
skewed retry pending@210 can defeat business order
```

## A tombstone must outlive stale copies

A Cassandra delete writes a timestamped tombstone rather than erasing every replica and SSTable immediately. Reads suppress older values covered by that tombstone. Compaction can eventually remove both obsolete values and the tombstone only when the configured age and overlap conditions make removal safe. If a replica misses the deletion, remains away beyond the repair and tombstone window, and later returns with the old value, repair can make deleted data reappear after the deletion marker is gone.

Repair cadence, maximum outage, tombstone grace, and compaction policy therefore form one equation. Lowering the grace period to reclaim disk faster is unsafe unless repair and failure recovery prove that every old copy is reconciled in time. TTL-heavy tables create tombstones continuously; time-window compaction can group data by time, but late writes, overlapping windows, and long queries still need measurement.

For a simple I/O estimate, compacting four 10 GB SSTables reads about 40 GB and writes a new result of up to about 40 GB before old files are removed. If the device has only 100 MB/s of bandwidth left after foreground work, 80 GB of read-plus-write traffic takes at least 800 seconds, excluding overhead. If new SSTables arrive faster than compaction completes, pending tasks and read amplification grow. Track pending compactions, SSTables per read, bytes compacted, disk free space, tombstones scanned, p99 read latency, and repair age together.

_Actual output and amplification depend on overwritten values, tombstones, compression, and the compaction strategy._

```text
4 SSTables * 10 GB = 40 GB read
new compacted output <= about 40 GB
minimum I/O = about 80 GB
80,000 MB / 100 MB/s = at least 800 s
```

## Place replicas across independent failures

Three copies on one rack are one failure domain wearing three labels. Put replicas across zones or other independent boundaries, then state which operations wait for one copy, a quorum, or every copy.

> **Quorum arithmetic is not a full consistency proof.** R plus W greater than N creates overlap, but sloppy quorums, clock-based conflict resolution, stale replicas, and concurrent writes still affect observed semantics.

## Plan catch-up, repair, and removal

Adding a replica first requires a consistent base copy and then a catch-up stream for writes that arrived during transfer. Promote the copy only after it reaches the system's stated freshness rule. Removing the old owner too early creates a window with fewer durable copies; copying without a bandwidth cap can saturate storage or network links and raise tail latency for live requests.

Replicas also drift after transient failure. Read repair, log replay, or anti-entropy comparison can reconcile them, but each mechanism has a detection delay and a conflict rule. Track under-replicated partitions, bytes awaiting transfer, oldest unrepaired divergence, replica lag, and movement throughput. A nominal replication factor of three says little during a long repair queue, when many partitions may have only two reachable copies.

## Treat hot keys as a workload problem

A popular item, tenant, or current time bucket can saturate one owner while fleet averages stay low. Read replicas and caches help read heat. Write heat may need key salting, a combiner, an append log, or a single-writer policy; the correct move depends on ordering and conflict rules.

## Split a counter without hiding the merge cost

Use this worked workload: 80,000 writes each second, with 32,000 aimed at one logical counter. The other 48,000 writes spread across 16 partitions, about 3,000 per partition. Without a change, the hot owner receives roughly 35,000 writes each second against a 10,000 limit. Adding 16 more ordinary partitions does not split the dominant counter because all of its writes still carry the same routing value.

Eight salted subkeys reduce the hot portion to about 4,000 writes per salt under an even client distribution. If the placement map keeps those salts on separate owners, each such owner sees roughly 7,000 total writes, which fits the stated limit. Reads must fetch and sum eight values. The result may lag while shards update, and a cross-shard snapshot needs extra coordination. If the product requires one strictly ordered counter value after every write, salting has changed the contract and may be unacceptable.

_Check the actual salt-to-owner map; hashing can place two salts on the same owner._

```text
cold share = 48,000 / 16 = 3,000 writes/s
unsplit hot owner = 32,000 + 3,000 = 35,000 writes/s
8 salted shares = 32,000 / 8 = 4,000 writes/s each
estimated salted owner = 4,000 + 3,000 = 7,000 writes/s
```

## Measure skew at the ownership boundary

Fleet CPU averages can remain low while one partition times out. Break request rate, bytes, queue time, throttles, and storage latency down by partition and then by logical tenant or item. Compare the hottest owner's share with the median and p99 owner. Rising replica lag on only that ownership set suggests concentrated write pressure; uniform lag points toward shared network, disk, or repair load.

Watch a rebalance as a controlled migration. Record foreground latency, transfer bandwidth, pending partitions, and the time each partition spends under-replicated. If traffic follows the moving owner faster than routing caches refresh, clients may bounce through forwarding hops or retry stale destinations. Rate-limit movement, refresh maps on explicit ownership errors, and stop the rebalance when user-facing latency crosses its guardrail. More balanced bytes do not justify an outage caused by the repair itself.

## Running design checkpoint

The team does not start with 64 because it is a familiar power of two. A load test using the real schema, indexes, WAL settings, and replica topology finds that one shard can sustain 260 creates each second, but latency and replica lag stay inside their guardrails only up to 200. Restore and index-maintenance rehearsals also set a 200 GB raw-hot-data target per shard: the operations still finish inside their stated window at that size, with temporary disk headroom. These are measured planning limits, not PostgreSQL constants.

Throughput therefore needs `ceil(5,000 / 200) = 25` evenly loaded shards. Storage is stricter: `ceil(10,400 GB / 200 GB) = 52`. The design chooses 64 stable logical shards, the next tested count above both bounds, so ordinary tenants route by `hash(tenant_id)` while an order, its line items, operation result, and notification intent remain under one write authority. At a perfectly even split, each shard receives about 78 creates each second and 162.5 GB of raw hot data. Real admission and placement decisions use the measured tenant distribution because an average cannot protect a skewed owner.

```text
throughput floor = ceil(5,000 creates/s / 200 creates/s per shard) = 25
storage floor = ceil(10,400 GB / 200 GB per shard) = 52
chosen logical shard count = 64
even-share check = 5,000 / 64 ≈ 78 creates/s; 10,400 / 64 = 162.5 GB
```

The stated stress case gives one tenant 20% of peak creates, or 1,000 each second. Pure tenant routing would place all of them on one owner. That tenant therefore uses eight stable virtual buckets chosen by `hash(order_id) mod 8`; the service generates the order ID before routing. Each bucket receives roughly 125 creates per second. The remaining 4,000 creates spread to about 63 per shard, so a deliberately distinct placement for each hot bucket estimates 188 creates per second on those owners, below the tested 200-create planning limit. A recent-orders read for that tenant requests a bounded prefix from eight buckets and merges their timestamp-and-ID order, while ordinary tenants keep the single-shard path.

Each shard has a primary, one synchronous standby, and one additional asynchronous standby in separate zones. An acknowledged create waits for the primary and synchronous copy, so a single-zone loss need not lose the accepted order. Promotion still requires writer fencing. Rebalancing copies a bucket, follows its change stream, verifies counts and positions, switches routing by version, then removes the old copy only after stale routers can no longer write it.

## Summary

Partitioning decides who owns a key; replication decides where copies live and how many responses an operation waits for. Cassandra makes these choices visible in the schema and consistency level, but balanced bytes do not imply balanced traffic, and replica count alone does not prove a consistency guarantee.

- **Choose placement from access patterns.** Hashing spreads a mixed keyspace but scatters ordered ranges; range partitioning keeps locality but can funnel new writes into the newest range. Keep many logical partitions per node so movement happens in smaller units.
- **Keep relational sharding tenant-local when possible.** Route a stable logical shard or versioned tenant directory, carry `tenant_id` through keys and indexes, and keep invariants in one local transaction. Snapshot, log-catch-up, validate, fence, switch, observe, and define the rollback point before moving a tenant.
- **Cassandra's partition key defines routing and query scope.** Any node may coordinate a request, but replicas are selected from the partition key's token. Clustering columns order rows within a partition; time buckets bound partition size at the cost of read fan-out.
- **Understand the Cassandra storage path.** Writes append to the commit log and memtable, then flush to immutable SSTables. Reads reconcile memtables and overlapping SSTables; compaction exchanges CPU, I/O, temporary disk, and write amplification for lower read amplification.
- **Separate replication factor from consistency level.** With RF=3, QUORUM waits for two replicas. Read and write quorums overlap for the same replica set, but concurrent writes, timestamp conflict resolution, local versus cross-region scope, and sloppy behavior still determine observed semantics.
- **Make repair and tombstone timing one safety rule.** A deletion marker must remain until every stale copy that could resurrect old data has been repaired or retired. Track repair age, hinted handoff, compaction backlog, tombstones scanned, free disk, and per-replica values together.
- **Measure and split hot keys deliberately.** A 32,000 writes/s counter stays hot after adding ordinary partitions. Eight salted subkeys reduce the hot share to about 4,000 writes/s each if they land on different owners, but reads must merge eight values and strict ordering may be lost. Diagnose rate, queueing, lag, and throttling by partition and logical tenant, not fleet average.

## References

- [Dynamo: Amazon's Highly Available Key-value Store](https://www.amazon.science/publications/dynamo-amazons-highly-available-key-value-store)
- [Apache Cassandra: Dynamo Architecture](https://cassandra.apache.org/doc/latest/cassandra/architecture/dynamo.html): Documents token placement, coordinators, replication, tunable consistency, hinted handoff, and repair.
- [Apache Cassandra: Storage Engine](https://cassandra.apache.org/doc/latest/cassandra/architecture/storage-engine.html): Explains commit logs, memtables, SSTables, reads, and compaction.
- [Apache Cassandra: Data Definition](https://cassandra.apache.org/doc/latest/cassandra/developing/cql/ddl.html): Defines partition keys, clustering columns, row order, and CQL table options.
- [Apache Cassandra: Guarantees](https://cassandra.apache.org/doc/latest/cassandra/architecture/guarantees.html): States the scope of write durability, isolation, timestamp resolution, and lightweight transactions.
- [Apache Cassandra: Compaction Overview](https://cassandra.apache.org/doc/stable/cassandra/managing/operating/compaction/overview.html): Covers immutable SSTables, compaction, tombstones, grace periods, and deleted-data resurrection.
- [DynamoDB: Designing Partition Keys for Uniform Load](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-uniform-load.html)
- [Vitess: Resharding](https://vitess.io/docs/24.0/user-guides/configuration-advanced/resharding/): Current worked workflow for copying, catching up, validating, and switching a sharded relational keyspace.
- [Vitess: What is resharding?](https://vitess.io/docs/faq/sharding/overview/what-is-resharding-how-does-it-work/): Summarizes copy, replication catch-up, comparison, traffic shift, and source cleanup.
- [PostgreSQL: Logical Replication](https://www.postgresql.org/docs/current/logical-replication.html): Describes initial snapshot copy followed by ordered change application.
- [Spanner: Google's Globally-Distributed Database](https://research.google/pubs/spanner-googles-globally-distributed-database-2/)
- [The Google File System](https://research.google/pubs/the-google-file-system/): Discusses chunk placement, replication, rebalancing, and hotspot behavior.

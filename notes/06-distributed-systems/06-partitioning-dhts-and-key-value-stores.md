---
title: Partitioning, DHTs, and Key-Value Stores
shortTitle: Partitioning and key-value stores
description: Move from centralized lookup to consistent hashing, then trace current Cassandra placement, writes, reads, repair, and tunable response thresholds without confusing them with linearizability.
collection: distributed-systems
slug: partitioning-dhts-and-key-value-stores
order: 6
number: DS6
duration: 3.5 hours
difficulty: Core
tags:
  - partitioning
  - DHT
  - consistent-hashing
  - Cassandra
  - SSTable
  - repair
  - quorum
---

## Working model

Partitioning decides which replicas own a key; routing finds those replicas; the storage engine preserves each replica's state; and a consistency level decides which responses an operation waits for. None of those choices alone supplies a global transaction order.

## Questions this note answers

- Explain why centralized indexes, flooding, supernodes, and structured overlays make different scaling trades
- Map a key onto a consistent-hash ring and route a Chord lookup with successor and finger entries
- Separate a logical partition, token range, replica, node, coordinator, and virtual node
- Choose hash or range partitioning from point-query and ordered-scan requirements
- Distinguish Cassandra's wide-column model from an analytical columnar store such as ClickHouse
- Trace a current Cassandra write through its coordinator, natural replicas, commit logs, memtables, and acknowledgements
- Trace a read through replica selection, reconciliation, SSTables, Bloom filters, and read repair
- Explain hinted handoff, anti-entropy repair, tombstones, and why hints alone do not ensure convergence
- Apply the DS5 client-history test to Cassandra acknowledgements and a network partition
- State which extra protocols are needed before claiming linearizability or serializability

## Begin with the lookup problem

Suppose one million machines can hold files, cached objects, or database partitions. A client has a name and needs an owner. The first design question is where the directory lives.

Napster kept a centralized directory that mapped a filename to peers while the peers transferred files directly. Lookup was simple and the directory could answer flexible searches, but its servers carried global metadata and formed a legal, scaling, and availability boundary. Gnutella removed that directory. Peers formed an unstructured overlay, flooded a query to neighbors with a time-to-live, and routed successful replies back along the reverse path. That removed one catalog but spent many messages per search and could miss distant results.

FastTrack inserted supernodes, trading one permanent center for a changing hierarchy. BitTorrent split files into pieces and exchanged piece availability among peers; its tracker and later distributed discovery mechanisms solve peer discovery, while rarest-first selection and choking solve a different resource-exchange problem.

These systems form a useful design ladder, but Napster and Gnutella are not distributed hash tables in the structured-routing sense. A **distributed hash table (DHT)** assigns both members and keys positions in a structured identifier space so a lookup follows bounded routing state rather than searching arbitrary neighbors.

## Separate placement from routing

Hash partitioning computes a deterministic token from a partition key. It usually spreads many independent keys and supports direct point routing, but it destroys the business ordering of those keys. A query for every timestamp between 09:00 and 10:00 cannot scan adjacent hash tokens unless the data model adds a time bucket or another index.

Range partitioning keeps adjacent values together. That supports ordered scans, but monotonically increasing values can send every current write to the final range until the system splits or moves it. Neither approach fixes a celebrity key that receives half the traffic; one logical key still maps to one logical ownership unit unless the application shards that key.

Computing `hash(key) modulo node_count` moves most keys when the node count changes. Consistent hashing places nodes and keys in a larger circular token space. A key belongs to the first eligible owner clockwise from its token. Adding one owner changes selected ranges instead of changing every key's modulo result.

Placement answers which replicas should hold a key. Routing answers how the caller finds them. Replication answers how many copies exist and where their failure domains lie. A ring diagram often draws all three with arrows, which makes them easy to confuse.

## Follow one Chord lookup

Chord gives each member an identifier in an `m`-bit circular space. A member's immediate successor keeps the ring connected, while finger entries point roughly `2^i` identifiers ahead and let a lookup skip large arcs. Each step forwards toward the closest known predecessor of the target token; under uniformly hashed identifiers and sufficiently current routing state, the expected hop count grows logarithmically with the number of members.

Use the lecture's seven-bit ring, whose identifier space is 0 through 127:

```text
members clockwise: 16, 32, 45, 80, 96, 112
key token:          42
owner:              45, the first member clockwise from 42
```

A lookup beginning at member 80 wraps through zero. Its finger table can skip to 16, then 32, and finally reach 45. A successor-only ring would still find the owner, but it might visit a linear number of members.

Now member 40 joins between 32 and 45. Its successor becomes 45, member 32 changes its successor to 40, and stabilization gradually repairs other successor, predecessor, and finger entries. Ownership for tokens in `(32, 40]` moves from 45 to 40, including example keys 34 and 38. Keys above 40 through 45 stay at 45.

Failures require separate protection for routing and data. A successor list lets a member route around one dead successor. Replicating key data on several neighboring or independently placed members protects the value itself. A successor-list argument based on independent random failures does not cover one rack, power domain, or operator action taking every adjacent copy down.

Chord's bounds also assume hashed identifiers, enough stabilization relative to churn, and a connected surviving ring. Stale fingers may add hops without breaking a lookup, while stale successors can break reachability. Consistent hashing is a placement technique, not a promise that ownership metadata is fresh.

## Use virtual nodes for movement granularity, not as a hot-key cure

A physical node can own several logical tokens or **virtual nodes**. More, smaller token ranges make it easier to spread ownership and move part of a node's load when capacity changes. They also add metadata and movement streams, and they do not split one hot partition key. If every request uses `artist = Taylor Swift`, hashing that value perfectly still sends the requests for that logical partition to the same replica set.

Modern systems differ in how they choose tokens. Some use many random virtual nodes, some allocate a smaller number of balanced tokens, and others manage explicit ranges. Ask how the system limits concurrent movement, preserves replica separation, and refreshes routing metadata before choosing a ring because the picture looks balanced.

## A key-value API does not determine the storage model

The smallest key-value interface offers `put(key, value)`, `get(key)`, and perhaps delete or conditional update. Distribution adds placement, replication, failure recovery, and conflict semantics. It does not require values to be untyped blobs, and it does not make relational queries obsolete.

Apache Cassandra is a **wide-column** database with a typed Cassandra Query Language (CQL) schema. A table has a partition key that selects placement and optional clustering columns that order rows within one partition. Tables are designed from known queries, often duplicating data into several tables because Cassandra does not perform general server-side joins.

Wide-column is not the same as analytical columnar storage. Cassandra's current storage engine writes partitions and rows into immutable sorted-string tables (SSTables) ordered by token and clustering keys. It does not store one entire analytical column as a separate compressed stream so a scan can read only `revenue` across billions of unrelated rows. ClickHouse is an analytical columnar database: its storage layout reads selected columns and uses compression and vectorized execution for large aggregations. The names share the word "column" but describe different decisions.

MongoDB supplies a document model with leader-based replica sets and flexible nested documents. HBase is another wide-column system, normally with one active primary region unless region replication is configured, and uses HDFS beneath its region servers. Treating all three as interchangeable "NoSQL" hides their authority, query, and failure contracts. Historical benchmark ratios from one dataset and one durability setting do not select a database.

## Model Cassandra around a bounded query

Consider device events queried by one tenant and device for one day in reverse timestamp order:

```sql
CREATE TABLE device_events_by_day (
  tenant_id text,
  device_id text,
  day date,
  event_time timestamp,
  event_id uuid,
  payload blob,
  PRIMARY KEY ((tenant_id, device_id, day), event_time, event_id)
) WITH CLUSTERING ORDER BY (event_time DESC);
```

The parenthesized triple is the partition key. Cassandra hashes it to a token. Rows sharing that value live on the same natural replica set, ordered by `event_time` and then `event_id`. The day bounds partition growth; it also means a 30-day read must query 30 partitions and combine results.

Leaving `day` out gives one device a single lifetime partition, which may grow without bound and concentrate a busy device's traffic. Bucketing by hour lowers the maximum partition size but makes longer reads fan out. Select the bucket from measured row size, write rate, retention, and permitted read fanout.

Cassandra has a schema. Columns have types, the primary key determines uniqueness and layout, and query restrictions follow that layout. Calling it schemaless repeats an old NoSQL slogan rather than describing CQL.

## Current Cassandra routes directly from cluster metadata

Any Cassandra node can receive a request and act as its **coordinator** for that operation. The coordinator hashes the partition key, consults token and topology metadata, identifies the natural replicas selected by the keyspace's replication strategy, and sends requests to them. It is not a permanent leader for the key and does not serialize ordinary writes for that key.

Current Cassandra uses the Murmur3 partitioner by default. Production keyspaces normally use `NetworkTopologyStrategy` to place the requested replication factor across datacenters and racks. The old lecture discussion of `RandomPartitioner`, `ByteOrderedPartitioner`, a per-datacenter ZooKeeper election, or a per-key serializing coordinator does not describe current Cassandra.

Cassandra also does not use Chord fingers for request routing. Nodes maintain enough token and endpoint metadata to send an operation to the relevant replicas. The ring and consistent-hash ancestry still explain placement, but the packet does not hop around the ring one finger at a time.

## Trace the write at every replica

For an ordinary write, the coordinator sends the mutation to all natural replicas for the partition regardless of the selected consistency level. The consistency level controls how many qualifying responses it waits for before replying to the client.

At each receiving replica:

1. Cassandra appends the mutation to a local commit log for crash recovery.
2. It updates the table's in-memory memtable.
3. It acknowledges according to the storage and durability path.
4. When the memtable reaches a flush condition, Cassandra writes an immutable SSTable.

The write path does not seek through old SSTables before accepting an ordinary mutation. That makes writes sequential, but the deferred work appears later as flush, compaction, repair, and read amplification.

If a natural replica is unavailable, the coordinator may store a durable **hint** locally for that replica and replay it when the replica returns within the configured hint window. It does not send the mutation to arbitrary extra nodes and call them replicas. Hints are best effort; they reduce divergence but do not replace repair.

`ANY` is a write-only consistency level. It can acknowledge when a natural replica accepted the mutation or when the coordinator stored a hint. At that moment no replica may yet make the value readable. There is no `ANY` read.

## Reads reconcile several immutable sources

A replica read checks current memtables and relevant SSTables. A Bloom filter can prove that an SSTable does not contain a partition key when the filter says absent. A false positive may cause an unnecessary lookup; a correct Bloom filter does not produce false negatives. Partition indexes, summaries, caches, and clustering bounds narrow the remaining work.

Because SSTables are immutable, several files can contain versions of the same row or cell. The replica reconciles them using Cassandra's timestamp and deletion rules. The coordinator then reconciles the replica responses required by the read consistency level. It generally sends enough requests to satisfy that level, with speculative retry able to add another request when configured and useful.

When involved replicas disagree, current Cassandra can perform blocking read repair according to the table's `read_repair` setting. The default blocking behavior supports monotonic quorum reads for the cases covered by that mechanism. Read repair only touches data read in that operation; it is not a substitute for repairing every token range.

Compaction merges selected SSTables into new immutable files and eventually discards obsolete versions when safe. This consumes read bandwidth, write bandwidth, CPU, and temporary disk space. A tombstone represents deletion until the system can safely discard the old value. If replicas miss a tombstone and operators let it expire before repair restores agreement, an older value can reappear. Repair cadence and tombstone grace therefore form one data-safety policy.

Full or incremental anti-entropy repair compares replica data for shared token ranges and streams differences. Hints, read repair, and scheduled repair cover different windows. Current Cassandra documentation explicitly calls hints best effort and repair necessary for writes a returning node never learned.

## Count acknowledgements without inventing a stronger model

**Replication factor (RF)** is the number of natural replicas Cassandra places for a partition. **Consistency level (CL)** is the response threshold and scope for one operation. With RF 3 in one datacenter, `QUORUM` requires two responses. `LOCAL_QUORUM` counts a majority of replicas in the coordinator's local datacenter; `EACH_QUORUM` has a different multi-datacenter requirement.

A consistency level says which acknowledgements let the coordinator respond; it does not by itself say which client-visible histories are legal. Apply the [DS5 history test](./05-consensus-and-replicated-state-machines.md#read-the-client-visible-history-before-claiming-consistency) to RF 3 with replicas A, B, and C:

```text
t1  write(status=paid) reaches A and B at QUORUM
t2  client receives success
t3  a later read(status) reaches stale replica C at ONE
t4  client receives pending
```

Both operations met their requested Cassandra consistency levels. The observed register history is still not linearizable: the successful write returned before the read began, so real-time order puts the write first, but the read returned the earlier value. A later quorum read may reconcile the replicas and repair C; it cannot change the history the client already observed.

If a completed write and a later read use intersecting replica sets, the read contacts at least one replica that acknowledged the write. Cassandra's reconciliation rules can then make the acknowledged value visible. That is the useful idea behind `R + W > N`, but the inequality is not a complete consistency model.

Ordinary Cassandra writes can be concurrent, coordinators can differ, and conflict resolution uses timestamps. Clock skew or an application-supplied timestamp can make an older business command win. Quorum reads and writes do not create a global serial order across partitions, and they do not by themselves make one key linearizable under every concurrent execution.

To claim linearizability for an operation, an implementation also needs a protocol that orders concurrent updates, records decisions durably, rejects superseded authorities through terms, ballots, or fencing, changes membership safely, and makes reads prove that they cannot return a value older than the most recent write that completed before the read began. A consensus-backed leader is one design. Cassandra lightweight transactions use Paxos for conditional operations such as compare-and-set and provide a linearizable conditional-update path within their documented scope; ordinary `QUORUM` operations do not inherit that claim.

To claim serializability for a transaction spanning several rows or partitions, the system also needs concurrency control across the whole read and write set, such as locking or serializable validation. Distributed participants need an atomic commit and recovery protocol with durable transaction decisions. An acknowledgement count or one conditional operation cannot prove that the larger transaction history is serializable. [DS7: Replication, consistency, and transactions](./07-replication-consistency-and-transactions.md) develops these guarantees and protocols in detail.

## Apply CAP during the partition

CAP does not ask a database to choose two permanent labels. During a network partition, an operation that requires one linearizable history cannot also return success from every isolated side. A side that cannot establish current authority must reject or wait, or it must accept histories that the linearizable service would forbid.

For RF 3, split the replicas into `{A}` and `{B, C}`. Suppose A reports success for `write(paid)`. A read that begins later on the `{B, C}` side must reflect that write to satisfy the DS5 register history, but those replicas cannot distinguish this execution from one in which A accepted nothing. If the read must answer in both executions, one answer violates linearizability. The `{B, C}` side can still satisfy `QUORUM`; A cannot. To preserve the linearizable contract, A must wait or reject. A write at `ONE` may instead succeed on A, but that operation chose a weaker history rather than escaping the CAP constraint.

Cassandra lets the client select response thresholds per operation, which changes what can complete in a given failure. Lower levels may remain available on more fragments and expose stale or conflicting state. Quorum levels reject when their required replica responses cannot cross the partition. This is tunable behavior, not "Cassandra always chooses availability."

Availability outside a partition, latency, durability, isolation, and eventual repair remain separate questions. The familiar triangle does not answer them.

## Work one placement, write, and repair case

Start with the Chord ring from earlier. Key token 42 maps to member 45. When member 40 joins, token 42 stays at 45 because it lies above 40; keys 34 and 38 move to 40. That exercise establishes primary placement only.

Now translate the idea to a Cassandra keyspace with RF 3. Cassandra hashes partition key `order-817` to a token and cluster metadata selects replicas A, B, and C on separate racks. Client X sends `status = paid` at `QUORUM` to coordinator D.

```text
coordinator D -> replicas A, B, C
A: commit log + memtable -> ack
B: commit log + memtable -> ack
C: unreachable
D: stores hint for C
two replica acknowledgements -> client success
```

C returns before D replays the hint. A read at `ONE` can reach C and return the older `pending` value, producing the non-linearizable history analyzed above. A read at `QUORUM` that reaches A and C sees disagreement, reconciles `paid` as the winning timestamped value, and may repair the involved stale replica under the table's read-repair policy. Scheduled repair still has to cover divergence that no read touches.

Suppose D times out after receiving only A's acknowledgement. The client cannot infer that the write failed; A may hold it, B may store it after the timeout, and D may have a hint. A retry should carry the same logical operation identity and the same intended transition. A quorum timeout describes missing acknowledgements, not a rollback.

Finally, client Y concurrently writes `status = cancelled` with a larger timestamp even though the business workflow says payment should be terminal. Cassandra's ordinary reconciliation can make `cancelled` win. The database cannot infer the state machine from the words. Protect that rule with a conditional transition, a lightweight transaction where appropriate, or one higher-level authority.

## Inspect placement, storage, and repair separately

When one key is slow or inconsistent, record its partition key, token, natural replicas, coordinator, consistency level, topology, and current ownership metadata. Then inspect each replica's mutation timestamp, memtable/SSTable state, tombstones, dropped messages, and repair history. A healthy ring view does not prove equal data; equal data does not prove the client contacted enough replicas.

For fleet imbalance, compare token ownership, bytes, request rate, partition size, compaction debt, repair streams, and hardware capacity. Even ownership percentages can hide a hot tenant. Limit movement so streaming does not consume the disk and network budget needed by foreground requests.

Avoid repairing blindly during an outage. Repair and compaction both amplify I/O, and replacing several nodes at once can erase the surviving evidence needed to distinguish stale data from a routing error. Identify the authoritative application outcome and the replica divergence first.

## Summary

Distributed storage is a stack of separate mechanisms whose promises must be composed explicitly.

- **Lookup designs pay in different places.** A central directory concentrates metadata, flooding spends messages, and a DHT maintains structured routing state.
- **Placement is not routing or replication.** Consistent hashing assigns ranges; a routing protocol finds them; replica policy copies them across failure domains.
- **Chord's bounds have assumptions.** Uniform identifiers, current successors, enough stabilization, and the failure model determine whether logarithmic lookup and recovery arguments apply.
- **Cassandra is wide-column, not analytical columnar.** CQL tables use typed partition and clustering keys; SSTables organize partitions and rows rather than storing analytical column stripes.
- **Any node may coordinate.** Current Cassandra routes directly to natural replicas and sends writes to all of them; the selected consistency level controls acknowledgements waited for.
- **Convergence needs repair.** Hints and read repair shorten divergence, while scheduled anti-entropy repair covers missed data they never touch.
- **Quorum intersection is evidence inside a protocol proof.** It helps later reads encounter acknowledged writes under stated replica and reconciliation assumptions; acknowledgement counts do not define a legal client history.
- **Stronger claims need stronger protocols.** Linearizability needs ordered updates, durable authority, safe membership, and a read rule; serializability also needs transaction-wide concurrency control and, across participants, atomic commit and recovery.
- **CAP applies when communication splits.** A minority fragment must wait or reject to preserve one linearizable history, or accept operations under a weaker model.

## References

- [CS 425 Fall 2025 L7-8: peer-to-peer systems and DHTs](https://courses.grainger.illinois.edu/cs425/fa2025/L7-8.FA25.pdf)
- [CS 425 Fall 2025 L9-11: key-value and NoSQL stores](https://courses.grainger.illinois.edu/cs425/fa2025/L9-11.FA25.pdf)
- [Stoica et al.: Chord, A Scalable Peer-to-peer Lookup Service for Internet Applications](https://pdos.csail.mit.edu/papers/chord:sigcomm01/chord_sigcomm.pdf)
- [DeCandia et al.: Dynamo, Amazon's Highly Available Key-value Store](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- [Apache Cassandra architecture overview](https://cassandra.apache.org/doc/stable/cassandra/architecture/overview.html)
- [Apache Cassandra data-modeling introduction](https://cassandra.apache.org/doc/stable/cassandra/developing/data-modeling/intro.html)
- [Apache Cassandra storage engine](https://cassandra.apache.org/doc/stable/cassandra/architecture/storage-engine.html)
- [Apache Cassandra replication and tunable consistency](https://cassandra.apache.org/doc/stable/cassandra/architecture/dynamo.html)
- [Apache Cassandra hinted handoff](https://cassandra.apache.org/doc/stable/cassandra/managing/operating/hints.html)
- [Apache Cassandra read repair](https://cassandra.apache.org/doc/stable/cassandra/managing/operating/read_repair.html)
- [Apache Cassandra anti-entropy repair](https://cassandra.apache.org/doc/latest/cassandra/managing/operating/repair.html)
- [ClickHouse columnar storage](https://clickhouse.com/docs/intro#column-oriented-storage)

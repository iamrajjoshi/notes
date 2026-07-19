---
title: System design
description: Requirements, capacity, request paths, data systems, coordination, asynchronous work, reliability, and design cases.
slug: system-design
order: 5
duration: 33-35 hours
---

## Scope

A method for producing and defending a design with traceable requirements, capacity math, storage and consistency choices, overload behavior, recovery targets, and observable acceptance criteria.

Read the notes in order. The first note shows how to turn a vague prompt into a bounded contract and explains the artifacts that appear in every later design. The sequence then follows one request through an API and the network before adding data modeling, relational-engine behavior, distribution, coordination, asynchronous work, caching, scheduling, and recovery. The final note combines those pieces in nine worked interview designs.

## Orientation and decision ledger

Every note continues the same illustrative system: merchants create and inspect tenant-scoped orders, update their status, and trigger email or push notifications. Payment execution, inventory ownership, template editing, and provider internals stay outside the boundary. The fixed workload is 1,000 average and 5,000 peak order creates each second, 20,000 peak reads each second, 4 KB per stored order, 30 days of hot history, p99 create latency below 250 ms, 99.9% monthly create availability, and 99% of notification dispatches starting within five seconds. The stress case assigns 20% of creates to one tenant; regional recovery targets a 15-minute RTO and 30-second RPO.

Reading sequence: [SD1](01-frame-the-problem.md) → [SD2](02-api-network-path.md) → [SD3](03-storage-data-modeling.md) → [SD4](04-relational-engine-internals.md) → [SD5](05-partitioning-replication-hot-keys.md) → [SD6](06-time-consistency-coordination.md) → [SD7](07-async-streaming-designs.md) → [SD8](08-caching-overload-control.md) → [SD9](09-control-planes-schedulers.md) → [SD10](10-reliability-observability.md) → [SD11](11-interview-studios.md).

| Note | Main job                   | Decision added to the running design                                         | Deeper derivation                                                                                                                                                                                                                                                                  |
| ---- | -------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SD1  | Bound and size the prompt  | Contract, SLOs, 10.4 TB raw hot data, and exclusions                         | [DS1: remote calls and ambiguous outcomes](../06-distributed-systems/01-system-model-and-rpc.md)                                                                                                                                                                                   |
| SD2  | Define the request path    | Four API operations, one-second deadline, and tenant-scoped idempotency      | [DS1: deadlines, retries, and operation identity](../06-distributed-systems/01-system-model-and-rpc.md)                                                                                                                                                                            |
| SD3  | Choose data paths          | PostgreSQL authority, ordered tenant index, archive, and analytic projection | [DB1](../07-data-systems/01-data-models-and-access-patterns.md) through [DB3](../07-data-systems/03-indexes-query-planners-and-execution.md)                                                                                                                                       |
| SD4  | Open the relational engine | Bounded pools, MVCC/WAL boundary, and observable concurrent index migration  | [DB4](../07-data-systems/04-transactions-concurrency-and-recovery.md) through [DB7](../07-data-systems/07-mysql-and-innodb-internals.md)                                                                                                                                           |
| SD5  | Distribute ownership       | 64 shards, three zonal copies, and eight buckets for the hot tenant          | [DS6: placement](../06-distributed-systems/06-partitioning-dhts-and-key-value-stores.md), [DS7: replication](../06-distributed-systems/07-replication-consistency-and-transactions.md), and [DB11: Cassandra](../07-data-systems/11-cassandra-partitions-compaction-and-repair.md) |
| SD6  | State correctness          | Per-order versioning plus a transactional outbox and idempotent consumers    | [DS5: consensus](../06-distributed-systems/05-consensus-and-replicated-state-machines.md), [DS7: transactions](../06-distributed-systems/07-replication-consistency-and-transactions.md), and [DB4: isolation](../07-data-systems/04-transactions-concurrency-and-recovery.md)     |
| SD7  | Buffer notification work   | At-least-once queue, retry identity, dead letters, and backlog arithmetic    | [DS8: stream processing](../06-distributed-systems/08-distributed-dataflow-and-scheduling.md) and [DB15: CDC](../07-data-systems/15-change-data-capture-and-projections.md)                                                                                                        |
| SD8  | Protect scarce capacity    | Terminal-receipt cache, 30,000-RPS admission ceiling, and priority shedding  | [DB9: Redis and cache failure](../07-data-systems/09-redis-data-structures-persistence-and-cluster.md)                                                                                                                                                                             |
| SD9  | Reconcile worker capacity  | 75 workers across three zones with explainable placement and spare nodes     | [DS8: scheduling and shared resources](../06-distributed-systems/08-distributed-dataflow-and-scheduling.md)                                                                                                                                                                        |
| SD10 | Recover a region           | Active-passive fencing, 15-minute RTO, 30-second RPO, and SLO evidence       | [DS10: security and recovery](../06-distributed-systems/10-security-incidents-and-capstone.md) and [DB6: database recovery](../07-data-systems/06-postgresql-replication-backups-and-schema-change.md)                                                                             |
| SD11 | Defend the complete design | Final ledger plus a requirement perturbation that forces a redesign          | Revisit the derivation beside the decision that changed                                                                                                                                                                                                                            |

These notes assume ordinary product-engineering experience. Product names such as Kafka, Cassandra, ECS, and EKS are defined before their mechanics are used. When a mechanism appears, ask four questions: what problem forced it into the design, what promise does it make, where does that promise end, and how would an operator know it stopped working?

Difficulty labels describe the depth inside a note, not another reading order. Follow the note numbers; a later Core note may apply an Advanced mechanism introduced earlier.

Reading the module will not by itself make someone ready for every system-design interview or production on-call rotation. Use it to build a repeatable reasoning method, then practice unfamiliar prompts, draw request and recovery paths, run load tests, restore backups, and review real incidents. Production judgment comes from making the written assumptions collide with measured systems.

## Useful background

- Comfort reading an HTTP API and a relational schema
- Basic familiarity with processes, networks, and persistent storage
- Ability to do unit conversions and percentage calculations

If those foundations are rusty, read [cloud infrastructure](../01-cloud-infrastructure/INDEX.md) for service boundaries and [low-level infrastructure](../02-low-level-infrastructure/INDEX.md) for processes, memory, networks, and storage. Read [distributed systems](../06-distributed-systems/INDEX.md) before or alongside SD5–SD10: that module derives the time, replication, consensus, and failure mechanisms that system design applies. The [data systems](../07-data-systems/INDEX.md) foundations provide the slower path through storage engines, indexes, transactions, and the database products used from SD3 onward. None is a hidden prerequisite for starting SD1; the ledger links provide a second explanation when a mechanism needs more detail.

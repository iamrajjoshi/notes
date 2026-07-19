---
title: System design
description: Requirements, capacity, request paths, data systems, coordination, asynchronous work, reliability, and design cases.
slug: system-design
order: 4
duration: 24-28 hours
---

## Scope

A method for producing and defending a design with traceable requirements, capacity math, storage and consistency choices, overload behavior, recovery targets, and observable acceptance criteria.

Read the notes in order. The first note shows how to turn a vague prompt into a bounded contract and explains the artifacts that appear in every later design. The sequence then follows one request through an API and the network before adding data modeling, relational-engine behavior, distribution, coordination, asynchronous work, caching, scheduling, and recovery. The final note combines those pieces in interview exercises.

## Orientation and decision ledger

Every note includes a checkpoint for the same illustrative system: merchants create and inspect tenant-scoped orders, update their status, and trigger email or push notifications. Payment execution, inventory ownership, template editing, and provider internals stay outside the boundary. The fixed workload is 1,000 average and 5,000 peak order creates each second, 20,000 peak reads each second, 4 KB per stored order, 30 days of hot history, p99 create latency below 250 ms, 99.9% monthly create availability, and 99% of notification dispatches starting within five seconds. The stress case assigns 20% of creates to one tenant; regional recovery targets a 15-minute RTO and 30-second RPO.

| Note | Main job                   | Decision added to the running design                                         |
| ---- | -------------------------- | ---------------------------------------------------------------------------- |
| SD1  | Bound and size the prompt  | Contract, SLOs, 10.4 TB raw hot data, and exclusions                         |
| SD2  | Define the request path    | Four API operations, one-second deadline, and tenant-scoped idempotency      |
| SD3  | Choose data paths          | PostgreSQL authority, ordered tenant index, archive, and analytic projection |
| SD4  | Open the relational engine | Bounded pools, MVCC/WAL boundary, and observable concurrent index migration  |
| SD5  | Distribute ownership       | 64 shards, three zonal copies, and eight buckets for the hot tenant          |
| SD6  | State correctness          | Per-order versioning plus a transactional outbox and idempotent consumers    |
| SD7  | Buffer notification work   | At-least-once queue, retry identity, dead letters, and backlog arithmetic    |
| SD8  | Protect scarce capacity    | Terminal-receipt cache, 30,000-RPS admission ceiling, and priority shedding  |
| SD9  | Reconcile worker capacity  | 75 workers across three zones with explainable placement and spare nodes     |
| SD10 | Recover a region           | Active-passive fencing, 15-minute RTO, 30-second RPO, and SLO evidence       |
| SD11 | Defend the complete design | Final ledger plus a requirement perturbation that forces a redesign          |

These notes assume ordinary product-engineering experience. Product names such as Kafka, Cassandra, ECS, and EKS are defined before their mechanics are used. When a mechanism appears, ask four questions: what problem forced it into the design, what promise does it make, where does that promise end, and how would an operator know it stopped working?

Reading the module will not by itself make someone ready for every system-design interview or production on-call rotation. Use it to build a repeatable reasoning method, then practice unfamiliar prompts, draw request and recovery paths, run load tests, restore backups, and review real incidents. Production judgment comes from making the written assumptions collide with measured systems.

## Useful background

- Comfort reading an HTTP API and a relational schema
- Basic familiarity with processes, networks, and persistent storage
- Ability to do unit conversions and percentage calculations

If those foundations are rusty, read [cloud infrastructure](../01-cloud-infrastructure/INDEX.md) for service boundaries and [low-level infrastructure](../02-low-level-infrastructure/INDEX.md) for processes, memory, networks, and storage. Read [distributed systems](../06-distributed-systems/INDEX.md) before or alongside SD5–SD10: that module derives the time, replication, consensus, and failure mechanisms that system design applies. None is a hidden prerequisite for starting SD1; the links provide a second explanation when a mechanism needs more detail.

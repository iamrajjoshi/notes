---
title: "Shared production services: queues, pools, and durable workflows"
description: Define supported platform contracts, choose asynchronous delivery semantics, bound PostgreSQL connections, and recover durable work.
slug: shared-production-services
order: 11
identifier: CI11
duration: 60 min
difficulty: Advanced
tags:
  - platform
  - SQS
  - EventBridge
  - PgBouncer
  - DBOS
  - durable execution
---

## Working model

A shared production service is an owned contract around a resource boundary. The contract states who may request work, what state persists, which limit applies, how retries behave, and what evidence tells a caller that the service is healthy or blocked.

This note uses three independent cases rather than one request path: asynchronous delivery, PostgreSQL connection pooling, and durable workflow execution. The common subject is the platform contract around each resource, not a requirement to deploy all three together.

## A platform should expose owned, versioned interfaces

Once several teams repeat the same deployment, database, queue, or alert setup, the infrastructure team should expose a small supported interface instead of requiring every application engineer to copy controller details. That interface might be a reviewed module, Custom Resource, template, or service API. It needs input validation, secure defaults, quota behavior, status, ownership, upgrade policy, and a documented escape route for requirements it does not cover.

Self-service does not mean unrestricted access. The platform can let a team request a database class while keeping subnet, backup, encryption, audit, and deletion policy under infrastructure ownership. Measure the interface by lead time, failure rate, support load, policy compliance, and whether users can diagnose status without reading the controller source.

Version the contract independently from its implementation when callers should not have to change with every provider or controller upgrade. Deprecation needs a discoverable replacement, migration evidence, and an end date. An escape route also needs ownership: a team that bypasses the supported interface must know which guarantees it now operates itself.

The smallest useful status surface answers four questions: was the request accepted, which owner is acting on it, what condition blocks progress, and which observed resource or operation proves completion? A green API response without that later state leaves users dependent on platform operators for ordinary diagnosis.

## Case 1: expose an asynchronous contract, not an “event service”

Amazon Simple Queue Service (SQS) stores work for competing consumers. A consumer receives a message under a visibility timeout and deletes it after success; Standard queues provide at-least-once delivery, so processing still needs idempotency. First-in, first-out (FIFO) queues add ordering within message groups and broker-side deduplication rules, but they cannot make an external database or payment side effect exactly once.

Amazon Simple Notification Service (SNS) publishes one message to multiple subscriptions such as SQS, Lambda, or HTTP endpoints. Pairing each durable subscriber with its own SQS queue separates fan-out from retry and backlog ownership. Amazon EventBridge event buses match and route events from many sources to targets, while EventBridge Pipes connect one source to one target with optional filtering, transformation, and enrichment. Kafka through MSK retains ordered partition logs for replay and independent consumer groups. [CI7](07-kafka-replicated-event-log.md) develops the retained-log mechanism; [CI8](08-celery-task-processing.md) covers named task execution over a broker.

| Need                                         | Start with                                  | Contract to write down                                                        |
| -------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| One worker should claim each job             | Work queue                                  | Visibility or lease, acknowledgement, retry identity, poison-work policy      |
| Every subscriber needs its own attempt       | Topic plus one durable queue per subscriber | Subscription ownership, filtering, retry isolation, retention                 |
| Rules should route events by content         | Event bus                                   | Event schema, rule ownership, target permission, failed-delivery destination  |
| Consumers need old ordered records           | Partitioned retained log                    | Partition key, ordering scope, retention, offset ownership, replay rate       |
| A multi-step operation must survive restarts | Durable workflow                            | Workflow identity, persisted step boundary, timer, retry, code-version policy |

[CI7: Kafka as a replicated event log](07-kafka-replicated-event-log.md) introduces these asynchronous shapes before deriving Kafka's retained-log mechanism. At the platform boundary, the selection questions remain concrete: does one worker or every subscriber need the item, must it be replayed, what is ordered, who owns acknowledgement, how long must it remain available, and where do failed messages wait? “Asynchronous” alone answers none of them.

## Case 2: PgBouncer multiplexes clients onto a bounded server pool

An application opens client connections to PgBouncer; PgBouncer opens a smaller, bounded set of server connections to PostgreSQL for each database-and-user pool. `max_client_conn` limits accepted clients, while pool and database limits constrain server connections. Waiting clients are backpressure, not free capacity: they retain application work and can pass their deadlines while the database remains busy. Size the full fleet, including rollout surge and administrative headroom, against the database connection budget.

Pool mode decides when a server connection can serve another client. Session pooling keeps it until the client disconnects. Transaction pooling returns it after a transaction, so a later transaction may receive a different PostgreSQL session. Code using session-scoped state, session advisory locks, temporary tables, or untracked prepared state must be changed, pinned to session mode, or tested against documented support. Statement pooling releases after each statement and disallows multi-statement transactions, so it fits far fewer application contracts.

Suppose each of 20 application Pods is paired with its own PgBouncer instance. Each application can open 40 client connections, while its pool permits 10 server connections. Client capacity is 800, but steady server capacity is 200 before database/user multiplicity. A rollout that adds five Pods can raise the possible server total by 50. Autoscaling on HTTP or queue pressure without a database budget can therefore turn a slowdown into connection exhaustion rather than more throughput.

_The arithmetic is generic. Real limits must reserve PostgreSQL capacity for maintenance, migrations, failover, and non-application users._

```text
client connections: application → PgBouncer
server connections: PgBouncer → PostgreSQL
20 pools x 10 server connections = 200
rollout surge: 5 pools x 10 = 50 more possible server connections
```

The connection budget is not the throughput budget. Ten server connections executing 500 ms transactions finish at most about 20 such transactions each second before lock waits and queueing; adding waiting clients cannot change that service time. Pair pool metrics with PostgreSQL transaction duration, locks, CPU, I/O, and query plans before increasing the pool.

### Drain and diagnose

Remove a pooler instance from new traffic before termination, then use a supported safe shutdown that waits for servers or clients according to the chosen rollout contract. PgBouncer documents PAUSE plus SHUTDOWN WAIT_FOR_SERVERS and SHUTDOWN WAIT_FOR_CLIENTS; session pooling can keep a drain open until clients disconnect. Inspect SHOW POOLS for active and waiting clients, active and idle servers, pool mode, and maximum wait. Use SHOW STATS for transaction, query, and wait time, then correlate with PostgreSQL active sessions, transaction duration, lock waits, connection errors, application pool saturation, Pod rollout, and database CPU or I/O. Restrict the admin console to approved operators and never place its credentials in a diagnostic example.

A drain deadline must match the application deadline. If a session-mode client can remain connected indefinitely, a graceful shutdown can also remain open indefinitely. The rollout policy needs a maximum wait and a documented result for work still attached when that wait expires.

## Case 3: durable workflows persist progress, not process lifetime

A durable workflow runtime records workflow and step progress so a new process can continue after the original process stops. The persisted record is the authority; a Pod, thread, or worker lease is temporary execution capacity. Give each workflow a stable identity, store completed step results or transaction boundaries, and make timers and queued starts recoverable rather than keeping them only in process memory.

Persistence narrows the retry boundary but does not make external effects exactly once. A step that calls a payment provider, object store, or another database still needs an operation ID, an idempotent API, or a reconciliation query. If a reply disappears after the effect commits, workflow history alone cannot infer the remote outcome. Record the uncertain state and resolve it before issuing another effect.

Deployments add a code-history problem. A workflow started under one code version may resume after several releases. The runtime and application need a policy for compatible code changes, pinned workflow versions, explicit migrations, or draining old executions. Retention is separate again: deleting completed history too early can break audit or deduplication, while retaining every step forever increases database cost and maintenance work.

Operate four mechanisms separately:

```text
process restart       → replace temporary execution capacity
workflow recovery     → resume from persisted workflow and step state
stuck-work repair     → detect work that is neither progressing nor safely complete
retention cleanup     → delete eligible completed history under policy
```

Health should prove that a worker can reach the durable store and is allowed to execute, not merely that its HTTP process answers. Metrics need bounded labels and should expose queue age, started and completed work, retries, stuck-work age, cleanup results, and database saturation. A cleanup loop also needs a batch limit, retry policy, owner, and a signal when it falls behind.

## Fictional case: recover a durable export workflow

The bookshop uses DBOS for a fictional `build_monthly_export` workflow. An API assigns a stable `export_id` and starts the workflow. Step one records the report parameters and database snapshot boundary. Step two writes the object to `exports/<export_id>.csv`. Step three records the checksum and marks the export available. Kubernetes supplies replaceable worker Pods, while DBOS stores workflow and step progress in PostgreSQL.

Suppose a worker writes the object and loses its database connection before it records completion. A restarted worker reads workflow history and reaches the same step again. The object key is deterministic, so the step first checks whether that key already contains the expected checksum. A match completes the step without another upload; a mismatch marks the workflow for repair instead of overwriting uncertain data. Persisted workflow progress narrows the retry boundary, while the object-store check resolves the external effect.

Keep the operating loops separate. Kubernetes readiness proves that a worker can reach the workflow database and accept work. A stuck-work scanner finds workflows whose progress age exceeds the written policy and sends them to an owned repair path. A retention job removes eligible completed history in bounded batches. A deploy either keeps code compatible with running histories or leaves old workers available until those histories finish. Every name and value in this case belongs only to this fictional example.

_Process restart, workflow recovery, stuck-work repair, and retention remain four mechanisms._

```text
API → start build_monthly_export(export_id) → persisted workflow record
step 1 → snapshot boundary
step 2 → deterministic object key + checksum check
step 3 → completion record

worker loss → replacement Pod → persisted step state → safe resume or repair
retention job → bounded deletion of eligible completed history
```

## Summary

Shared production services need small interfaces with explicit state and limits. Product names matter only after the caller and operator agree on acknowledgement, retry, ordering, capacity, recovery, and status.

- A platform interface owns validation, policy, quota, status, versioning, deprecation, and an escape route. Self-service does not transfer every underlying permission to the caller.
- Queues distribute claims, topics fan out, event buses route by rules, retained logs support independent replay, and durable workflows record multi-step progress.
- At-least-once delivery still needs a stable operation identity and an idempotent effect or reconciliation path.
- PgBouncer can accept more client connections than PostgreSQL server connections, but waiting clients remain queued work. Size every pool and rollout surge against one database budget.
- Transaction pooling changes the PostgreSQL session between transactions, so session state, advisory locks, temporary tables, and prepared-state assumptions need review.
- Durable workflow history survives process replacement. External effects, code evolution, stuck-work repair, database capacity, and retention remain application and operator responsibilities.
- The fictional export shows how persisted step state and an external-effect check work together after process loss.

## References

- [CNCF Platform Engineering Technical Community Group](https://contribute.cncf.io/community/tcgs/platform-engineering/)
- [Amazon SQS concepts and message lifecycle](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html)
- [Amazon SNS topics and fan-out](https://docs.aws.amazon.com/sns/latest/dg/welcome.html)
- [Amazon EventBridge buses, pipes, and schedules](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-what-is.html)
- [Amazon MSK concepts](https://docs.aws.amazon.com/msk/latest/developerguide/what-is-msk.html)
- [PgBouncer configuration](https://www.pgbouncer.org/config.html)
- [PgBouncer admin commands and statistics](https://www.pgbouncer.org/usage.html)
- [DBOS workflow tutorial](https://docs.dbos.dev/python/tutorials/workflow-tutorial)
- [DBOS workflow recovery](https://docs.dbos.dev/production/workflow-recovery)

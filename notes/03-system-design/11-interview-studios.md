---
title: System Design Interviews Through Nine Worked Designs
description: Run a system-design interview from scope through recovery, choose cloud and data technologies by responsibility, and study nine bounded designs with explicit calculations and failure paths.
slug: interview-studios
order: 11
identifier: SD11
duration: 6 hours
difficulty: Advanced
tags:
  - interview
  - worked-designs
  - trade-offs
  - capacity
  - failure
  - communication
---

## Working model

An interview design is a chain of falsifiable decisions. Every component needs a reason to exist, a limit, a failure mode, and a signal that tells an operator when the assumption stopped holding.

## Know what the interview is asking you to show

There is no single industry-wide system-design interview format. The interviewer may care more about product APIs, distributed data, cloud operation, or low-level capacity, and may redirect the discussion toward one of those areas. Google's non-abstract large-system design format, for example, asks candidates to make a specific large-scale design credible through capacity, reliability, robustness, provisioning, and change management. Amazon's current public SDE II page describes four 55-minute interviews in its loop, expects at least one software-system-design question, and tells candidates to ask questions that complete and validate the design; it names practicality, accuracy, efficiency, reliability, optimization, and scalability as objectives. That is one published company-and-level format, not a general rule.

Before an interview, ask the recruiter for the scheduled duration, whether design is a whole round or part of one, the expected level of detail, whether prompts lean toward product APIs or infrastructure, which drawing tool will be available, whether vendor-specific cloud knowledge is expected, and whether the round includes coding. If those details are unavailable, prepare a portable design first and translate components into AWS names only after their responsibilities are clear.

The common task is to turn an incomplete prompt into a defensible design while communicating with another engineer. Ask enough questions to define the important user actions, scale, correctness rules, latency, availability, geography, privacy, retention, and exclusions. Make assumptions visible when the interviewer does not supply them. Then draw and trace a small design before adding optional components.

The interviewer should be able to tell:

- Which requirement caused each major component to appear
- Which numbers set the first capacity boundary
- Where authoritative state lives and what consistency it promises
- What happens on a normal request, a retry, overload, and one named failure
- Which trade-off you accepted and what evidence would make you revisit it
- How the system is deployed, observed, recovered, secured, and changed

## Open by reframing the problem

Use the first minute to prove that you heard the prompt, not to display a memorized architecture. A useful restatement names the users, main action, result, and initial boundary:

> "I understand this as a service where internal product teams submit email or push notifications, the service applies recipient preferences and dispatches them, and callers can inspect status. I will keep template authoring and provider internals outside the first design unless you want either included. Is that the right boundary?"

The interviewer can now correct the actor, operation, or scope before those mistakes reach the diagram. Functional requirements describe what actors can do. Non-functional requirements, also called quality requirements, bound how the actions behave: latency, scale, availability, durability, consistency, privacy, recovery, and cost. Constraints are fixed facts such as an existing identity provider or one required cloud. Exclusions say what this design deliberately postpones.

Ask questions that can change an interface, state model, or operating policy. Explain the decision behind a question when it is not obvious.

| Ask about            | Example wording                                                                                             | Why the answer matters                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Primary actions      | "Which two user actions must work in the first version?"                                                    | Prevents secondary features from consuming the round and identifies the paths to trace |
| Completion           | "Does success mean accepted, durably stored, dispatched, or confirmed by the recipient?"                    | Places the response boundary and decides whether later work is asynchronous            |
| Correctness          | "Which duplicate, stale read, lost update, or out-of-order result would be harmful?"                        | Identifies idempotency, transaction, ordering, and consistency needs                   |
| Workload             | "What are average and peak rates, object sizes, connected clients, fan-out, and retention?"                 | Sets bandwidth, storage, concurrency, partition, and cache pressure                    |
| Quality              | "Which operation owns the latency and availability target, and what are the RTO and RPO?"                   | Prevents one global target from hiding different user promises                         |
| Geography and policy | "Where are users and data, who may access the data, and what must deletion remove?"                         | Changes placement, replication, identity, encryption, audit, and lifecycle             |
| Degraded mode        | "During overload or dependency failure, may we queue, serve stale data, drop low-priority work, or reject?" | Defines backpressure, load shedding, failover, and user-visible failure                |
| Existing constraints | "Which systems, protocols, team boundaries, or cloud products already exist?"                               | Distinguishes design freedom from an integration requirement                           |

Do not ask all eight groups when the prompt already supplied their answers. Start with the primary operation and the one correctness rule most likely to change the design, then collect the scale and quality targets needed for arithmetic. If the interviewer has no number, propose a round assumption, label it, and continue: "I will assume 10,000 peak writes each second so we can size the path; I can recalculate if you want another range."

Finish clarification by reading back a compact contract. For the example: submit email or push, apply preferences, expose status; template design and campaign analytics are out; requests peak at the agreed rate; accepted work is durable and safe to retry; urgent dispatch starts within its target; status has a retention rule; and the design covers one Region across several zones. Then move to estimates. This readback gives the interviewer one more chance to redirect the answer.

## Treat the interviewer as a design partner

Tell the interviewer what artifact you are producing: "I have the write path and authority; next I want to check the read path, then a failure." Pause after the first high-level diagram and ask which part deserves the deep dive. When redirected, connect the question to the current contract before adding detail. If asked about region loss, do not erase the original design; trace which boxes fail, what state survives, how traffic moves, and whether the stated RTO and RPO still hold.

An interruption can signal that enough detail has been shown. Summarize the decision in one sentence, record the open risk, and follow the new thread. If you disagree with a supplied constraint, state its cost once and design within it. The interview tests collaboration as well as recall.

## Use one practical 45-minute sequence

This is a useful interview sequence, not a rule that every company follows. Say where you are in the design, watch for interviewer cues, and shorten a phase when the prompt already supplies its output.

| Time          | Produce                   | Questions to answer                                                                         |
| ------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| 0-5 minutes   | Scope and exclusions      | Who uses it? What are the top operations? What is explicitly outside this design?           |
| 5-10 minutes  | Scale and quality targets | Peak reads and writes, object or event size, retention, latency, availability, RTO, and RPO |
| 10-17 minutes | API and data contract     | Request identity, pagination or streaming, main entities, keys, indexes, and invariants     |
| 17-29 minutes | High-level paths          | Client entry, compute, authoritative write, read path, async path, and response boundary    |
| 29-37 minutes | One deep dive             | The hardest storage, partitioning, fan-out, scheduling, or consistency problem              |
| 37-43 minutes | Failure and operation     | Overload, retries, failover, rebuild, security, deployment, signals, and cost driver        |
| 43-45 minutes | Recap and open risks      | Restate the contract, two main choices, one trade-off, and the next measurement             |

Do not spend the opening ten minutes collecting every imaginable requirement. Ask questions that can change the design. If the interviewer says to assume a number or move on, record the assumption and continue. If they interrupt with a failure, trace it against the design you already drew rather than beginning a second architecture.

## Nine systems expose different pressure points

Each prompt follows the same artifact order, while its workload and correctness rules force a different deep dive. A URL shortener is a useful small example for API, data, cache, and hot-key reasoning, but its boxes do not transfer unchanged to unrelated work.

| Prompt                             | Clarify before drawing                                                                                                               | Main pressure point                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Order, payment, and inventory      | When is an order accepted, may stock oversell, how are payment retries identified, and which steps may compensate?                   | Relational invariants, idempotency, locks or isolation, outbox, failover, and reconciliation                            |
| Social feed or activity history    | Who follows whom, is ranking required, how fresh must the feed be, and what happens for a celebrity account?                         | Fan-out on read versus write, partition keys, cache freshness, pagination, and hot users                                |
| Analytic dashboard and telemetry   | Which events arrive, how late or duplicated can they be, which dimensions are queried, and how fresh must results be?                | Kafka or another log, cardinality, ClickHouse ordering, parts, lag, retention, replay, and rebuild                      |
| Chat and presence                  | Are rooms or direct messages in scope, which order matters, how long may clients disconnect, and what does `online` mean?            | Long-lived connections, per-conversation order, delivery acknowledgement, presence expiry, fan-out, and reconnect state |
| Search and autocomplete            | What corpus is authoritative, which ranking or prefix behavior matters, how quickly must changes and deletions appear?               | Inverted indexes, derived-state freshness, sharding, top-k merge, cache keys, and projection rebuild                    |
| Notification service               | Which channels and priorities exist, does success mean accepted or delivered, and how do preferences, quotas, and quiet hours apply? | Fan-out, provider limits, duplicate-safe dispatch, scheduling, collapse rules, and status modeling                      |
| Large-object upload or file sync   | Who authorizes bytes, are resume and version history required, how are conflicts detected, and when is an upload complete?           | Direct object transfer, multipart state, checksums, immutable versions, metadata transactions, and cleanup              |
| Multi-tenant scheduler or workflow | Are jobs independent or multi-step, which resources and deadlines matter, how should tenants share capacity, and may work preempt?   | Durable progress, timers, leases, packing, fairness, retries, compensation, and noisy neighbors                         |
| Inference service                  | Which model and quality target apply, is streaming needed, what are prompt and output sizes, and what may be batched or rejected?    | Accelerator memory, batching, KV-cache pressure, admission, model routing, autoscaling delay, and tail latency          |

These designs cover common reasoning shapes rather than every possible interview question. Each includes a requirement change that invalidates the first architecture, such as strict order, a second Region, dominant-tenant traffic, zero RPO, or deletion from every derived copy. The resulting change shows which decisions follow from the contract.

## Keep cloud layers distinct

Cloud product names are useful only when their responsibilities are clear. The following distinctions prevent several common interview mistakes.

### Entry and network

- Route 53 is DNS. It maps names to endpoints and can participate in routing and health policy; it does not balance individual application requests after resolution.
- CloudFront is a content-delivery network and edge cache. AWS WAF evaluates web requests against rules. Neither replaces origin authorization or an origin capacity plan.
- An Application Load Balancer is an L7 HTTP/HTTPS entry that can route requests by application fields. A Network Load Balancer handles L4 TCP, TLS, UDP, and QUIC flows. API Gateway adds a managed API boundary with request, authentication, quota, and integration features; it is not merely another name for an ALB.
- A VPC is an isolated network boundary. Public and private subnets are routing choices, not security classifications by themselves. Route tables select paths; an internet gateway supports internet connectivity; a NAT gateway provides outbound translation for private IPv4 clients; security groups are stateful attachment-level filters and network ACLs are stateless subnet filters.

### Compute and containers

- EC2 provides virtual machines. An Auto Scaling group manages a fleet of instances from a launch definition and scaling policy. The team still owns the guest operating system, process supervision, rollout, and capacity choices.
- Lambda runs event- or request-triggered functions without a server fleet managed by the application team. It fits bounded, mostly stateless work whose runtime, concurrency, package, network, and invocation semantics fit the service limits.
- ECS is AWS's managed container orchestrator. It schedules task definitions and services. EKS is AWS's managed Kubernetes service. It supplies a Kubernetes control-plane boundary and API ecosystem, while the team still owns workload objects, upgrades and add-ons within its boundary, requests and limits, policies, and much of the data plane.
- Fargate is compute capacity for containers used with ECS or EKS. It is not a third orchestrator. EC2 and Fargate answer where container tasks or Pods run; ECS and EKS answer which orchestration API schedules and manages them.
- Kubernetes Services provide stable discovery for changing Pods. Gateway API or the older frozen Ingress API describes external application routing through an installed controller. A service mesh is optional infrastructure for service-to-service identity, policy, and traffic telemetry; add it only when those needs pay for its operating cost.

### Storage and data

- RDS manages supported relational engines; Aurora is an AWS relational option compatible with PostgreSQL or MySQL protocols and tooling. PostgreSQL and MySQL still have different storage, index, isolation, maintenance, and replication behavior underneath the managed boundary.
- DynamoDB is a managed key-value and document database whose table and index keys must serve known access patterns. Cassandra is a distributed wide-column database with explicit partition, consistency, compaction, repair, and tombstone concerns. Do not group them under a single 'NoSQL' choice without naming the access path.
- ElastiCache supplies managed cache engines such as Valkey, Redis OSS, or Memcached. A cache hit policy, eviction behavior, invalidation owner, and origin fallback still belong in the design.
- OpenSearch or Elasticsearch serves inverted-index search and related analytics. A vector index serves nearest-neighbor retrieval. Both are usually derived indexes unless the product contract deliberately makes one authoritative; define source position, staleness, deletion, and rebuild.
- ClickHouse and warehouse systems serve large columnar scans and aggregation. They do not replace an online transaction processing (OLTP) transaction merely because both accept SQL.
- S3 stores objects addressed by key. EBS provides block volumes to compute, and EFS provides a shared network file system. Object, block, and file access have different attachment, consistency, throughput, backup, and failure behavior.

### Messaging, streams, and workflows

- SQS is a managed work queue. SNS publishes to subscribers. EventBridge matches events against routing rules. Kinesis Data Streams and Kafka or Amazon MSK retain partitioned event streams for ordered consumption and replay. The correct choice follows ownership, fan-out, ordering scope, retention, throughput, replay, and operating model.
- Kafka 4.x uses KRaft controllers rather than ZooKeeper. A managed Kafka service owns more of the broker operation, but producers and consumers still own keys, partitions, acknowledgements, offsets, lag, schema, duplicate handling, and replay safety.
- Celery is a task execution framework that uses a broker; it is not itself a durable cloud queue or event log. State the broker, acknowledgement timing, retry identity, result ownership, worker shutdown, and poison-task policy.
- Step Functions, Temporal, and DBOS are examples of workflow or durable-execution systems. Airflow is aimed at scheduled data workflows. A queue distributes work; a workflow system also records progress, timers, branches, and recovery. Choose after defining how code and persisted history evolve across deployments.

### Security, operation, and delivery

- IAM roles and policies control AWS API authority. Workload identity should use temporary credentials where possible. KMS manages cryptographic keys; a secrets store manages secret values and rotation. Encryption does not replace authorization, data classification, or deletion policy.
- CloudWatch provides AWS metrics, logs, alarms, and related monitoring features. CloudTrail records AWS API activity for audit. OpenTelemetry supplies vendor-neutral application instrumentation. Name the user SLI and the resource, queue, replica, or source-position signals that explain it.
- Infrastructure as code records cloud resources and policy through tools such as CloudFormation, CDK, or Terraform. A deployment system still needs artifact identity, progressive exposure, migration ordering, rollback authority, and drift handling.
- An Availability Zone is a failure-isolation location inside a Region. Multi-AZ and multi-Region are different designs. State the failure being handled, data replication mode, traffic switch, quota and spare-capacity plan, RTO, RPO, and test method before drawing a second location.

## Carry a cloud interview checklist

After the first diagram, walk each boundary once. This catches missing production concerns without adding a box for every service you know.

- Geography and failure domains: Region, zones, data residency, latency, active-passive or active-active
- Network path: DNS, edge, L4 or L7 entry, public/private routing, egress, service discovery, deadlines
- Identity and data protection: user auth, service identity, least privilege, secrets, encryption, audit, deletion
- Compute: runtime unit, orchestration, requests and limits, autoscaling signal, cold start, draining, quotas
- State: authority, access paths, transactions, indexes, partitioning, replicas, backup, restore, schema change
- Async work: queue or log, event identity, ordering scope, acknowledgement, retry, DLQ, replay, catch-up
- Reliability: dependency failure, zone loss, corrupt write, overload, degraded mode, RTO, RPO, reconciliation
- Operation: SLI and SLO, logs/metrics/traces/profiles, deploy and rollback, capacity test, cost driver

For every named technology, be ready to answer: why is it here, who owns its state, what is its scaling unit, how does it fail, what quota or hot key limits it, how is it recovered, and what simpler option was rejected?

Before the recap, use the [reliability and observability review](10-reliability-observability.md) to look for an uncovered production concern. Ask who operates and changes the system, which identity can reach each resource, which failure and recovery promises were tested, where capacity stops meeting latency, what drives unit cost, and how much compute, storage, network, or accelerator time buys one successful outcome. These correspond to the operational, security, reliability, performance, cost, and sustainability views in AWS Well-Architected, but the questions apply without choosing AWS.

Do not claim that lower cost proves lower energy use or that autoscaling removes all waste. Name a measurable unit such as GPU-seconds per completed request or GB-months per retained account, keep correctness and SLOs beside it, and state the trade-off. Spare replicas may look inefficient until the zone-failure requirement is included; an idle fleet without a recovery or latency reason is simply unexamined capacity.

## Keep one decision ledger beside the diagram

Divide the page into requirements, assumptions, calculations, invariants, decisions, and open risks. Number important assumptions so later choices can point back to them. A box on the diagram should map to at least one workload need or correctness rule; otherwise remove it until a requirement earns its cost.

Trace two paths in full: the normal user operation and one failure or recovery operation. For each boundary, name the request or event identity, state read or written, deadline, retry owner, and response to overload. Then attach a signal to the claim. If the design says a queue absorbs bursts, queue age and drain rate must show whether it actually does. If replicas provide recovery, the answer needs a promotion rule and measured restore or failover time.

- Requirement evidence: quoted behavior, threshold, or exclusion
- Capacity evidence: units, peak shape, and a low-high range
- Correctness evidence: invariant plus atomicity or conflict rule
- Operating evidence: failure trigger, user signal, and recovery action

## Choose an engine only after writing its paid access paths

For every stateful component, write the authoritative operation, lookup key, ordered range, transaction boundary, peak read and write rate, expected data per key, retention, and freshness rule. Then trace the engine's physical work. A PostgreSQL index scan may fetch heap tuples and check MVCC visibility; an InnoDB secondary lookup may traverse the secondary B-tree and then the clustered primary key; a Cassandra read can reconcile memtables and several SSTables across replicas; a ClickHouse query prunes parts and granules, reads selected columns, and merges parallel aggregates.

Use PostgreSQL or MySQL when constraints, transactions, and mutable business records define the problem. Use a Cassandra-style wide-column table when the main operations are known-key writes and bounded ordered ranges inside a well-distributed partition key, and the team can operate repair plus compaction. Use ClickHouse when the hot path scans or aggregates selected columns across many rows and can consume an asynchronous projection. Object storage owns large immutable bytes; a search engine owns ranked inverted-index queries; a retained log owns replayable change history. None of these categories grants permission to skip backup, access control, schema evolution, or capacity work.

Reject the phrase 'NoSQL for scale' because it omits the access path and correctness contract. A relational system can partition and replicate; a wide-column store can fail on one hot partition; a columnar store can drown in tiny parts; and a cache can return stale state. The interview answer earns a database only when it states what the selected layout makes cheap, what it makes expensive, how it fails, and which measurement would trigger a change.

- Transactional row state: constraints, isolation, lock duration, WAL or redo, indexes, vacuum or purge, replica lag
- Wide-column ranges: partition size and heat, clustering order, consistency level, repair age, SSTables, tombstones
- Columnar analytics: selected columns, ORDER BY prefix, parts and granules, merge debt, query memory, freshness lag
- Derived stores: source position, rebuild procedure, deletion propagation, schema compatibility, comparison check

## Evidence standards for design review

A design review should point to material present in the answer. Confidence, diagram polish, and a familiar product name do not establish that a choice satisfies the contract.

| Review dimension                         | Evidence to record                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Framing and workload math                | Scope, exclusions, stated assumptions, peak shape, units, object sizes, retention, and calculations that set capacity          |
| Interfaces, data model, and correctness  | Request identity, API fields, authority, keys, indexes, transaction boundary, invariant, ordering scope, and conflict rule     |
| Scaling, performance, and cost           | Scaling unit, skew case, bottleneck, headroom, latency budget, paid resource, and a threshold that forces another design       |
| Failure and recovery                     | Named failure, ambiguous interval, retry owner, degraded mode, RTO, RPO, fencing rule, restore path, and recovery load         |
| Security and data policy                 | Principal, authorization decision, secret boundary, encryption owner, retention, deletion propagation, and audit evidence      |
| Operations, observability, and evolution | User SLI, causal resource signals, deploy and rollback rule, reconciliation check, schema change, and experiment that can fail |

An unsupported assertion leaves a gap even when the named technology could work. A supported choice names the requirement, mechanism, failure boundary, and observation that would disprove the assumption.

## Worked design: order API and analytics

Assume an order API peaks at 2,000 creates each second. Each order and its line items occupy about 2,000 bytes before indexes, WAL, replicas, and free space, producing 4 MB/s or 345.6 GB of raw business rows per day at a sustained peak. The product requires one order ID to be unique, inventory reservation and order state to commit together, and the client to retry an ambiguous timeout safely. Those invariants point to a relational transaction with a unique idempotency key and an outbox row in the same commit, not to a direct database write followed by a best-effort broker publish.

An L7 load balancer terminates client TLS, applies host and path routing, and sends requests only to ready application targets. With 20 targets, uniform peak rate is 100 creates per second per target before skew and retries. Losing five targets raises the average to about 133 per remaining target. If one proxy retry can add 10% attempts during failure, plan and load-test roughly 147 attempts per second per remaining target plus headroom. The shutdown path marks a target unready, drains connections, and ends only after in-flight transactions have finished or their clients can retry by operation ID.

The primary database commit emits WAL or redo for crash recovery. A standby replays the physical stream for failover, while CDC reads a logical stream and publishes outbox events. The distinction matters: promotion needs a fenced old writer and an acceptable data-loss position; CDC needs retained-log limits, idempotent delivery, and schema history. A consumer writes an order fact projection into ClickHouse in batches. The table ORDER BY begins with the common tenant and time filters, and the merge budget is tested against insert-part creation. Dashboard freshness is capture lag plus broker lag plus sink apply lag, not merely query latency.

Suppose the database generates 12 MB/s of log at peak and the CDC pipeline is down for 25 minutes. It needs at least 18 GB of retained log before overhead. If recovery applies at 42 MB/s while 12 MB/s continues to arrive, net catch-up is 30 MB/s and the ideal drain takes 600 seconds. A connector that applies only 12 MB/s never catches up. Alert on retained source bytes and oldest unpublished outbox event before disk pressure reaches the primary, and reconcile order IDs plus totals over the affected source-position range after recovery.

This design is not a template to copy unchanged. If inventory spans independent shards, if orders must accept writes in two regions during isolation, or if analytics must be current inside the order transaction, the invariant changes and so must the design. The interview move is to state that change explicitly, calculate its cost, and revise the path rather than adding a product name to the diagram.

_Keep raw data, provisioned storage, original requests, attempts, and retained-log bytes on separate lines._

```text
orders: 2,000/s * 2 KB = 4 MB/s = 345.6 GB/day raw
20 targets -> 100 creates/s each; 15 targets -> 133/s each
10% retry attempts after target loss -> about 147 attempts/s each
CDC outage: 12 MB/s * 1,500 s = 18 GB retained log
catch-up: 18,000 MB / (42 - 12 MB/s) = 600 s
```

The 2,000-create-per-second workload and target-loss calculation size the application path; the unique operation key, relational transaction, and outbox state the correctness boundary. The CDC retention and catch-up equations expose a recovery limit, while source bytes, oldest unpublished event, and order reconciliation provide operating checks.

## Worked design: document processing

Suppose users upload 1.2 million documents each day, the average object is 5 MiB, peak arrival is six times the daily average, processing may take from seconds to several minutes, and the user must be able to retry an upload without creating a second job. Raw input is about 5.72 TiB per day. Average arrival is about 13.9 files each second and the stated peak is about 83.3 files each second, or roughly 417 MiB/s of input payload. The API tier should not relay all of those bytes through its own memory and connections merely to reach object storage.

The client first creates an upload record with an operation ID. The service authorizes the requested tenant and object size, writes an expected object key plus pending state, and returns time-bounded multipart-upload authority. The client uploads parts directly to S3 with a full-object checksum and completes the upload. A lifecycle rule stops old incomplete multipart uploads. The service must still verify that the completed key, owner, size, checksum, and upload record agree before treating the object as accepted.

An object notification or explicit completion call places a job on SQS. S3 Event Notifications are designed for at-least-once delivery and do not guarantee event order, so the worker treats `(bucket, key, version or sequencer, processing_version)` as an input identity and advances metadata with a conditional state transition. Duplicate delivery becomes a no-op or resumes an incomplete stage. A dead-letter queue has an alarm, inspection owner, retention window, and redrive rule; it is not the primary retry scheduler.

Compute follows the work rather than fashion. A short bounded transform may fit Lambda. A long process, custom runtime, large scratch space, GPU, or tighter scheduling need can fit ECS tasks or EKS Jobs on EC2 or Fargate capacity, subject to the selected runtime's device and storage support. Choose EKS when Kubernetes APIs, ecosystem, portability, or an existing platform justify its control-plane and add-on work; choose ECS when AWS-native task and service orchestration meets the contract with less platform surface.

Metadata can live in PostgreSQL when tenant quotas, job state, billing rows, and output publication need relational constraints and transactions. A DynamoDB design can work when operations are known-key conditional transitions and its partition plus index model serves every required lookup. Large source and result bytes remain in object storage. Search or vector indexes are derived only after scanning and policy checks; carry source object identity and processing version so they can be rebuilt or deleted.

The status API returns the current state and a stable cursor for logs or pages of results. Polling is often sufficient; server-sent events can reduce repeated reads for a one-way progress feed. WebSocket is earned only if the product needs bidirectional session traffic. Every path needs tenant authorization, short-lived workload identity, encryption keys, malware or parser isolation for untrusted files, bounded egress, log redaction, and deletion propagation.

Failure review crosses the other modules: object bytes can arrive without metadata confirmation, the queue can repeat an event, a worker can die after writing output, a GPU node can disappear, a parser can exhaust memory, and a new model can change output semantics. Record stage identity and version, write outputs under immutable keys, publish the final visible pointer conditionally, and compare oldest job age with stage throughput. Recovery tests should replay a bounded source range without overwriting a newer result.

_The workload values are interview assumptions. Keep binary object units separate from decimal request rates and measure real compression plus protocol overhead._

```text
1,200,000 / 86,400 = 13.9 files/s average
13.9 * 6 = 83.3 files/s peak
1,200,000 * 5 MiB = about 5.72 TiB/day raw input
83.3 * 5 MiB = about 417 MiB/s peak payload
```

Related notes: [cloud compute choices](../01-cloud-infrastructure/06-eks-and-ecs.md), [block, object, and file I/O](../02-low-level-infrastructure/04-storage-and-io.md), [inference serving lifecycle](../04-ai-inference/02-serving-lifecycle.md), and [tool and sandbox boundaries](../05-harness-engineering/04-tools-environments-and-sandboxes.md).

The 5.72-TiB daily volume and 417-MiB/s peak explain direct object upload; the operation ID, checksum, object version, and conditional publication define retry and visibility rules. A bounded replay that cannot overwrite a newer result tests queue duplication, worker loss, and projection recovery.

## Worked design: telemetry ingestion

Suppose the stated 2 million events per second average 400 bytes before broker overhead and replication. Ingress payload is about 800 MB/s. One day contains 69.12 TB and seven days contain 483.84 TB of raw event bytes. Keep compression, indexes, replicas, and spare capacity separate because each has a different measured multiplier. This arithmetic immediately asks whether all seven days belong in one hot serving tier.

Assign every event an event_id and tenant_id. A partition value based only on tenant_id preserves per-tenant order but lets one large tenant own a partition, so define a threshold that moves that tenant to tenant_id plus a stable bucket while documenting the reduced ordering scope. Producers receive an explicit overload response; consumers commit progress only after an idempotent state transition. Replay uses retained positions at a capped rate that leaves capacity for live ingestion.

A ten-minute ingestion RTO needs a spare path or a tested fleet start and ownership-recovery sequence. State the RPO for acknowledged events, map replicas across failure domains, and monitor accepted rate, rejected rate, partition skew, oldest unprocessed age, retry attempts, dead letters, and storage saturation. These signals let another engineer challenge the design and verify its recovery behavior.

_The 400-byte input is a stated assumption for this example, not a property of telemetry events in general._

```text
2,000,000 events/s * 400 bytes = 800 MB/s
800 MB/s * 86,400 s = 69.12 TB/day
69.12 TB/day * 7 = 483.84 TB raw
provisioned bytes = raw * measured multipliers + headroom
```

The 800-MB/s ingress rate and 483.84-TB raw retention estimate expose storage and broker scale. Stable event identity, a hot-tenant bucketing threshold, explicit overload, capped replay, stated RTO and RPO, partition skew, oldest unprocessed age, and saturation signals make the normal and recovery paths testable.

## Six additional worked designs

The order, document-processing, and telemetry sections above are the three longest designs. The six sections below use a more compact form while retaining clarification, a contract, arithmetic, an interface and state model, normal and failure traces, alternatives, and a requirement that invalidates the first architecture.

### Worked design: social feed and activity history

**Clarification.** The main choices are whether this is a feed of followed authors or only the user's activity, whether order is chronological or ranked, how quickly posts and deletions appear, and whether private accounts, follow changes, or celebrity authors are included. These answers decide whether a stored timeline is authoritative, derived, or only a candidate set.

**Functional and non-functional requirements.** Users create posts, follow or unfollow authors, and read a cursor-paginated feed. This design assumes a retry-safe post create, chronological ordering, read p95 below 200 ms, ordinary-post freshness below five seconds, deletion filtering within one minute, and no lost accepted post. Ranking and advertising are outside the first design.

**Illustrative sizing.** Assume 50 million daily active users, two posts and 20 feed reads per user each day, a ten-times peak factor, and 200 followers for an ordinary author. These are illustrative inputs, not measured product facts.

```text
posts: 50M * 2 / 86,400 = 1,157/s average; 10x peak = 11,574/s
reads: 50M * 20 / 86,400 = 11,574/s average; 10x peak = 115,741/s
ordinary fan-out peak: 11,574 posts/s * 200 followers = 2.31M timeline inserts/s
one 50M-follower author = 50M inserts for one post, so the average-follower plan is unsafe
```

**API and minimal data model.** `POST /v1/posts` carries `operation_id` and content; `PUT` or `DELETE /v1/follows/{author_id}` changes the graph; `GET /v1/feed?after=<cursor>&limit=50` returns a stable `(created_at, post_id)` cursor. `Post(author_id, post_id, created_at, version, deleted_at)` is authoritative. `Follow(follower_id, author_id)` records the graph. `TimelineEntry(viewer_id, rank_time, post_id)` is a rebuildable projection with a unique `(viewer_id, post_id)` constraint.

**Normal and failure trace.** A post transaction writes `Post` and an outbox event. Workers insert timeline entries for ordinary authors; a feed read obtains IDs, batch-fetches posts, and filters tombstones and current visibility. Celebrity posts are merged from a small followed-author candidate set at read time. If a fan-out worker dies after writing some entries, the retained event is retried and the unique key makes repeated inserts harmless. Oldest fan-out age measures freshness. A deletion tombstone is checked on every read so a delayed projection cannot resurrect content.

**Technology alternatives and trade-offs.** Fan-out on write makes ordinary reads cheap but multiplies writes and creates celebrity spikes. Fan-out on read avoids write amplification but makes each read gather and merge many author streams. A hybrid uses stored timelines for ordinary authors and read-time merge for hot authors, at the cost of two paths and a hot-author classification policy. The partition and hot-key mechanics are developed in [partitioning, replication, and hot keys](05-partitioning-replication-hot-keys.md).

**Changed requirement that invalidates the first design.** If ranking must use the viewer's current session, inventory, and recent actions, a precomputed chronological timeline is no longer the final answer. Keep it as a candidate source, add an online ranker, version the features and model, and remeasure the latency budget.

The chronological-feed boundary frames the design; the 2.31-million-insert estimate and celebrity counterexample expose scale and skew. The operation ID, unique projection key, deletion tombstone, retry path, and oldest fan-out age cover correctness, recovery, and freshness.

### Worked design: multi-Region chat and presence

**Clarification.** The design must choose direct messages, rooms, or both; global, per-conversation, or per-sender order; the durability meaning of `accepted`; offline duration; and whether presence is exact or an expiring hint. User geography, Region-loss RTO and RPO, and write behavior during a network partition set the regional architecture.

**Functional and non-functional requirements.** Clients connect, send messages, receive conversation-ordered messages, acknowledge delivery or read state, and reconnect from a sequence. Presence is a best-effort lease. Assume two Regions, half of normal connections in each, p95 local send acknowledgement below 200 ms, 99.99% monthly availability, RTO at most two minutes, and RPO at most five seconds for a complete home-Region loss. Acknowledged messages are durable across zones but replicate asynchronously to the paired Region.

**Illustrative sizing.** Assume ten million connected users, 50 messages per connected user per day, 500 bytes per stored message, an eight-times message-rate peak, and 20,000 open sockets per gateway unit.

```text
messages: 10M * 50 / 86,400 = 5,787/s average; 8x peak = 46,296/s
peak payload: 46,296/s * 500 bytes = 23.1 MB/s before protocol and replicas
retained bytes: 500M/day * 500 bytes = 250 GB/day raw
gateways: 10M / 20,000 = 500 units; normally 250 per Region
after one Region fails, the survivor needs room for all 500 units, or excess clients need a polling mode
```

**API and minimal data model.** A WebSocket command `send {conversation_id, client_message_id, body}` and `GET /v1/conversations/{id}/messages?after_seq=N` support send and recovery. `Conversation(id, home_region, writer_epoch, next_seq)` identifies one writer. `Message(conversation_id, seq, client_message_id, sender_id, payload, created_at)` is unique by both sequence and client identity. `Receipt(conversation_id, seq, user_id, state)` records delivery or read progress. `Presence(user_id, region, expires_at)` is an expiring hint, not durable truth.

**Normal and failure trace.** The nearest gateway authenticates the client and routes a send to the conversation's home Region. The writer may commit only while it holds an unexpired authority lease from the quorum control store; the lease names the current `writer_epoch`. A zonally durable transaction validates that epoch, checks `client_message_id`, assigns the next sequence, writes the message and outbox, then acknowledges it. A writer that cannot renew stops before its lease expires. Fan-out reaches connected recipients; an offline client resumes after its last sequence. The message log and deduplication state stream asynchronously to the paired Region.

If the home Region is lost, promotion waits until the old authority lease is positively revoked or certainly expired, waits for the secondary's selected replication position, acquires a higher writer epoch in the surviving quorum control store, and changes routing. The old writer cannot obtain or validate authority with its stale epoch; a delayed old-epoch write or replication record is rejected by the new authority. This wait belongs inside the two-minute RTO and is why a lease duration cannot be chosen independently of recovery.

Clients reconnect with their last sequence. A client whose acknowledged message fell inside the declared five-second RPO may resend the same `client_message_id`; old-epoch records discovered later are reconciled without becoming a second visible sequence. Presence expires and rebuilds from live connections.

The survivor either has the calculated socket capacity or shifts excess clients to bounded polling and reconnect. Presence and typing indicators are shed before message delivery. The recovery terminology and tests come from [SD10](10-reliability-observability.md); this brief applies them rather than repeating that note.

**Technology alternatives and trade-offs.** A home-Region relational or partitioned log with asynchronous cross-Region replication gives simple per-conversation order and low local latency, but accepts nonzero RPO. A globally replicated consensus database can provide RPO zero for committed messages, but every write pays quorum placement and wide-area failure costs. A multi-leader Cassandra-style design keeps local writes available, but conflicting conversation order needs explicit reconciliation and a weaker contract.

**Changed requirement that invalidates the first design.** RPO zero plus writes accepted in both Regions during an inter-Region partition invalidates the asynchronous single-home writer. The design cannot preserve one total conversation order and accept both isolated sides. Choose a quorum that rejects the minority, or weaken ordering and reconcile conflicts; say which product promise changed.

The design names the ordering scope, accepted boundary, writer epoch, socket failover capacity, retry identity, RTO, RPO, and degraded mode. A failover drill measures route-switch time, lost acknowledged sequences, stale-writer rejection, reconnect success, and oldest replication lag.

### Worked design: search and autocomplete

**Clarification.** The design needs one source of truth and an explicit retrieval contract: keyword search, prefix completion, fuzzy matching, semantic retrieval, or a combination. Ranking fields, edit and deletion freshness, tenant isolation, permission filtering, language, and personalization determine the index and query paths.

**Functional and non-functional requirements.** Users search a tenant's document corpus and request autocomplete suggestions; source writes remain in the document system. Assume search p95 below 100 ms, suggestion p95 below 50 ms, ordinary edits visible within 60 seconds, deletions filtered within five minutes, stable cursor pagination, and a fully rebuildable index. The first design uses lexical ranking and tenant isolation, not semantic search.

**Illustrative sizing.** Assume 100 million documents averaging 2 KB of searchable source text, an index measured at 1.5 times source size, one redundant serving copy, 30,000 search sessions each second, five suggestion prefixes per session, and two million document changes each day.

```text
source text: 100M * 2 KB = 200 GB raw
primary index: 200 GB * 1.5 measured ratio = 300 GB
primary plus one serving copy: 300 GB * 2 = 600 GB before headroom
suggestions: 30,000 sessions/s * 5 prefixes = 150,000 requests/s
changes: 2M / 86,400 = 23/s average; 10x peak assumption = 231/s
```

**API and minimal data model.** `GET /v1/search?q=...&tenant_id=...&after=<cursor>` and `GET /v1/suggest?prefix=...&tenant_id=...&locale=...` expose the read paths; the authenticated identity must be authorized for that tenant. `Document(id, tenant_id, version, title, body, deleted_at)` remains authoritative. A change event carries `document_id`, `version`, operation, and source position. The index stores searchable fields, tenant, version, visibility attributes, and a deterministic tie-break key; the cursor encodes the index generation and last sort tuple rather than an offset.

**Normal and failure trace.** A source transaction writes the document and outbox. A version-aware indexer applies the change. The query coordinator sends work only to relevant shards, merges shard top-k results, and caches suggestions by tenant, locale, prefix, and index generation. If one shard process fails, a replica serves it; if the indexer pauses, source-position lag exposes stale results. A tombstone prevents a late older event from restoring a deletion. Recovery builds a new index generation from a consistent source position, catches up changes, compares counts and sampled queries, then switches an alias.

**Technology alternatives and trade-offs.** OpenSearch or Elasticsearch supplies inverted indexes, relevance ranking, fuzzy matching, and distributed top-k, with shard sizing, heap, merge, and refresh work to operate. A relational prefix index or in-memory trie is simpler for bounded prefix completion, but does not provide the same ranking and full-text behavior and may require a large rebuildable memory image. The authority-versus-projection distinction is developed in [storage and data modeling](03-storage-data-modeling.md).

**Changed requirement that invalidates the first design.** If an access revocation must affect every result in under one second, a five-minute derived-index deletion window and shared suggestion cache are invalid. Either enforce authorization against current source state on every result, or propagate permission versions synchronously and include them in index and cache keys; then remeasure latency and cache hit rate.

The source-of-truth boundary, freshness contract, 150,000-request-per-second suggestion path, index-copy math, stable cursor, event version, and rebuild position define what the system must preserve. Access tests, source-position lag, count comparisons, and sampled queries decide whether a new index generation is safe.

### Worked design: notification service

**Clarification.** Channels, priorities, and the meaning of success determine the delivery contract. The design also fixes where preferences, quiet hours, suppression lists, and tenant quotas are evaluated, whether retries may duplicate a message, and whether notifications can be scheduled, collapsed, cancelled, or ordered across channels.

**Functional and non-functional requirements.** An authenticated tenant submits email or push notifications, reads status, and cancels work that has not begun. The service evaluates the recipient's current preferences at dispatch time. Assume accepted work is durable and retry-safe, urgent work starts dispatch within five seconds at p95, the acceptance API is 99.99% available, internal delivery is at least once, provider calls use duplicate protection when available, and status is retained for 30 days.

**Illustrative sizing.** Assume 100 million logical notifications per day, a twenty-times peak over the daily average, and 1.4 channel deliveries per logical notification. Treat 5,000 attempts each second as an example measured limit for one independent provider quota unit.

```text
logical average: 100M / 86,400 = 1,157 notifications/s
logical peak: 1,157/s * 20 = 23,148/s
channel-attempt peak: 23,148/s * 1.4 = 32,407 attempts/s
independent 5,000/s quota units: ceil(32,407 / 5,000) = 7
seven workers do not create seven quota units when the provider enforces one account-wide limit
```

**API and minimal data model.** `POST /v1/notifications` carries `operation_id`, recipient, template version, parameters, channels, priority, and optional `schedule_at`; `GET /v1/notifications/{id}` returns per-channel status; `POST /v1/notifications/{id}/cancel` records a conditional cancellation. `Notification(id, tenant_id, operation_id, recipient_id, template_version, priority, schedule_at, state)` is unique by tenant and operation. `Delivery(notification_id, channel, attempt_count, provider_id, state, next_attempt_at)` is unique by notification and channel. `Preference(recipient_id, version, channels, quiet_hours)` and an outbox complete the minimum state.

**Normal and failure trace.** One transaction deduplicates the operation, stores the notification, and publishes work through an outbox. A scheduler releases due work. A channel worker re-reads preferences, checks cancellation and a tenant-plus-provider rate budget, then calls the provider with a stable idempotency key. Provider receipts update `Delivery`; destination data and message parameters are redacted from logs, and each worker can read only its channel secret.

If the provider accepts a request but its reply is lost, the worker retries with the same provider key or queries by provider ID. If the provider offers neither facility, the contract must admit possible duplicates and reconciliation must prefer delayed status over blind rapid retries. Exponential backoff has a maximum attempt count. A dead-letter queue has an owner, alarm, retention, inspection path, and controlled redrive. Provider outage may route to another provider only when sender identity and duplicate semantics remain valid.

**Technology alternatives and trade-offs.** SQS queues per channel provide managed visibility timeouts, redrive, and simple competing consumers, but replay and cross-channel inspection need separate state. Kafka retains an ordered, replayable stream and scales consumer groups, but the team owns partitions, offsets, lag, and safe replay. A workflow engine is worth the extra state-machine surface when one notification has timers, approval, escalation, or several dependent steps. The delivery distinctions are developed in [asynchronous and streaming designs](07-async-streaming-designs.md).

**Changed requirement that invalidates the first design.** Strict per-recipient order across email and push invalidates independent channel queues. Route a recipient through one sequencer or durable workflow, persist the cross-channel sequence, and accept lower parallelism and head-of-line blocking; otherwise weaken the order promise.

The accepted-versus-delivered boundary, peak provider-attempt calculation, stable operation and provider keys, dispatch-time preference check, and ambiguous-reply trace state the contract. Queue age, dispatch latency, quota rejection, duplicate rate, dead-letter age, and provider-receipt lag expose failure.

### Worked design: multi-tenant scheduler and workflow

**Clarification.** Jobs may be independent or made of dependent steps, and their CPU, memory, accelerator, locality, deadline, and runtime distributions determine placement. The contract also states whether a task may run more than once, be preempted, or make an irreversible external call; how tenants share capacity; what cancellation means; and whether a completed step may require compensation.

**Functional and non-functional requirements.** Tenants submit jobs, inspect progress, cancel pending work, and receive durable step results. The scheduler releases a step only after its dependencies finish, enforces per-tenant quotas and weighted fairness, and retries a lost attempt without losing accepted work. Assume dispatch starts within ten seconds at p95 when quota and capacity exist, scheduler control is highly available across zones, and every external side effect has an operation identity or reconciliation path.

**Illustrative sizing.** Assume 500 tenants, two million jobs per day, a ten-times peak arrival rate, an average runtime of 120 seconds, and an average request of one CPU plus 2 GiB of memory. The workload distribution, not this mean, must drive a production packing simulation.

```text
arrival: 2M / 86,400 = 23.1 jobs/s average; 10x peak = 231 jobs/s
Little's Law at a sustained peak: 231/s * 120 s = 27,720 concurrent jobs
illustrative demand: 27,720 CPU and 55,440 GiB, about 54.1 TiB of memory
add queueing, p95 runtime, fragmentation, failure reserve, and tenant skew from measurements
```

**API and minimal data model.** `POST /v1/jobs` carries `operation_id`, steps, dependencies, resource requests, priority, and deadline; `GET /v1/jobs/{id}` returns step and attempt state; `POST /v1/jobs/{id}/cancel` records the desired terminal state. `Job(id, tenant_id, operation_id, state, priority, created_at)` is unique by tenant and operation. `Step(job_id, step_id, dependency_count, resource_request, state)` describes the graph. `Attempt(step_id, attempt_no, lease_epoch, lease_expires_at, worker_id, state)` identifies execution. `TenantQuota(tenant_id, cpu, memory, weight)` bounds admission.

**Normal and failure trace.** A transaction stores the job graph and marks dependency-free steps runnable. Weighted fair admission chooses among tenant queues only when the resource pool can fit the request. A worker conditionally acquires a time-bounded attempt lease, heartbeats it, performs work with the step operation ID, and conditionally commits completion under the same lease epoch. Completion releases dependent steps. A cancellation prevents new leases and signals running workers; it does not claim to undo an external effect already committed.

If a worker dies, its lease expires and a new attempt starts with a higher epoch. A stale worker cannot publish the visible result. If the scheduler leader fails, another leader acquires a fenced control lease and reconstructs runnable work from durable state. An ambiguous external side effect is queried by operation ID before retry. Oldest runnable age by tenant, admission delay, lease-expiry rate, wasted attempt time, resource fragmentation, and fairness share reveal different failures.

**Technology alternatives and trade-offs.** PostgreSQL workers using conditional row locks such as `SELECT ... FOR UPDATE SKIP LOCKED` can be a small transactional scheduler for modest throughput, but hot runnable indexes and polling contend as the queue grows. A queue plus a state database separates dispatch throughput from job history, but fairness, leases, and dependency release remain application responsibilities. Temporal or another durable workflow engine records timers and step history; Kubernetes Jobs provide workload execution. Neither alone supplies every fairness and packing policy. [Control planes and schedulers](09-control-planes-schedulers.md) develops those boundaries.

**Changed requirement that invalidates the first design.** A job that needs 64 GPUs on one high-bandwidth topology and must start all workers together invalidates independent per-step leases and average-resource packing. Add topology-aware inventory, reservation, gang admission, atomic start or rollback, and a starvation policy; then size against whole-job shapes rather than average CPU and memory.

The admission contract, concurrency equation, stable operation identity, lease epoch, stale-worker fence, fair-share boundary, and external-effect recovery explain the main choices. A replay can kill a worker and scheduler leader while checking that no newer result is overwritten and no tenant exceeds its configured share.

### Worked design: inference service

**Clarification.** The required model version, quality threshold, response mode, prompt and output distributions, context length, time to first token, and token-spacing targets define the serving path. The contract also states whether the system may batch requests, quantize weights, route to another model, reject overload, or retain prompts, plus which hardware exists and how quickly a replica loads.

**Functional and non-functional requirements.** Authenticated tenants submit generation requests, stream tokens, select an allowed model version, and receive usage. Assume p95 time to first token below 800 ms, p95 inter-token spacing below 40 ms, 99.9% availability, explicit `429` overload before an admitted request misses its budget, and no silent model downgrade. Prompts are not written to application logs; quota and billing are retry-safe by request ID.

**Illustrative sizing.** Assume an 8-billion-parameter model with 16-bit weights, one 80 GiB accelerator per replica, 20 GiB reserved for runtime buffers and safety, a measured 0.5 MiB of KV cache per active token for this exact model and engine, 2,000 active tokens per request, 120 requests each second, 200 output tokens per request, and a replay benchmark of 6,000 compliant output tokens each second per replica. Every value is illustrative and must be replaced by artifact inspection and profiling.

```text
weights: 8B parameters * 2 bytes = 16 GB, about 14.9 GiB
KV budget: 80 GiB - 14.9 GiB - 20 GiB = 45.1 GiB; round down to 44 GiB
KV per request: 2,000 tokens * 0.5 MiB = 1,000 MiB, about 0.98 GiB
memory-only concurrency bound: 44 / 0.98 = about 45 active sequences
output demand: 120 requests/s * 200 tokens = 24,000 output tokens/s
replicas: ceil((24,000 * 1.25 headroom) / 6,000) + 1 failure reserve = 6
```

Five replicas cover the measured demand with 25% headroom; the sixth preserves that capacity after one replica loss. This is not a latency guarantee. Continuous batching, prompt lengths, memory fragmentation, network transfer, and the slowest allowed output length must be replayed together.

**API and minimal data model.** `POST /v1/generations` carries `request_id`, `model_version`, input, `max_output_tokens`, sampling parameters, and `stream=true`; the stream returns token events followed by usage or a terminal error. `ModelVersion(id, artifact_digest, tokenizer_digest, format, state)` fixes artifact identity. `Deployment(model_version, hardware_class, engine_version, replica_count)` fixes the serving cohort. `AdmissionBudget(tenant_id, request_tokens, concurrent_tokens, rate)` bounds work. `Usage(request_id, input_tokens, output_tokens, billing_state)` is unique by tenant and request.

**Normal and failure trace.** Entry authenticates the tenant, loads the declared tokenizer, reserves a token budget, and routes only to a ready replica with the requested model digest. The replica admits the sequence to a continuous batch, streams tokens, and finalizes usage before releasing the budget. Queue delay, time to first token, token spacing, active tokens, KV utilization, batch composition, rejection rate, model-load time, and tokens per accelerator-second connect the user SLO to capacity.

If a replica dies before any token reaches the client, the router may retry the same request ID on another replica and deduplicate usage. After the client observes tokens, the service does not pretend a transparent retry is exactly once: it closes the stream with a resumable product error or starts a separately identified regeneration. Overload is rejected before admission; repeatedly evicting KV state to accept more work would only move failure into tail latency. A bad model cohort is drained by digest while the last known good cohort retains capacity.

**Technology alternatives and trade-offs.** A self-operated GPU pool with Kubernetes and an engine such as vLLM exposes batching, model placement, and accelerator utilization, but the team owns device scheduling, drivers, loading, failure reserve, and rollout. A managed model endpoint removes much of that operating surface, but offers less control over batching and placement and may expose coarser cost and performance signals. Pick from measured workload needs, not from the presence of a GPU. [Inference serving lifecycle](../04-ai-inference/02-serving-lifecycle.md) develops the runtime path.

**Changed requirement that invalidates the first design.** A 70-billion-parameter model at 16 bits needs about 140 GB for weights before KV cache and runtime buffers, so the single-80-GiB-device replica is invalid. Use a measured quantized artifact or a tensor-parallel multi-GPU replica with gang placement and a fast interconnect; recalculate throughput, failure reserve, loading time, and the number of whole replica groups.

The quality and overload contract, weight and KV-cache equations, token-rate benchmark, failure reserve, fixed model and tokenizer identities, and pre-stream versus mid-stream failure behavior support the six-replica plan. A load replay followed by one replica kill tests whether that floor still meets the token and latency targets.

## Evidence gaps drive the next revision

After reviewing a design, choose the least-supported dimension and add one missing artifact: perhaps a peak-rate calculation, deduplication constraint, authorization rule, restore objective, partition-skew plan, cost unit, or canary abort signal. Then rerun the request or failure trace affected by the change. Keep the earlier version so the reason for the revision remains visible.

## Recognize answers that sound complete but cannot be tested

> **Premature product selection.** Naming a database, queue, or cloud product before stating the access pattern and invariant is a selection guess, not a design decision.

A design is under-specified when it says 'add a cache' without identity or freshness, 'use a queue' without delivery and lag policy, or 'shard the database' without a routing value and hot-owner plan. The same problem appears when every dependency retries, replicas share a deploy cohort, backups lack a restore result, or a global average replaces the busiest tenant and slowest percentile.

Counterexamples expose unsupported decisions. One tenant might send 30% of traffic, a reply can disappear after commit, a consumer can remain down for two hours, or the newest release can corrupt every replica. A complete design records the resulting behavior, the signal that detects it, and the change that follows. A choice without a measurable condition remains an assertion even when the named technology could work.

A revision changes the artifact, not merely the explanation. It can add a missing cursor field, deduplication constraint, capacity line, failure-domain boundary, abort metric, or restore step, then rerun the relevant request or failure trace against that change.

## Running design: assemble the ledger

The running order-and-notification case now fits on one decision sheet. Each row names the requirement that caused the mechanism; removing that requirement should make the design simpler.

| Concern     | Final decision                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Contract    | 1,000 average and 5,000 peak creates/s, 20,000 peak reads/s, 30 hot days, p99 create below 250 ms                                    |
| Interface   | Four tenant-scoped operations, one-second deadline, stable create and transition identities                                          |
| State       | PostgreSQL authority with order, line, operation-result, and outbox records; object archive and ClickHouse projection remain derived |
| Ownership   | 64 shards with three zonal copies; the 20% hot tenant uses eight order-ID buckets                                                    |
| Correctness | Version-checked status changes and an atomic outbox; relay and consumers tolerate duplicate delivery by `event_id`                   |
| Async work  | 5,000 notification events/s, 7,500/s worker capacity, 30-second leases, five attempts, then dead letters                             |
| Protection  | Five-minute terminal-receipt cache, 30,000-RPS admission ceiling, 250-entry create queue, priority shedding                          |
| Operation   | 75 ready workers on six nodes across three zones; event age and achieved throughput govern reconciliation                            |
| Recovery    | Active-passive regional fencing with a 15-minute RTO and 30-second RPO, tested through business IDs                                  |

An interviewer can now perturb one requirement and watch the ledger change. If the regional RPO becomes zero for every acknowledged order, the asynchronous regional copy no longer satisfies the contract. The design must wait for cross-region durability or use a consensus authority before replying, then recalculate the 250 ms p99 budget from measured inter-region latency and state what happens when the regions cannot communicate. Sharding, queue retries, and receipt caching do not solve that change. This is the point of the ledger: it exposes exactly which decisions a new requirement invalidates.

## Summary

A strong system-design interview answer is a chain of testable decisions: scope the workload, state invariants, calculate scale, trace one request and one failure, and revise the weakest assumption. Product names count only after their physical access paths and operating costs match the contract.

- **Open with a corrected contract, then use the clock.** Restate the actor, operation, outcome, and boundary; ask questions that can change correctness, scale, or failure behavior; read back functional requirements, quality targets, constraints, and exclusions. A useful 45-minute sequence then moves through estimates, API and data, high-level paths, one deep dive, failure and operation, and recap.
- **Keep cloud responsibilities separate.** DNS, CDN, WAF, L4/L7 entry, compute, orchestration, capacity, storage, messaging, identity, and telemetry solve different problems. ECS and EKS orchestrate; EC2 and Fargate supply capacity; SQS queues work; Kafka or MSK retains partitioned history; S3, EBS, and EFS provide object, block, and file access.
- **Select storage by paid work.** Compare PostgreSQL heap and MVCC access, MySQL/InnoDB clustered-primary and secondary lookups, Cassandra partition/SSTable reconciliation, and ClickHouse part pruning and column reads against the required point lookups, ranges, transactions, retention, and freshness.
- **Trace a write across every boundary.** For an order API, follow DNS and the L4 or L7 load balancer, admission, idempotent API handling, relational transaction, WAL or binlog durability, outbox publication, CDC or broker delivery, and analytic projection. Name what happens when the reply, event, consumer, or replica fails.
- **Keep OLTP and analytics contracts distinct.** Unique order identity and inventory reservation favor a relational transaction; a columnar ClickHouse projection can serve large scans after a defined lag. CDC should bootstrap from a consistent snapshot plus log position, and consumers must tolerate duplicate delivery.
- **Let arithmetic challenge the diagram.** At 2,000 creates/s and 2,000 bytes each, raw writes are 4 MB/s before indexes, logs, replicas, and headroom. At 2 million 400-byte events/s, ingress is about 800 MB/s and seven raw days are about 483.84 TB.
- **Follow a cross-module path.** In the document-processing case, clients upload about 5.72 TiB/day directly to object storage, notifications enter an idempotent queue path, ECS/EKS/Lambda choices follow runtime needs, and relational or key-value metadata publishes immutable output only after conditional completion.
- **Compare worked designs across different pressure points.** Social feed, multi-Region chat, search, notifications, tenant scheduling, and inference each retain clarification, requirements, arithmetic, API and state, two traces, alternatives, and an invalidating requirement. The chat case makes writer fencing, RTO, RPO, reconnect state, and failover socket capacity explicit while leaving the recovery theory in SD10.
- **Demand observable support for each choice.** Framing, correctness, scale, cost, recovery, security, data policy, and operations need a number, invariant, authorization rule, restore objective, cost unit, or abort signal. “Add a cache” and “shard it” remain incomplete when identity, freshness, routing, and failure policy are missing.

## References

- [Interviewing for Systems Design Skills](https://research.google/pubs/interviewing-for-systems-design-skills/): Describes Google's non-abstract large-system design interview format.
- [Amazon: SDE II interview preparation](https://www.amazon.jobs/content/en/how-we-hire/sde-ii-interview-prep): Describes the interview loop, system-design discussion, candidate questions, and published evaluation objectives.
- [Large-scale Cluster Management at Google with Borg](https://research.google/pubs/large-scale-cluster-management-at-google-with-borg/)
- [Apache Kafka 4.3: Design](https://kafka.apache.org/43/design/design/)
- [Apache Kafka 4.3: KRaft](https://kafka.apache.org/43/operations/kraft/): Documents the current controller and broker roles.
- [Firebase Cloud Messaging: Sending at Scale](https://firebase.google.com/docs/cloud-messaging/scale-fcm)
- [Amazon S3: Multipart Upload Overview](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)
- [Amazon S3: Event notification types and destinations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/notification-how-to-event-types-and-destinations.html): States the at-least-once, unordered notification contract.
- [Efficient Memory Management for LLM Serving with PagedAttention](https://arxiv.org/abs/2309.06180)
- [PostgreSQL: Write-Ahead Logging](https://www.postgresql.org/docs/current/wal-intro.html)
- [Apache Cassandra: Storage Engine](https://cassandra.apache.org/doc/latest/cassandra/architecture/storage-engine.html)
- [ClickHouse: MergeTree Table Engine](https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree)
- [Debezium: Outbox Event Router](https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html)
- [AWS Elastic Load Balancing: How Routing Works](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html)
- [AWS Network Load Balancer: Listeners](https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-listeners.html): Lists current TCP, TLS, UDP, TCP_UDP, QUIC, and TCP_QUIC listener behavior.
- [AWS: Choosing a container service](https://docs.aws.amazon.com/decision-guides/latest/containers-on-aws-how-to-choose/choosing-aws-container-service.html): Separates EC2 and Fargate capacity from ECS and EKS orchestration.
- [AWS: Choosing a database service](https://docs.aws.amazon.com/databases-on-aws-how-to-choose/): Compares relational, key-value, in-memory, document, wide-column, graph, and time-series models.
- [AWS: Choosing an application integration service](https://docs.aws.amazon.com/decision-guides/latest/application-integration-on-aws-how-to-choose/application-integration-on-aws-how-to-choose.html): Compares queues, pub/sub, event buses, streams, managed Kafka, and workflows.
- [AWS Well-Architected Framework: Definitions](https://docs.aws.amazon.com/wellarchitected/latest/framework/definitions.html): Defines the six review pillars and their trade-offs.
- [AWS Well-Architected Framework: The Six Pillars](https://docs.aws.amazon.com/wellarchitected/latest/framework/the-pillars-of-the-framework.html): Names operational excellence, security, reliability, performance efficiency, cost optimization, and sustainability.
- [AWS Well-Architected: Sustainability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html): Frames workload efficiency and resource waste as measured design concerns with explicit trade-offs.
- [Google SRE: Introduction](https://sre.google/sre-book/introduction/): Lists availability, latency, performance, efficiency, change management, monitoring, emergency response, and capacity planning as service responsibilities.
- [Kubernetes: Services, load balancing, and networking](https://kubernetes.io/docs/concepts/services-networking/): Covers Services, EndpointSlices, Gateway API, Ingress, and NetworkPolicy responsibilities.

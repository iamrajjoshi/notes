---
title: Kafka as a replicated event log
description: Start with Kafka vocabulary, then follow one record through partitioning, replication, consumption, replay, and failure.
slug: kafka-replicated-event-log
order: 7
identifier: CI7
duration: 145 min
difficulty: Core
tags:
  - Kafka
  - KRaft
  - partitions
  - consumer groups
  - schemas
  - delivery semantics
---

## Working model

Kafka is a distributed, retained log. Producers append records, brokers store partition replicas, and consumer groups independently track how far they have read. Kafka does not run the consumer's business code, delete a record when one consumer finishes, or replace the database that owns current application state.

## Choose the asynchronous contract before Kafka

An HTTP request keeps the caller waiting for one response. Asynchronous work breaks that timing dependency, but the replacement contract must say whether one worker or many subscribers need each item, how long the system retains it, who acknowledges progress, and whether old work can be replayed.

| Needed shape                                                                                      | Mechanism                                                                                       | Concrete examples                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| One job should be claimed by one worker and redelivered after an incomplete attempt               | Competing-consumer queue with a lease or visibility timeout and explicit acknowledgement        | [Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html); RabbitMQ queues |
| One publication should be pushed independently to several subscribers                             | Publish/subscribe topic; put a durable queue behind each subscriber that needs isolated retries | [Amazon SNS](https://docs.aws.amazon.com/sns/latest/dg/welcome.html), often fan-out to SQS                                            |
| Events should be matched by content and routed to service targets                                 | Event bus plus rules, target permissions, retries, and a dead-letter owner                      | [Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rules.html)                                          |
| Consumers need a retained ordered history that they can reread at their own positions             | Partitioned event log                                                                           | Kafka                                                                                                                                 |
| Application code needs task declaration, worker pools, retries, and result handling over a broker | Task framework                                                                                  | Celery; CI8 separates the framework from Redis, RabbitMQ, SQS, or another broker                                                      |
| A multi-step operation must resume from persisted boundaries after a process restart              | Durable workflow                                                                                | CI11 separates workflow history from worker lifetime, external-effect idempotency, stuck-work repair, and retention                   |

Amazon Simple Queue Service (SQS) supplies managed work queues. Amazon Simple Notification Service (SNS) publishes to independent subscriptions. Amazon EventBridge matches events to targets through rules. These services can be composed: an SNS topic can fan out to several SQS queues, a task framework can consume a queue, and a database outbox can feed a retained log.

No mechanism removes duplicate-delivery or ambiguous-outcome handling. The owner still needs a stable operation ID, an idempotent effect or reconciliation path, bounded retries, dead-letter policy, and queue-age alarms. Kafka is the retained-log choice in the table; the rest of this note derives what that choice means.

## Kafka keeps an event available to more than one reader

Suppose checkout records that order 123 was accepted. Fulfillment needs the event now, fraud detection needs it within seconds, and analytics may reprocess the last month after fixing a calculation. Calling all three systems inside the checkout request couples its latency and availability to every downstream service. Putting one job on a destructive queue lets one worker own the job, but does not by itself give independent readers a retained history.

Kafka lets checkout append an `OrderAccepted` record to a topic. A fulfillment consumer group reads its own copy of the stream position. Fraud detection and analytics use different groups, so their progress and outages do not move fulfillment's position. The retained record can be read again until the topic's retention policy removes it.

That does not make Kafka the source of truth for every question. The orders database may still own current order state. Kafka carries facts and derived streams between systems; consumers must decide how to handle duplicates, old schemas, and events that arrive after their local state changed.

## Learn the nouns before the failure modes

Kafka Raft metadata mode, usually called KRaft, is Kafka's built-in consensus system for cluster metadata.

| Term                     | Meaning                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cluster                  | The Kafka deployment as a whole: data brokers plus the metadata-controller quorum and supporting configuration                                          |
| Broker                   | A Kafka server that stores partition log segments and serves producer or consumer requests                                                              |
| KRaft controller         | A server role that participates in the metadata quorum, which records topics, partitions, replicas, leaders, and cluster configuration                  |
| Topic                    | A named stream of related records, split into one or more partitions                                                                                    |
| Record                   | The unit appended to Kafka: key, value, timestamp, and optional headers after serialization                                                             |
| Serialization            | Conversion between an application's object and the bytes Kafka stores; producer and consumer must agree on the format                                   |
| Key                      | Optional bytes commonly used to choose a partition, often an entity identifier such as an order ID                                                      |
| Partition                | One ordered append-only log inside a topic; it is the unit of storage, replication, and ordinary consumer-group assignment                              |
| Offset                   | A record's numeric position inside one partition; it is not a global topic sequence or a timestamp                                                      |
| Producer                 | A client that serializes and sends records to a topic                                                                                                   |
| Consumer                 | A client that fetches, deserializes, and processes records                                                                                              |
| Consumer group           | Consumers sharing a group ID and dividing a subscription; each partition is assigned to at most one active member of an ordinary group                  |
| Leader replica           | The replica that accepts writes and normally serves ordinary consumer fetches for one partition                                                         |
| Follower replica         | A copy that fetches the partition log from its leader; clients can fetch from followers when the broker and client are configured for follower fetching |
| Replication factor       | The intended number of replicas for each partition                                                                                                      |
| ISR                      | The in-sync replica set: replicas caught up enough to participate in the current replication contract                                                   |
| Producer acknowledgement | The producer's success threshold: none with `acks=0`, leader acceptance with `acks=1`, or all current ISR members with `acks=all`                       |
| Minimum ISR              | The minimum in-sync set required to accept an `acks=all` write under the topic policy                                                                   |
| Committed offset         | The group's saved next position for a partition, used when a member starts or resumes                                                                   |

A topic is not one global ordered file. If it has six partitions, it has six independent offset sequences. Record offset 42 in partition 1 has no ordering relationship with offset 42 in partition 4.

Kafka 4.x uses KRaft for metadata and no longer supports ZooKeeper mode. Production clusters normally separate a controller quorum from data brokers so a broker overload does not also remove metadata-quorum capacity. The controller quorum needs a majority of voters available to make metadata progress.

## Follow one record from write to committed progress

Assume `order-events` has six partitions, replication factor 3, and `min.insync.replicas=2`. Checkout produces a record with key `order-123`, value `OrderAccepted`, and `acks=all`.

1. The producer serializes the key and value. Its partitioner maps `order-123` to partition 4 under the current partition count.
2. Client metadata identifies broker B as partition 4's leader, so the producer sends the record batch to B.
3. The leader appends the batch and assigns the record offset 851. Followers C and D fetch the new log data.
4. With all three replicas currently in the ISR, `acks=all` waits for all current ISR members. `min.insync.replicas=2` is the floor for accepting the write, not a request to acknowledge after any two replicas when three remain in sync.
5. After the producer receives success, a fulfillment consumer assigned partition 4 fetches offset 851, deserializes it, and performs an idempotent state change.
6. The consumer commits offset 852, meaning its next read for this partition should begin after the processed record. An analytics group has a separate committed position and can read the same offset later.

_Broker letters, partition choice, and offset are illustrative. The producer receives the real partition and offset in its result metadata._

```text
checkout producer
  → key order-123 → partition 4 leader B → offset 851
                         ├─ follower C
                         └─ follower D
  ← acknowledgement after the configured replication condition

fulfillment group: partition 4 → process offset 851 → commit next offset 852
analytics group:   partition 4 → independent position and replay
```

If fulfillment writes its database and crashes before committing offset 852, the replacement consumer can receive offset 851 again. If it commits first and crashes before the database write, the group can skip unfinished work. Commit timing therefore selects a failure tradeoff; it does not make the database and Kafka one transaction.

## Partitions define ordering, concurrency, and hot spots

Kafka preserves record order within one partition. A stable key, partitioner, and partition count keep records for one entity on the same partition, so all changes for `order-123` can be processed in append order. Kafka does not provide an order across partitions. A global-order requirement forces the relevant records through one partition and limits parallelism.

Within an ordinary consumer group, one partition has at most one active consumer assignment. A 12-partition topic can keep at most 12 group members actively reading partitions; the thirteenth waits. One consumer can own several partitions, so six consumers commonly receive about two each.

The key distribution matters as much as partition count. A celebrity account, tenant, or constant key can send most traffic to one partition while other partitions sit idle. Adding consumers does not divide that one partition within an ordinary group. Fix the data contract by choosing a better key, sharding an oversized entity when its ordering requirement permits it, or separating that workload. Adding partitions can raise future concurrency, but hash-based keys may map to different partitions after the count changes. Treat partition-count changes as data-contract changes.

Large records also concentrate network, memory, replication, and fetch work. Put large blobs in object storage and publish a durable identifier plus integrity metadata when consumers do not need the bytes inline.

## Retention differs from queue acknowledgement

An ordinary Kafka consumer fetch does not remove the record. Brokers store a partition log in segment files. With the default delete cleanup policy, Kafka removes old segments when time or size retention is reached. Deletion happens by segment, so retention is not an exact per-record expiration timer. A slow or stopped consumer can replay only while the needed offsets still exist.

Log compaction is another policy. Kafka eventually retains at least the latest value for each key, while a null-valued tombstone represents deletion and is itself retained for a configured interval. Compaction is not immediate deduplication and does not turn a topic into a low-latency database. Consumers still need to rebuild or store queryable state elsewhere.

This differs from a typical task queue. In SQS or Celery, successful acknowledgement usually removes or makes a work item unavailable to the competing-worker pool. In Kafka, each consumer group keeps its own position against a shared retained log. Resetting a group's offsets can replay still-retained records without republishing them.

Kafka 4.3 also provides share groups. They let multiple share consumers acquire records from the same partition under time-limited locks, then accept, release, reject, or renew each delivery. That resembles a durable shared subscription and gives up ordinary partition-order processing. Use share groups only when the broker, client library, and managed service support them and record-level work sharing matters more than ordered partition ownership.

## Replication factor is not the whole durability policy

Each partition has one leader and one or more follower replicas. Replication factor says how many copies should exist. The ISR says which copies are currently caught up enough for the active protocol. `acks` says when the producer treats a send as successful, while `min.insync.replicas` sets the minimum in-sync set required for an all-ack write.

With replication factor 3, `min.insync.replicas=2`, and `acks=all`, a write can continue after one replica leaves the ISR but fails when the configured in-sync floor cannot be met. Unclean leader election can restore availability by electing a replica outside the safe set, with possible data loss. Kafka 4.1 and later enable Eligible Leader Replicas by default on new clusters; ELR records some replicas outside the ISR that remain safe leadership candidates under the stricter write rule. Current runbooks should inspect leader, ISR, ELR, and last-known ELR state instead of applying an older ISR-only model.

The safe setting still depends on placement. Three replicas on one failed rack or Availability Zone do not provide three independent failure domains. Spread replicas across failure domains, keep storage and network headroom for catch-up, and observe under-replicated and under-minimum-ISR partitions.

## Delivery semantics stop at explicit boundaries

Committing before processing can produce at-most-once behavior: a crash may skip work. Processing before commit produces at-least-once behavior: a crash may repeat work. Most business consumers choose at-least-once and protect each external effect with a semantic event ID, uniqueness constraint, conditional update, or downstream idempotency key.

Current Kafka producers enable idempotence by default unless conflicting configuration disables it. Producer idempotence prevents duplicate Kafka appends caused by supported producer retries and preserves the required ordering constraints. It does not deduplicate two independent business requests or make a payment API idempotent.

Kafka transactions can atomically write records to multiple Kafka partitions and commit consumed offsets as part of a Kafka read-process-write flow. Consumers using `read_committed` hide aborted transactional writes. A PostgreSQL update plus a Kafka write remains a cross-system transaction. The transactional outbox pattern writes application state and an outbox row in one database transaction, then a publisher or change-data-capture process sends the event. Consumers still need idempotency because publication and delivery can repeat.

Exactly-once is therefore a scoped protocol statement. Name the input offsets, output records, state store, external systems, and crash boundary before using the phrase.

## Consumer groups trade movement for parallelism

Group membership assigns partitions to members. A joining consumer, stopped consumer, subscription change, or partition-count change can cause assignment to move. During a rebalance, processing can pause; work already performed but not committed can repeat on the new owner. Keep poll and processing times within the client's group settings, stop fetching before shutdown, finish or cancel owned work, commit only the safe boundary, then release the assignment.

Lag is the difference between a partition's produced end offset and the group's committed or current position. It is a count of records, not elapsed time. Ten records may mean milliseconds or hours depending on event timestamps and processing cost. Monitor both lag and oldest-unprocessed age, then correlate them with production rate, handler duration, retries, rebalances, commit failures, and partition skew.

A hot partition shows high byte or record rate and growing lag on one partition while peers remain healthy. A broker failure has a different shape: leader elections, ISR shrinkage, producer errors, and several affected partitions. Diagnose the partition and broker distribution before adding consumers.

## Schemas are part of the event contract

Kafka stores serialized key and value bytes; the broker does not validate the business schema. Producers and consumers need an agreed serializer plus a compatibility policy, commonly enforced by a schema registry or release check outside the broker.

Give each event a stable semantic identity. Useful envelope fields include an event ID for deduplication, event type, schema version, occurrence time, and entity key. Do not put secrets in event payloads, and decide whether regulated or personal data may remain for the topic's full retention period.

Schema evolution needs both old and new readers in mind. Adding an optional field with a defined default is often safer than renaming a field, changing its type, or reusing it for a new meaning. Avro resolves a writer schema against a reader schema, so defaults and compatible type rules matter at read time. Other formats have their own rules. A safe rollout often deploys consumers that accept both shapes before producers emit the new shape, preserves the old field during a migration window, and removes it only after retained old records and lagging consumers no longer require it.

Validate malformed, unknown, and future schemas deliberately. A poison record should not block one partition forever; route it to an owned quarantine path with the original topic, partition, offset, schema identity, error, and replay procedure.

## Read the managed boundary after the product model

Amazon Managed Streaming for Apache Kafka (MSK) operates Kafka broker infrastructure and integrates it with AWS networking, identity, encryption, monitoring, and storage choices. A managed cluster does not choose the application's topics, keys, schemas, partition counts, retention, producer guarantees, consumer commits, or replay procedure.

Use a fictional bookshop event named `OrderAccepted`. Its key is `order_id`, its value contains an event ID, schema version, occurrence time, and the accepted order lines, and its topic has six partitions with replication factor three. All names and values in this case are fictional.

Trace one record through a producer and an `inventory-reserver` consumer group. The producer validates and serializes the event, selects a partition from `order_id`, and waits for the configured acknowledgement. The consumer subscribes, decodes against an accepted schema, reserves inventory under the event ID, and commits the offset only after that durable write. A malformed value goes to an owned quarantine topic with its original topic, partition, offset, and decode error. A process exit closes consumption, while a crash relies on group failure detection and reassignment.

Write the ownership record beside the code: AWS operates the managed broker boundary; the platform owner controls networking, access, broker settings, and alarms; the event owner controls topic configuration and schema policy; each consumer owner controls commits, idempotency, lag response, and replay. “Managed Kafka” covers only the first part of that chain.

_Keep infrastructure ownership, delivery semantics, and payload schema as separate review questions._

```text
OrderAccepted object → schema validation → serialized key/value → MSK partition
MSK partition → inventory-reserver group → decode → idempotent database write
durable write → offset commit
decode failure → quarantine record + owner + replay procedure
```

## Make topic and operating choices together

| Decision                | Questions to answer                                                                                                                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topic boundary          | What fact does the topic represent, who owns it, and may unrelated schemas or retention policies be separated?                                                                      |
| Partition key and count | What must stay ordered, what is the expected byte and record rate, how much consumer concurrency is needed, and can one key become hot?                                             |
| Durability              | What replication factor, failure-domain placement, producer acknowledgement, minimum ISR, and unclean-election policy meet the loss budget?                                         |
| Retention               | How long must replay remain possible, what size does that imply, and should cleanup use delete, compact, or both?                                                                   |
| Payload                 | What serializer and compatibility policy apply, how are large objects referenced, and how are invalid records quarantined?                                                          |
| Consumer                | When is an offset safe to commit, how is a side effect deduplicated, what bounds processing time, and how does shutdown release ownership?                                          |
| Security                | Which Transport Layer Security, Simple Authentication and Security Layer (SASL) or AWS IAM authentication, access-control list, network path, encryption, and audit controls apply? |
| Operations              | Who watches broker disk, request latency, leader elections, ISR and ELR state, partition skew, consumer lag and age, rebalances, and failed records?                                |

Capacity planning must include replication traffic and retained bytes, not only producer ingress. Compression and batching can reduce network and storage work at the cost of CPU and added batching delay. Quotas protect a shared cluster from one client, but they also need alerts so throttling is not mistaken for a random latency problem.

## Do not choose Kafka for every asynchronous action

Use a task queue such as SQS or Celery when one competing worker should perform a named job and long replay by independent subscribers is not required. Use HTTP or RPC when the caller needs an immediate response from one service. Use a relational database, key-value store, or cache for point lookup and current mutable state. Use object storage for large immutable blobs.

Kafka is also a poor shortcut for a missing transaction design. If an application must update a database and publish an event atomically, define an outbox or change-data-capture boundary. A one-partition topic can provide global order, but that throughput and availability constraint should be explicit. For a small system with few low-rate events and no replay need, Kafka's topic, schema, client, monitoring, and recovery work may cost more than the decoupling it provides.

## Summary

Kafka stores ordered partition logs and lets independent consumer groups move through them at their own pace. A useful design begins with the event and recovery contract, then chooses keys, partitions, replication, retention, commits, schemas, and operations to preserve it.

- A broker stores partition data; KRaft controllers manage cluster metadata. Kafka 4.x supports KRaft only.
- A topic contains partitions. Each partition has its own ordered offsets, leader, followers, and in-sync replica set.
- A producer serializes a record and selects a partition. The partition leader assigns its offset, followers replicate it, and the producer acknowledgement depends on `acks`, ISR state, and the topic's minimum-ISR policy.
- A consumer group owns independent progress. One partition has at most one active member in an ordinary group, so group concurrency is bounded by partition count.
- Kafka retention is independent of consumption. Delete policy removes old segments by time or size; compaction eventually preserves the latest value for each key and handles tombstones.
- Commit after the recoverable boundary for at-least-once processing, then make external effects idempotent. Committing first can skip work.
- Producer idempotence and Kafka transactions cover named Kafka retry and read-process-write boundaries. They do not make a database or external API part of the same transaction.
- Keys preserve per-entity order only within a stable partitioning contract. Skew creates hot partitions, and adding consumers cannot split one ordinary group assignment.
- Lag counts records, not time. Monitor oldest-unprocessed age, handler duration, rebalances, commit failures, and partition distribution with it.
- Kafka stores bytes, not business schemas. Deploy compatible readers before new writers, retain event identity, and own poison-record quarantine and replay.
- Choose Kafka for retained, replayable streams with independent readers. Prefer a task queue, request call, database, cache, or object store when that contract fits better.

## References

- [Apache Kafka 4.3 introduction and terminology](https://kafka.apache.org/43/getting-started/introduction/)
- [Apache Kafka design and delivery semantics](https://kafka.apache.org/43/design/design/)
- [Apache Kafka topic configuration](https://kafka.apache.org/43/configuration/topic-configs/)
- [Apache Kafka producer configuration](https://kafka.apache.org/43/configuration/producer-configs/)
- [Apache Kafka consumer and share-consumer configuration](https://kafka.apache.org/43/configuration/consumer-configs/)
- [Apache Kafka KRaft operations](https://kafka.apache.org/43/operations/kraft/)
- [Apache Kafka Eligible Leader Replicas](https://kafka.apache.org/43/operations/eligible-leader-replicas/)
- [Apache Kafka consumer rebalance protocol](https://kafka.apache.org/43/operations/consumer-rebalance-protocol/)
- [Apache Kafka monitoring](https://kafka.apache.org/43/operations/monitoring/)
- [Apache Kafka security overview](https://kafka.apache.org/43/security/security-overview/)
- [Apache Kafka 4.3 share consumer API](https://kafka.apache.org/43/javadoc/org/apache/kafka/clients/consumer/KafkaShareConsumer.html)
- [Apache Avro schema resolution](https://avro.apache.org/docs/1.12.0/specification/)
- [Amazon MSK concepts](https://docs.aws.amazon.com/msk/latest/developerguide/what-is-msk.html)
- [Amazon MSK operations](https://docs.aws.amazon.com/msk/latest/developerguide/operations.html)

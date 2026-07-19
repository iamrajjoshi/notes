---
title: Distributed Dataflow and Scheduling
shortTitle: Dataflow and scheduling
description: Follow bounded and unbounded data through partitions, shuffles, stateful operators, checkpoints, graph supersteps, and distributed training while accounting for placement and shared cluster resources.
collection: distributed-systems
slug: distributed-dataflow-and-scheduling
order: 8
number: DS8
duration: 3.5 hours
difficulty: Intermediate
tags:
  - MapReduce
  - streaming
  - scheduling
  - watermarks
  - graph-processing
  - distributed-training
---

## Working model

A distributed computation is a graph of operators joined by data movement. Correctness depends on what each operator reads, what state it keeps, when progress becomes final, and what recovery replays; speed depends on partition balance, network transfers, storage, and the slowest required participant.

## Questions this note answers

- Distinguish bounded batch input from an unbounded event stream
- Trace one MapReduce word count through input splits, maps, shuffle, reducers, and durable output
- Explain what YARN schedules and how Kubernetes places a Pod today
- Compare FIFO, shortest-job policies, queue shares, and dominant-resource fairness without claiming one scheduler is universally optimal
- Read a streaming topology using sources, operators, partitions, state, sinks, event time, and watermarks
- Follow a Kafka-backed Flink job through keyed state, windows, checkpoint barriers, failure, replay, and sink commit
- Explain backpressure, checkpoint recovery, replay, and the boundary of an exactly-once claim
- Use graph structure to predict skew, path length, and failure sensitivity
- Follow one Pregel superstep and one synchronous data-parallel training step

## Start with bounded input and an explicit output

A **batch job** processes a bounded input: a set of files, table snapshot, or finite collection whose end can be identified. A **streaming job** stays active while new records arrive. The distinction concerns input boundedness, not whether the program runs quickly. A five-minute job over yesterday's complete logs is batch; a quiet fraud detector waiting on an event topic is streaming.

Both can be drawn as a directed graph. Vertices are operators or tasks, edges carry records, and partitions divide work among parallel instances. The questions that matter are concrete: which field chooses a partition, where state lives, which edge crosses the network, and what durable position allows recovery to resume.

The original MapReduce system made a narrow batch graph easy to run on many machines. A mapper reads one input record and emits zero or more intermediate key-value pairs. The runtime groups every intermediate value for one key, then calls a reducer for that key. The programmer supplies the map and reduce functions; the runtime owns input splitting, task placement, shuffle, retries, and output commit.

## Work word count through the shuffle

Suppose two input splits contain these lines:

```text
split A: welcome everyone
split B: hello everyone
```

Map task A emits `(welcome, 1)` and `(everyone, 1)`. Map task B emits `(hello, 1)` and `(everyone, 1)`. If there are two reducers, the partition function assigns each word to one reducer. Both `everyone` records must reach the same reducer even though different mappers produced them.

The shuffle does more than copy bytes. Each map output is partitioned by reducer, sorted by key within those partitions, written to local storage, and fetched by the appropriate reducers. A reducer sees `everyone -> [1, 1]` and emits `(everyone, 2)`. Final reducer output goes to durable distributed storage.

```text
input splits -> map tasks -> partition and sort -> network shuffle -> reduce tasks -> durable files
```

Map output normally stays on a worker's local disk because the runtime can rerun the mapper if that worker fails. Final output goes to a distributed filesystem because later jobs need it after the worker disappears. Reducers can begin fetching completed map outputs before every mapper finishes, but the reduce function cannot finish its complete key groups until the map side reaches its barrier.

A **combiner** may aggregate repeated map output locally, such as turning one hundred `(everyone, 1)` records into `(everyone, 100)` before the shuffle. That optimization is safe only when its operation has the required algebraic properties and its output type fits the reducer input. The runtime may run a combiner zero, one, or several times, so application correctness cannot depend on it.

Hash partitioning spreads many ordinary keys cheaply, but it cannot repair a skewed key. If `unknown-user` owns 40 percent of all records, its reducer remains a hot task. Range partitioning supports globally sorted output only when sampled boundaries divide the actual distribution well. Partition count, key distribution, record size, and reducer work all belong in one capacity estimate.

The Java API shown in the 2025 lecture is historical Hadoop API code. Keep the map, shuffle, and reduce mechanism; do not copy those classes as a current programming example. The slide also describes Hadoop 3 as replacing YARN containers with Docker. That is incorrect. A YARN container is a resource allocation, while Docker can serve as an execution runtime for that allocation. HDFS can use erasure coding for selected data, but it did not universally replace replication.

## Separate the job framework from the resource manager

Hadoop YARN split cluster resource management from a particular computation framework. Its global **ResourceManager** arbitrates cluster resources. Each machine runs a **NodeManager**, which launches and monitors allocated containers. Each application has an **ApplicationMaster** that requests containers and tracks that application's tasks. A YARN container denotes resources such as memory and virtual CPU on one node; it is not the same concept as an OCI image or Kubernetes container.

The split lets MapReduce, graph jobs, and other frameworks share one cluster. It also exposes two levels of recovery. If one task fails, the ApplicationMaster can request another container and rerun the task. If a node vanishes, every task and local map output on it may need replacement. Speculative execution runs a second copy of a suspected straggler and accepts the first result, which helps only when the task is deterministic and duplicate execution has no uncontrolled external side effect.

Kubernetes solves a related placement problem with different objects. A **Pod** is Kubernetes' smallest schedulable API object: one or more co-scheduled containers that share a network identity, declared storage volumes, and a lifecycle boundary. The default scheduler watches for Pods without an assigned node, filters out nodes that cannot satisfy hard requirements, scores the feasible nodes, and records a binding through the API server. CPU and memory **requests** inform placement; current low usage does not let the scheduler ignore already reserved requests. Limits and runtime enforcement involve the kubelet and Linux resource controls after placement.

YARN's ApplicationMaster understands one application's task graph. The ordinary Kubernetes scheduler places Pods but does not, by itself, understand that 400 Pods form one barrier-synchronized job or that a failed worker invalidates a training group. Batch controllers, queueing layers, and specialized schedulers add job admission, gang scheduling, priorities, quotas, accelerator topology, or retry policy when a workload needs them.

## Define the scheduling objective before choosing a policy

Scheduling has competing measurements: queue wait, completion time, interactive response, throughput, fairness, deadline misses, placement quality, and unused headroom. A provider may care about safe utilization across tenants, while one user cares about a single job's finish time.

FIFO is predictable but lets a large job hold smaller jobs behind it. Shortest-processing-time minimizes the sum of completion times only under specific assumptions, including known durations and jobs available for selection. With arrivals, priorities, inaccurate estimates, dependencies, or fairness constraints, the blanket claim that “shortest task first is optimal” fails. It can also starve long work. Round robin improves initial response for runnable CPU tasks but adds context-switch overhead and says little about a distributed job that needs memory, storage bandwidth, and several workers together.

Queue schedulers reserve shares for teams or workload classes and may lend unused capacity. Modern YARN CapacityScheduler supports hierarchical queues, limits, elasticity, and configurable preemption, so the lecture's claim that capacity scheduling has no preemption is historical. Preempting a pure map task wastes work but is recoverable; killing a task that called an external payment API is a different contract.

**Dominant-resource fairness (DRF)** compares each tenant by the largest fraction of any resource it receives. Consider a cluster with 18 CPUs and 36 GiB of memory. One A task requests 2 CPUs and 8 GiB, so its dominant fraction per task is `max(2/18, 8/36) = 2/9`, driven by memory. One B task requests 6 CPUs and 2 GiB, whose dominant fraction is `max(6/18, 2/36) = 1/3`, driven by CPU. An allocation of three A tasks and two B tasks gives each tenant a dominant share of `2/3`:

```text
A memory share = 3 * 8 / 36 = 2/3
B CPU share    = 2 * 6 / 18 = 2/3
```

That example explains the fairness rule, not every production objective. Fragmentation can leave resources idle; placement constraints, GPUs, licenses, topology, job priority, and borrowed capacity complicate the decision.

## Treat Storm as a historical stream-processing model

The course uses Apache Storm to introduce long-running dataflow. A **spout** is a source, a **bolt** consumes and emits tuples, and a **topology** connects them. Parallel tasks execute one logical bolt. Shuffle grouping distributes records among tasks; fields grouping hashes selected field values so equal values reach the same task; all grouping broadcasts every tuple. The lecture's alphabet-range fields example communicates partition affinity, but Storm fields grouping uses hashing rather than fixed letter ranges.

Storm tracks a tuple tree rooted at a source tuple. Bolts anchor descendants and acknowledge or fail work; the source can replay a root when its tree does not complete before the timeout. This is an at-least-once mechanism unless the application adds a narrower transactional boundary. A replay can repeat a database write or notification.

Storm still has an active Apache project, and current releases include facilities absent from the early design. In this course, though, Storm serves as a historical vocabulary bridge. Current stateful engines usually make event time, managed operator state, durable checkpoints, rescaling, and backpressure explicit. Kafka is a retained log; Kafka Streams is a processing library. Referring to “Kafka” alone as a sister stream processor mixes those layers.

## Follow one event through a current stream engine

Keep three similarly named layers separate before drawing the path:

| Component     | What runs                                                             | What it owns                                                                                                                              |
| ------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Apache Kafka  | A broker cluster plus producer and consumer clients                   | Retained partition logs, per-partition offsets, replication, and consumer positions                                                       |
| Kafka Streams | A Java client library embedded in an application process              | A processing topology, tasks tied to Kafka partitions, local state stores, changelog topics, and Kafka-integrated processing transactions |
| Apache Flink  | A distributed execution engine with coordinating and worker processes | A submitted job graph, operator subtasks, network exchanges, managed state, timers, watermarks, checkpoints, and recovery                 |

Kafka can store the input and output without running the computation. A Kafka Streams application is deployed like another application instance; the library divides Kafka partitions into tasks and can rebuild local state from changelog topics. Flink runs a separate distributed job and can use Kafka as one source or sink. Its JobManager coordinates execution, checkpoints, and recovery, while TaskManagers execute operator subtasks in slots. A TaskManager may itself run inside a Kubernetes Pod, but Kubernetes places the Pod while Flink assigns subtasks and keyed state inside its execution graph. The walkthrough below is Flink consuming Kafka, not a Kafka Streams topology; Kafka Streams restores changelog-backed state and coordinates Kafka offsets and transactions through its own library protocol rather than Flink checkpoint barriers.

Suppose a Flink job reads API usage events from a Kafka topic. Each event has `event_id`, `tenant_id`, `event_time`, and `bytes`, and the job writes per-tenant usage totals.

1. **Source and position.** Parallel Kafka source readers consume assigned topic partitions. Each record retains its Kafka partition and offset for replay, but that offset is transport position rather than the event's business identity. The source extracts `event_time` from the payload and generates watermarks under its configured out-of-order and idle-partition policy.
2. **Keyed partition.** `keyBy(tenant_id)` sends every record for tenant 42 to the same downstream operator subtask. This network repartition makes per-tenant state local to one active subtask; it does not make all tenants globally ordered. One tenant carrying 40 percent of traffic remains a hot key even when the job has 100 subtasks.
3. **Stateful operator.** The subtask keeps managed state such as `(count, bytes)` for each tenant and active window. Managed state belongs to the engine's recovery protocol, unlike an ordinary process-global map that disappears with the worker. Timers associated with event-time windows also have to survive recovery.
4. **Window.** A tumbling five-minute window assigns `10:03:20` to exactly one interval, `[10:00, 10:05)`. A sliding five-minute window started every minute assigns that event to several overlapping windows, which gives a moving view but multiplies state and output. A session window with a 20-minute inactivity gap has no fixed clock boundary; records extend or merge a tenant's session until the gap closes it.
5. **Watermark and lateness.** When the operator's watermark passes `10:05`, the event-time trigger can emit the first result for `[10:00, 10:05)`. With two minutes of allowed lateness, the engine retains that window until the watermark passes `10:07`. A delayed `10:04:40` record arriving while the watermark is `10:06` can update the result and trigger another emission. The same record arriving after cleanup follows the job's late-data rule, such as a side output or drop. Allowed lateness is retained state and possible revisions, not a promise that every late event will arrive in time.
6. **Checkpoint barrier.** A checkpoint coordinator asks sources to inject a barrier after their current positions. An aligned stateful operator waits until the barrier reaches all of its input channels, snapshots the state and timers for the consistent cut, then forwards the barrier. Source offsets and operator snapshots belong to the same completed checkpoint. Backpressure can delay alignment; an unaligned checkpoint may capture in-flight buffers instead.
7. **Sink preparation and completion.** An idempotent sink can upsert by `(tenant_id, window_start)` with a monotonic source or window revision, replacing a row only when the incoming revision is newer. A sink integrated with the engine's checkpoint protocol can prepare writes under a transaction and expose them only after the checkpoint completes. An ordinary HTTP call made between two barriers belongs to neither boundary and may repeat.

Now let the worker holding tenant 42 fail after it emitted output but before the next checkpoint completed. Flink discards the failed attempt's uncheckpointed engine state, starts replacement subtasks, restores the latest completed checkpoint, and asks the Kafka source to resume from the checkpointed offsets. Records after those offsets replay, including some records the failed attempt already processed. The restored state produces the same logical totals only when the operator is deterministic with respect to the recorded input and configuration.

The sink decides whether that replay becomes a duplicate. The idempotent upsert converges on one window row because the identity and revision repeat. A checkpoint-coordinated transaction aborts an uncommitted attempt and commits only the successful checkpoint's writes. Sending an email for every intermediate window result does neither; use a durable, idempotent notification operation outside the aggregation or accept that recovery can send it again.

```text
Kafka partitions
  -> Flink Kafka source + offsets
  -> keyBy(tenant_id)
  -> keyed window state + event-time timers
  -> checkpoint barrier snapshots state and source positions
  -> idempotent upsert or checkpoint-coordinated sink

failure -> restore completed checkpoint -> seek Kafka offsets -> replay -> sink deduplicates or aborts old transaction
```

## Use event time when the result should survive replay

**Processing time** is when an operator handles a record. **Event time** is when the source says the event occurred. They diverge during mobile disconnection, queue backlog, retry, and historical replay.

Suppose a service computes order totals in one-minute event-time windows. At processing time `10:02:12`, it receives an order whose event timestamp is `10:00:48`. If the processor grouped by its own clock, replaying the same input tomorrow would produce a different window. Event time gives the record the same logical placement during live processing and replay.

A **watermark** reports progress through event time. Watermark `10:01:00` means the operator's policy believes timestamps through that point have arrived. It is a progress assertion, not proof that no older record exists. The job must choose what to do with a late `10:00:48` record: discard it, send it to a side output, revise an earlier result, or retain the window for an allowed-lateness interval.

Parallel inputs complicate progress. An operator commonly follows the minimum watermark across active input partitions because any one partition may still contain older records. An idle partition can therefore stop every downstream event-time window unless the source marks it idle under a stated policy. Watermark lag is partly a correctness choice: waiting longer captures more late data but delays results and retains more state.

## Backpressure and checkpoints solve different problems

When a sink can process 5,000 records per second and an upstream operator emits 9,000, unbounded buffering only postpones failure. **Backpressure** propagates the downstream constraint toward sources, limiting in-flight records or slowing intake. It protects memory and makes congestion visible; it does not create the missing 4,000-record-per-second capacity. Persistent backlog still needs scaling, cheaper work, partition repair, admission control, or deliberate shedding.

A stateful stream processor also needs a recovery cut. A checkpoint records operator state together with replay positions from durable inputs. After failure, the job restores that state and replays after the recorded positions. Aligned checkpoint barriers wait for a consistent cut across inputs; heavy backpressure can delay those barriers. Unaligned checkpoints can include in-flight buffers, trading more checkpoint I/O and state for a shorter barrier delay.

An “exactly once” label must name its boundary. Restoring operator state and source positions can reproduce a failure-free state transition inside the engine. An HTTP call, email, or ordinary database write outside that checkpoint may still repeat. End-to-end behavior needs a transactional sink, an idempotent operation identity, or reconciliation. Checkpoint duration, checkpoint failure rate, restore time, replay volume, and post-recovery catch-up capacity all need monitoring.

## Read network shape before partitioning a graph

A graph contains **vertices** and **edges**. Edges may be directed, undirected, weighted, or repeated. A **path** is an edge-connected vertex sequence; shortest path depends on whether length counts hops or weights. A node's **degree** counts adjacent edges, with separate in-degree and out-degree in a directed graph.

Clustering measures how often a node's neighbors connect to one another, while average path length measures typical shortest-path distance between reachable pairs. A **small-world** graph combines more local clustering than a comparable random graph with short typical paths. Preferential-attachment models add new vertices with a bias toward already high-degree vertices, which can produce heavy-tailed degree distributions.

Two lecture shortcuts need correction. In an Erdős-Rényi `G(n,p)` graph, a vertex degree follows a binomial distribution and approaches a Poisson distribution in the sparse large-graph limit; it is not generally exponential. And “scale-free” is not a safe label for every network with hubs. Finite samples, truncation, collection bias, changing mechanisms, and competing lognormal or stretched-exponential fits make power-law claims hard to establish.

Random node removal and targeted removal of high-degree vertices can behave differently in some graph models, but a production network also has geography, shared power, software versions, routing policy, capacity limits, and dependency edges. Removing one hub may reroute load into another failure. Degree alone does not predict the blast radius.

## Process a large graph in supersteps

Pregel's historical model asks programmers to “think like a vertex.” Workers own vertex partitions. During one bulk-synchronous **superstep**, active vertices process messages from the preceding superstep, update local state, and send messages for the next one. A barrier keeps superstep boundaries ordered. The computation stops when all vertices vote inactive and no messages remain in flight.

For single-source shortest paths, set source A to distance 0 and every other vertex to infinity. In superstep 1, A sends `0 + edge_weight` to its neighbors. Each recipient keeps the minimum candidate and sends improved distances in the next superstep. Information advances across the graph until no distance changes.

Hashing `vertex_id % workers` is ordinary hash partitioning, not consistent hashing. Changing the worker count remaps most vertices. Locality-aware placement can reduce cross-worker messages, but partitioning itself costs time and a high-degree vertex can still create skew. Bulk barriers mean one slow worker sets superstep time. Checkpoints save partition state and incoming messages so workers can reload a previous superstep after failure.

## Synchronize gradients, not vague “model data”

Distributed machine-learning training is another dataflow with expensive synchronization. In synchronous data parallelism, every worker holds one model replica and processes a different mini-batch. Backpropagation computes local gradients. An all-reduce combines those gradients across ranks, and every rank applies the same optimizer step, keeping parameters aligned.

```text
rank 0 batch -> forward/backward -> local gradients --+
rank 1 batch -> forward/backward -> local gradients ---+-> all-reduce -> optimizer step on each rank
rank 2 batch -> forward/backward -> local gradients ---+
rank 3 batch -> forward/backward -> local gradients --+
```

PyTorch DistributedDataParallel does not divide input automatically; the application normally supplies a distributed sampler. It all-reduces gradients, not model weights on every step. One rank that enters a collective late can stall the whole group, and mismatched collective order can hang it.

Parameter-server designs send gradients or updates to designated parameter owners and may run synchronously or asynchronously. Large models now combine replicated data parallelism with parameter, gradient, and optimizer-state sharding; tensor, pipeline, sequence, context, or expert parallelism may split the model itself. “Model parallelism means one input at a time” is a dated simplification because pipeline systems use microbatches to overlap stages.

The TensorFlow code on lecture page 24 uses TensorFlow 1 APIs such as placeholders and sessions, and it adds `b_2` to the first layer instead of `b_1`, which creates a shape error. Keep the dataflow lesson, not the sample. TensorFlow 2 uses eager execution by default and `tf.function` when a compiled graph is useful.

## Inspect flow, placement, and recovery together

For batch work, record input bytes, map and reduce task distributions, shuffle bytes, spill volume, skew by partition, straggler copies, queue wait, and final output commit. For streams, add source lag by partition, event-time watermark lag, late-record counts, operator state size, backpressure time, checkpoint duration, restore time, and sink commit failures. Graph and training jobs need per-worker superstep or collective arrival times because an average hides the rank holding everyone else.

Capacity planning must include recovery. If a stream ingests 10,000 records per second and recovery takes ten minutes, six million records accumulate before catch-up starts. A restored job provisioned for exactly 10,000 per second never catches up. The same principle applies to map retries, graph checkpoint replay, and a training restart that rereads checkpoints over a shared network.

## Summary

Distributed dataflow turns input into operator partitions and network exchanges, while a scheduler decides where those partitions may run. The useful model names the boundedness, partition rule, state, progress boundary, recovery position, and resource request for every stage.

- **MapReduce makes one batch graph explicit.** Maps process independent input records, the shuffle groups and sorts intermediate keys, and reducers write durable output. Skew, shuffle bytes, barriers, and stragglers determine much of the runtime.
- **YARN and Kubernetes schedule different abstractions.** YARN combines a global resource manager with per-application coordination. The Kubernetes scheduler filters and scores nodes for Pods using declared requests; extra controllers add job-level behavior.
- **No scheduler is optimal without an objective and assumptions.** FIFO, shortest-job policies, queue shares, preemption, and DRF trade completion time, response, fairness, utilization, and wasted work.
- **Event time makes replay reproducible.** Watermarks declare progress under a policy, late data needs an explicit outcome, and one idle partition can stop downstream progress.
- **Backpressure bounds flow; checkpoints restore state.** Neither creates spare capacity, and engine-level exactly-once state does not automatically include an external side effect.
- **Do not collapse Kafka, Kafka Streams, and Flink into one product.** Kafka retains partitioned records. Kafka Streams embeds processing and local state inside an application. Flink executes a distributed job with managed state, watermarks, barriers, and restore. A Kafka-backed Flink job replays after a checkpoint, so its sink still needs an idempotent identity or a transaction coordinated with checkpoint completion.
- **Graph shape predicts work only imperfectly.** Erdős-Rényi degrees are binomial or approximately Poisson, power-law labels need statistical evidence, and operational dependencies exceed the logical graph.
- **Pregel synchronizes vertex supersteps.** Partition skew, messages, barriers, high-degree vertices, and checkpoint replay determine its cost.
- **Synchronous data parallelism all-reduces gradients.** Inputs remain the application's responsibility, the slowest required rank delays the step, and larger models add several distinct forms of sharding.

## References

- [CS 425 Fall 2025 L4: MapReduce and Hadoop](https://courses.grainger.illinois.edu/cs425/fa2025/L4.FA25.pdf)
- [CS 425 Fall 2025 L22: structure of networks](https://courses.grainger.illinois.edu/cs425/fa2025/L22.FA25.pdf)
- [CS 425 Fall 2025 L22B: stream processing](https://courses.grainger.illinois.edu/cs425/fa2025/L22.B.FA25.pdf)
- [CS 425 Fall 2025 L23: scheduling](https://courses.grainger.illinois.edu/cs425/fa2025/L23.FA25.pdf)
- [CS 425 Fall 2025 L26: graph processing and machine learning](https://courses.grainger.illinois.edu/cs425/fa2025/L26.FA25.pdf)
- [Google: MapReduce: Simplified Data Processing on Large Clusters](https://research.google/pubs/mapreduce-simplified-data-processing-on-large-clusters/)
- [Apache Hadoop: YARN architecture](https://hadoop.apache.org/docs/current/hadoop-yarn/hadoop-yarn-site/YARN.html)
- [Apache Hadoop: CapacityScheduler](https://hadoop.apache.org/docs/current/hadoop-yarn/hadoop-yarn-site/CapacityScheduler.html)
- [Kubernetes: kube-scheduler](https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/)
- [Kubernetes: Pods](https://kubernetes.io/docs/concepts/workloads/pods/): Defines the smallest deployable Kubernetes compute object, including its shared network and storage context.
- [Kubernetes: resource management for Pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Ghodsi et al.: Dominant Resource Fairness](https://amplab.cs.berkeley.edu/wp-content/uploads/2011/06/Dominant-Resource-Fairness-Fair-Allocation-of-Multiple-Resource-Types.pdf)
- [Apache Storm 2.8 concepts](https://storm.apache.org/releases/2.8.0/Concepts.html)
- [Apache Kafka 4.3: Introduction](https://kafka.apache.org/43/getting-started/introduction/): Defines the broker, topic, partition, producer, consumer, offset, retention, and replication layers.
- [Apache Kafka 4.3: Kafka Streams introduction](https://kafka.apache.org/43/streams/introduction/): Defines Kafka Streams as a client library embedded in applications whose inputs and outputs live in Kafka.
- [Apache Kafka 4.3: Running Streams applications](https://kafka.apache.org/43/streams/developer-guide/running-app/): Documents stream tasks, application instances, local state, changelog restoration, and partition-bounded parallelism.
- [Apache Flink: architecture](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/flink-architecture/): Describes Flink application execution, JobManagers, TaskManagers, slots, and cluster lifecycles.
- [Apache Flink: windows](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/windows/): Defines tumbling, sliding, and session assigners, triggers, allowed lateness, side outputs, and window cleanup.
- [Apache Flink: event time and watermarks](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/event-time/generating_watermarks/)
- [Apache Flink: checkpointing](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/fault-tolerance/checkpointing/)
- [Apache Flink: checkpointing under backpressure](https://nightlies.apache.org/flink/flink-docs-stable/docs/ops/state/checkpointing_under_backpressure/)
- [Watts and Strogatz: Collective dynamics of small-world networks](https://www.nature.com/articles/30918)
- [Broido and Clauset: Scale-free networks are rare](https://www.nature.com/articles/s41467-019-08746-5)
- [Google: Pregel, a system for large-scale graph processing](https://research.google/pubs/pregel-a-system-for-large-scale-graph-processing/)
- [PyTorch: DistributedDataParallel](https://docs.pytorch.org/docs/stable/generated/torch.nn.parallel.DistributedDataParallel.html)
- [TensorFlow: migrate from TensorFlow 1 to TensorFlow 2](https://www.tensorflow.org/guide/migrate)

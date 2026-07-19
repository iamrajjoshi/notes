---
title: Distributed inference and topology
description: Place model state and request work across GPUs without treating parallelism as free capacity.
slug: distributed-inference
order: 6
identifier: AI6
duration: 145 min
difficulty: Advanced
tags:
  - tensor parallel
  - pipeline parallel
  - NCCL
  - disaggregation
---

## Working model

Distributed inference uses more than one GPU process for a model or fleet. It can make an oversized model fit or serve more independent traffic, but every split adds some combination of copied state, communication, waiting, and a wider failure boundary.

## Distribute only for a named constraint

Start with one model replica on one GPU. If weights and request state do not fit, split that replica across devices. If one complete replica fits but cannot handle the arrival rate, create independent replicas and route different requests to them. These are different problems: memory-driven sharding makes the devices depend on each other during one model pass, while throughput-driven replication lets serving groups work independently.

A **serving group** is the set of processes that cooperate to execute one logical model replica. Choose the smallest group that fits the weights, KV cache, workspaces, and target concurrency. A larger group may add links and failure points without increasing useful capacity.

## Learn the distributed nouns

| Term                          | Meaning                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node and device               | A node is one server; a device is one accelerator in it. Links inside a node may be much faster than the network between nodes.                                     |
| Process and rank              | Engines commonly run one operating-system process per GPU. A rank is that process's numbered identity inside a communication group.                                 |
| Replica                       | One complete logical copy of the model service. Its weights may live on one device or be sharded across a serving group.                                            |
| Shard                         | One partition of weights, activations, KV state, or request work held by a rank. A shard is incomplete until the algorithm combines the needed results.             |
| Collective                    | A coordinated communication operation over a group of ranks, such as all-reduce or all-gather. Every participant must call compatible operations in the same order. |
| Synchronization and straggler | A synchronization point makes ranks wait for required peers. The slowest arriving rank is the straggler and can set group latency.                                  |
| Topology                      | The physical path among CPUs, GPUs, PCIe switches, NVLink-class links, network adapters, and remote nodes. Logical rank numbers do not reveal this path.            |

Distributed arithmetic is not remote HTTP. Tensor shards may exchange hundreds of mebibytes inside one token step, and the next operation may wait until that exchange finishes. Draw ranks and physical links on the same diagram.

## Data and tensor parallelism split different things

Data parallel serving replicates model weights and sends different requests to each replica. It scales independent work and isolates queues, but each replica must fit the model and retain its own cache state.

Tensor parallelism shards operations and weights within a layer across devices. Partial results require collectives at frequent boundaries, so fast intra-node links and balanced kernels matter. A model that barely fits after sharding may leave too little room for KV cache and serving bursts.

## Pipeline, expert, and context splits follow model structure

Pipeline parallelism assigns consecutive layer ranges to stages. A microbatch is a smaller unit sent into the pipeline so different stages can work at once; empty stage time before the pipeline fills or while it drains is a **bubble**. Expert parallelism distributes blocks from a mixture-of-experts (MoE) model, whose routing function sends each token to a subset of specialized feed-forward blocks. That choice produces all-to-all traffic and can overload popular experts.

Context parallelism partitions long-sequence work across devices so no one device holds or computes the full context path. Its communication pattern and support vary by model and runtime; it does not remove the sequence-length cost.

> **Name the replicated state.** A diagram that shows only sharded weights misses KV cache, tokenizer state, adapters, scheduler metadata, and temporary collective buffers.

## Choose the split from the first resource that does not fit

Use data parallel replicas after one complete serving group fits and the goal is more independent throughput. Within a **GPU island**, a set of devices joined by the machine's fastest peer fabric, tensor parallelism can make a layer fit, but it inserts frequent collectives. Pipeline parallelism can place layer ranges across slower boundaries when the engine and model support it, at the cost of stage bubbles and balance work. Expert parallelism addresses MoE expert placement and pays all-to-all traffic; context parallel or sequence-sharded designs address per-request context state and attention work.

Those are starting hypotheses, not a universal ranking. A practical plan often uses tensor parallelism within a node, pipeline parallelism across nodes only when necessary, and data parallel groups for fleet throughput. Modern MoE runtimes may combine attention data parallelism with expert parallelism, which changes both replicated weights and communication. Draw the process groups and physical links before quoting a parallel degree.

| First constraint                                            | Candidate move                            | New bill to measure                                                     |
| ----------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Model weights do not fit one GPU but fit one fast-link node | Tensor parallelism                        | Per-layer collectives, KV sharding or replication, and workspace memory |
| Model does not fit one node                                 | Pipeline or cross-node tensor parallelism | Stage bubbles or network collectives, plus rank-failure scope           |
| One serving group fits but misses fleet throughput          | Data parallel replicas                    | Another full weight copy, routing, and uneven queue load                |
| MoE experts dominate weight or compute placement            | Expert parallelism                        | All-to-all bytes, routing skew, and expert load balance                 |
| One request's context state or attention does not fit       | Supported context/KV sharding strategy    | Communication on the attention path and engine-specific limits          |

## Collectives expose the physical topology

All-reduce combines values and returns the result to every participant. Reduce-scatter leaves each participant with one reduced shard, all-gather reconstructs shards across a group, and all-to-all exchanges distinct pieces among every rank.

NVIDIA Collective Communications Library (NCCL) implements supported collective and point-to-point communication paths for CUDA devices. It cannot create bandwidth the machine lacks. Crossing CPU sockets, PCIe switches, or a network interface card (NIC) changes latency and contention. Rank placement should follow measured topology, and health checks need to catch a slow participant before one stalled collective blocks the group.

## Disaggregated prefill and decode trade interference for transfer

Separate prefill and decode pools can tune hardware, batching, and autoscaling for different phase shapes. They also need to move KV state or an equivalent representation across a network boundary and coordinate request ownership.

The design wins only if reduced queue interference and better device fit exceed transfer, serialization, failure recovery, and extra capacity costs. Track TTFT and decode cadence across the handoff; a fast prefill pool can still starve a smaller decode pool.

Use the [GQA example from the request lifecycle](02-serving-lifecycle.md#work-the-gqa-number-before-choosing-concurrency). Its 4,096-token prefix contains 512 MiB of logical BF16 KV data. Moving 20 such prefixes each second requires about 10 GiB/s of payload before protocol headers, retries, extra copies, or temporary duplication. Cache quantization or a sharded transfer can change per-link traffic, but the aggregate state does not disappear. This calculation often rejects a disaggregation diagram before implementation work starts.

```text
KV handoff payload = 512 MiB/request x 20 requests/s = 10 GiB/s
```

## Count communication at the boundary you plan to cross

Suppose each tensor-parallel rank contributes a 256 MiB shard that must be all-gathered across four ranks at one layer boundary. Each rank needs the other three shards, so it receives 768 MiB of useful payload for that collective. The physical fabric may carry more bytes because an algorithm forwards chunks through intermediate ranks and adds protocol work. Repeating a collective at many model layers makes link placement part of every token step, not a one-time model-load cost.

If four GPUs with fast peer links sit inside each node and the cross-node link is slower, keep each four-rank tensor group inside one node when memory and engine support permit it. Run a second complete tensor group on the second node as a data-parallel replica. Independent requests then cross the node boundary only through routing and service traffic, while the frequent tensor collective stays on the faster fabric. This plan costs another full sharded model copy and separate KV capacity, which must appear in the memory budget.

_Useful payload is not a link-time prediction. Collective algorithm, topology, concurrency, and transport add details._

```text
four ranks, one 256 MiB shard per rank
all-gather output per rank = 4 x 256 MiB = 1,024 MiB
new payload received per rank = 3 x 256 MiB = 768 MiB
```

## One slow rank can set the latency for the group

Collective participants wait at synchronization points. A rank delayed by a slow kernel, host scheduling, a corrected device error, thermal throttling, network retransmission, or another job's traffic can extend the step for every peer. A process crash may surface as a timeout or connection error on a different rank, so the first visible log line is not always the original fault.

Attach rank, node, device, process group, model shard, and request batch identifiers to traces without exposing tenant data. Compare per-rank arrival time at the collective, collective duration, bytes, chosen transport, GPU kernel time, device error counters, and link throughput. Verify the actual rank-to-device and device-to-NIC map. For disaggregated prefill, also trace KV transfer queue, bytes, serialization, destination allocation, and retry ownership. Recovery needs a bounded timeout and a rule for whether the whole parallel group restarts, a request is retried elsewhere, or work is rejected to preserve capacity.

Recent NCCL releases expose a reliability, availability, and serviceability (RAS) subsystem that can report communicator and rank status, operation-count mismatches, incomplete peers, and dead processes. Treat that output as versioned diagnostic evidence rather than a replacement for request and per-rank traces; a communicator can be healthy while one rank consistently arrives late.

- Symmetric slowdown across ranks suggests a shared link or collective shape.
- One consistently late rank suggests placement, device, host, or local contention.
- Rising transfer queue with idle decode devices suggests handoff or allocation trouble, not prefill compute.

## Summary

Distributed inference divides weights, layers, experts, context, or requests across devices, then pays for coordination at every boundary. The useful parallelism depends on model structure and physical topology; a synchronized group runs at the pace of its slowest rank.

- **Match the split to the constraint and keep the group small.** Replication handles independent traffic; sharding makes an oversized model or request fit but couples ranks. Tensor, pipeline, expert, and context splits partition different state and introduce different communication.
- **Name every replicated and sharded state.** Weights are only part of the footprint; KV cache, adapters, tokenizer state, scheduler metadata, activations, and collective buffers can dominate placement or transfer.
- **Map collectives to links.** All-reduce combines and redistributes values, reduce-scatter leaves reduced shards, all-gather reconstructs shards, and all-to-all exchanges distinct pieces. Their frequency and placement make NVLink-class fabrics, PCIe, NICs, and NUMA topology part of token latency.
- **Count bytes at the chosen boundary.** With four ranks and a 256 MiB shard per rank, each rank receives 768 MiB of useful payload during an all-gather. Physical traffic can be higher, and repeating the collective across many layers multiplies the cost.
- **Treat disaggregated prefill/decode as a transfer design.** Separate pools can isolate phase interference and scale differently, but request ownership and KV transfer add network bandwidth, latency, buffering, and failure cases.
- **Put a byte rate on the KV handoff.** A 512 MiB prefix handed off 20 times per second is about 10 GiB/s before protocol and retry overhead. Compare that demand with the actual GPU-to-NIC route, not a switch's aggregate headline.
- **Diagnose the slowest rank, not only the reporter.** Kernel stalls, host pauses, thermal limits, corrected device errors, retransmissions, or neighbor traffic can hold every peer at a collective. Correlate per-rank timelines because the first timeout may appear away from the original fault.

## References

- [NVIDIA: NCCL user guide](https://docs.nvidia.com/deeplearning/nccl/user-guide/)
- [Megatron-LM tensor parallelism](https://arxiv.org/abs/1909.08053)
- [GPipe pipeline parallelism](https://arxiv.org/abs/1811.06965)
- [Switch Transformers](https://www.jmlr.org/papers/v23/21-0998.html)
- [NVIDIA Megatron Core: context parallelism](https://docs.nvidia.com/megatron-core/developer-guide/latest/user-guide/features/context_parallel.html)
- [DistServe: disaggregating prefill and decoding](https://www.usenix.org/conference/osdi24/presentation/zhong-yinmin)
- [vLLM: parallelism and scaling](https://docs.vllm.ai/en/stable/serving/parallelism_scaling/)
- [TensorRT-LLM: parallelism](https://nvidia.github.io/TensorRT-LLM/latest/features/parallel-strategy.html)
- [NCCL: RAS diagnostics](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting/ras.html)

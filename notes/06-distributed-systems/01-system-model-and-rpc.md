---
title: The Distributed System Model and One Remote Call
shortTitle: System model and RPC
description: Trace one request across independent processes, define the timing and failure model, and make ambiguous RPC outcomes safe to retry.
collection: distributed-systems
slug: system-model-and-rpc
order: 1
number: DS1
duration: 2.5 hours
difficulty: Beginner
tags:
  - system-model
  - RPC
  - deadlines
  - retries
  - idempotency
  - partial-failure
---

## Working model

A distributed call is a message exchange between independent processes. The familiar function-call syntax ends at the process boundary; delay, duplication, uncertainty, and partial failure begin there.

## Questions this note answers

- Define a distributed system without relying on the word "cloud"
- State which timing, network, and failure assumptions an algorithm needs
- Follow one RPC through serialization, transport, queuing, execution, and reply
- Explain why a timeout does not reveal whether the server changed state
- Distinguish maybe, at-least-once, at-most-once, and application-level effectively-once behavior
- Make a state-changing request safe with a stable operation ID and stored result
- Set deadlines, retry budgets, backoff, jitter, and cancellation as one policy
- Trace an uncertain call using evidence from both client and server

## Begin with one call across one boundary

A product service calls `ReserveInventory(item=7, quantity=1)`. In local code this may look like an ordinary method. Across a process boundary it expands into a sequence:

1. The client library encodes the method name, arguments, metadata, and operation identity into bytes.
2. Name resolution and load balancing select a server address.
3. A transport connection is reused or established.
4. The operating system copies bytes through sockets and network devices; switches and routers forward packets.
5. The server transport reassembles and decodes the request.
6. The request waits in a listener, worker, or application queue until code can run.
7. The handler validates authority and state, performs storage operations, and creates a result.
8. The server encodes a reply and the network carries it back.
9. The client library converts the reply into a return value or error.

Each numbered boundary can add latency or fail independently. A successful TCP connection does not prove that the handler ran. A server log line does not prove that the reply reached the client. An HTTP or gRPC status describes what one endpoint observed, not a global fact about every side effect.

**Remote procedure call (RPC)** is the abstraction that generates or provides the client stub, message format, dispatcher, and server stub around this exchange. It preserves a convenient interface, but it cannot preserve local-call failure semantics. A local function normally shares one process lifetime and address space with its caller. A remote callee can continue after the caller gives up, can restart with durable state intact, or can execute while its reply is lost.

## Write the system model before judging a protocol

The CS 425 lectures define a distributed system as autonomous, programmable, asynchronous, failure-prone entities communicating through an unreliable medium. That definition forces the important questions into the open.

| Dimension  | Questions to state                                                                      |
| ---------- | --------------------------------------------------------------------------------------- |
| Process    | Can a process crash and recover? Is its memory lost? What state is durable?             |
| Network    | Can messages be delayed, dropped, duplicated, or reordered? Are channels authenticated? |
| Time       | Is there a known upper bound on message or processing delay? How accurate are clocks?   |
| Fault      | Are failures crash-only, or may a participant send arbitrary or malicious messages?     |
| Membership | Is the participant set fixed? Who authorizes a node to join or leave?                   |
| Progress   | What must eventually become timely or available for the protocol to move forward?       |

An **asynchronous** model does not supply a fixed upper bound on message delivery or process scheduling. Therefore a timeout creates suspicion; it cannot prove a crash. A **synchronous** model supplies known timing bounds. Most production algorithms use **partial** or **eventual synchrony**: safety holds through arbitrary delay, while liveness requires a period when a quorum of processes and links behave within practical timing bounds.

The common crash-stop model assumes a failed process halts and never returns. Crash-recovery permits it to restart, so protocol promises depend on which votes, log entries, or deduplication records reached durable storage first. A Byzantine model permits arbitrary behavior and needs different protocols and threat assumptions. Calling every exception a "node failure" erases distinctions that determine whether recovery is safe.

## Separate a network from the service it composes

A network connects machines and exposes their locations. A distributed service uses those machines to present a higher-level abstraction: one key-value map, one filesystem, one queue, or one control plane. Distribution is often hidden in the success path and revealed in the failure path.

Cloud infrastructure changes who owns hardware and how resources are provisioned; it does not repeal distributed-systems constraints. Two virtual machines in one availability zone can still experience process pauses, packet loss, storage latency, or shared dependency failure. Two regions add longer delay and more independent failure domains, but also make synchronous coordination slower and partitions harder to distinguish from ordinary latency. Draw the actual process, network, storage, and administrative boundaries instead of treating "the cloud" as one machine.

## A reply can be lost after the work commits

Consider an inventory service with one item remaining:

```text
client                         server                         database
  | Reserve(op-91)               |                                |
  |----------------------------->|                                |
  |                               | conditional decrement         |
  |                               |------------------------------->|
  |                               |                         COMMIT |
  |                               |<-------------------------------|
  |                         reply |                                |
  |                         -X----|  connection breaks             |
  | deadline expires              |                                |
```

From the client's viewpoint, the request failed. From the database's viewpoint, it committed. The same client observation would occur if the request never left the machine, if the server rejected it, or if the server crashed before committing. This is the **ambiguous outcome** at the center of remote state changes.

Retrying `decrement inventory` blindly may sell the item twice. Never retrying may tell the user the reservation failed even though it succeeded. The protocol needs an identity for the logical operation and a way to recover its result.

## Name delivery and execution semantics precisely

The classical labels describe what a transport or RPC layer attempts, but application correctness depends on durable state.

| Label            | Mechanism                                                                                                                | Remaining problem                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Maybe            | Send once and report whatever is observed                                                                                | Loss may mean zero or one execution                                                          |
| At-least-once    | Retry until a response or terminal deadline                                                                              | The handler may execute more than once                                                       |
| At-most-once     | Detect duplicate request IDs and avoid re-executing known calls                                                          | A call may execute zero times; deduplication state can expire or be lost                     |
| Effectively once | Commit the business transition and durable operation result atomically, then replay the result for the same operation ID | Requires a defined identity scope, retention policy, and reconciliation for external effects |

"Exactly once" is unsafe shorthand unless the boundary is stated. A stream processor may apply an event exactly once to its checkpointed internal state while an email or payment call from that handler occurs twice. A database transaction can atomically store both an order and an operation record, but it cannot atomically control an unrelated provider without a wider protocol.

An operation is **idempotent** when repeating it has the same intended effect as doing it once. Reading object 7 is usually idempotent. `SetStatus(order=4, paid)` can be idempotent if authorization and version rules are stable. `IncrementBalance(10)` is not. A stable operation ID can make a non-idempotent business action safely repeatable:

```text
transaction:
  if operation_results contains "op-91":
      return stored result
  verify item 7 has stock
  decrement stock
  store operation_results["op-91"] = reservation 431
commit
```

The operation ID belongs to the user's logical action, not to a network attempt. Store it in the same transactional authority as the protected state. Define how long the result remains available and what happens if a caller reuses the ID with different arguments.

## Treat deadlines, cancellation, and retries as one budget

A **timeout** is a duration; a **deadline** is the latest acceptable completion time. Pass the remaining deadline downstream so a ten-second request does not become ten sequential ten-second waits. Modern RPC libraries may convert propagated deadlines to remaining timeouts to avoid relying on synchronized wall clocks.

When a client deadline expires, the server may already be running. Cancellation is a request to stop unnecessary work, not a rollback. Handlers must observe cancellation and stop child work where safe, but committed state remains committed.

Retries consume capacity precisely when the system is struggling. A safe retry policy includes all of these:

- Retry only errors whose contract says another attempt may help
- Retry only operations that are read-only, naturally idempotent, or protected by stable deduplication
- Use exponential backoff with jitter so clients do not synchronize into another load spike
- Cap attempts and total elapsed time under the original deadline
- Propagate a retry budget through service layers so each layer does not multiply attempts
- Honor explicit server pushback and shed load before queues grow without bound
- Measure attempts per logical operation, not only the final success rate

Hedging sends another copy before the first attempt fails to reduce tail latency. It can also double work and worsen overload, so reserve it for safe operations with spare capacity and cancel losing attempts.

## Work one ambiguous reservation case

The client assigns `op-91`, a deadline two seconds away, and attempt number one. The server begins a transaction. It first looks up `op-91`; none exists. It conditionally decrements item 7 only if stock is positive and writes the reservation plus result record in the same commit. The reply is lost.

At 600 ms the client has no response. It waits according to its retry policy, then sends attempt two with the same `op-91` and the remaining deadline. A different server receives it. That server reads the durable operation result and returns reservation 431 without touching stock. Both attempts refer to one business operation, and the stored outcome answers the uncertainty.

If the first transaction never committed, attempt two performs it. If the outcome store is temporarily unavailable, the service must not guess and execute unprotected; it should return an unavailable or indeterminate result that preserves the invariant. A later reconciliation job can query by `op-91`.

## Debug the path from both ends

For one failed call, collect the logical operation ID, per-attempt ID, client start time and deadline, selected endpoint, connection result, bytes sent, server receipt, queue delay, handler start and finish, storage transaction ID, commit evidence, reply write, and client receipt. Use monotonic durations for latency and wall-clock timestamps only as approximate cross-host correlation unless clock uncertainty is known.

Separate these questions:

- **Reachability:** did packets and a connection reach the intended endpoint?
- **Admission:** did a listener, proxy, or queue accept the request?
- **Execution:** did application code begin, and under which attempt identity?
- **Authority:** was this server permitted to make the state transition?
- **Durability:** which transaction or log position committed?
- **Observation:** which response, if any, did the client receive before its deadline?

An RPC error alone answers none of the later questions. The operation ID is what lets logs, traces, database state, and retry behavior describe one logical action.

## Summary

A distributed service begins when an operation crosses into an independently failing process. RPC makes that call convenient, but the application must define what delay, timeout, retry, and ambiguous completion mean.

- **State the system model.** Name timing, network, process, durability, membership, and fault assumptions before assessing an algorithm.
- **Trace the expanded call.** Serialization, transport, queues, handlers, storage, and the return path each create separate latency and failure boundaries.
- **A timeout is local evidence.** It says the client stopped waiting, not whether the server committed.
- **Use stable logical operation IDs.** Atomically store the business transition and its result, then return the same result to duplicate attempts.
- **Bound recovery traffic.** Deadlines, cancellation, backoff, jitter, retry budgets, and load shedding form one policy.
- **Debug execution and observation separately.** Server commit and client receipt are distinct events joined by durable identity and trace evidence.

## References

- [CS 425 Fall 2025 L1: introduction](https://courses.grainger.illinois.edu/cs425/fa2025/L1.FA25.pdf)
- [CS 425 Fall 2025 L2-3: cloud computing](https://courses.grainger.illinois.edu/cs425/fa2025/L2-3.FA25.pdf)
- [CS 425 Fall 2025 L19-20: RPCs and concurrency control](https://courses.grainger.illinois.edu/cs425/fa2025/L19-20.FA25.pdf)
- [Birrell and Nelson: Implementing Remote Procedure Calls](https://www.microsoft.com/en-us/research/publication/implementing-remote-procedure-calls/)
- [gRPC core concepts](https://grpc.io/docs/what-is-grpc/core-concepts/)
- [gRPC deadlines](https://grpc.io/docs/guides/deadlines/)
- [gRPC retry guide](https://grpc.io/docs/guides/retry/)

---
title: Time, Causality, and Distributed Snapshots
description: Separate wall time from causal order, assign Lamport and vector timestamps, and capture a consistent global state without stopping every process at once.
slug: time-causality-and-snapshots
order: 2
identifier: DS2
duration: 3 hours
difficulty: Core
tags:
  - clocks
  - NTP
  - happens-before
  - Lamport-clock
  - vector-clock
  - distributed-snapshot
---

## Working model

No process can directly observe a global present. Physical clocks estimate when events occurred, logical clocks record which events could have influenced others, and a distributed snapshot records one causally consistent cut through an execution.

## Use different clocks for different questions

"What time did this happen?" hides several questions. A log viewer wants a civil timestamp that humans can compare with a calendar. A timeout needs the amount of time that passed. A replicated service may need to know whether one update depended on another. A checkpoint tool needs a coherent state across processes and messages. One clock API cannot answer all four safely.

A **wall clock** approximates Coordinated Universal Time (UTC). Operators need it for logs, certificates, retention rules, and user-facing dates. An administrator or synchronization daemon may correct it, so it can jump forward or backward. A **monotonic clock** advances from an unspecified origin and should not step backward during one boot. Use it for deadlines, queue delay, leases whose implementation explicitly permits it, and latency measurements on one host.

Each machine has an oscillator whose rate differs slightly from the ideal rate. **Offset** is the difference between a local reading and a reference at an instant. **Frequency error**, often called drift rate, describes how quickly that offset changes. Two hosts can show the same reading now and separate later because their oscillators run at different rates. Temperature, hardware, power state, and clock discipline affect the result.

The CS 425 bus example makes the cost visible: a clock that is late can miss the bus, while a clock that is fast causes an unnecessary wait. Distributed software has the same split. An incorrect expiry time can accept an old credential or reject a valid one; an incorrect duration can fire a retry too early and add load to a slow service.

## Treat synchronized time as an estimate with an error bound

Suppose client C exchanges one NTP-style request with server S. The four timestamps are:

```text
t1  C sends request
t2  S receives request
t3  S sends response
t4  C receives response
```

The usual estimates are:

```text
round-trip delay = (t4 - t1) - (t3 - t2)
clock offset     = ((t2 - t1) + (t3 - t4)) / 2
```

The offset formula effectively splits the unexplained network delay equally between the outbound and return paths. Real routes can be asymmetric, and queuing can affect one direction more than the other, so the estimate still has error. Repeating measurements helps reject noisy samples; it cannot reveal the exact one-way delays without another timing assumption.

NTP is also more than one client following one parent in a strict tree. Servers have strata, clients can consult several peers, and the protocol filters candidates before disciplining the local clock. The hierarchy traces reference quality; it does not create one instantaneous time value visible everywhere.

Applications should preserve the uncertainty instead of silently converting an estimate into fact. Google Spanner's TrueTime interface is a useful example because it returns an interval known to contain absolute time. Spanner waits out that uncertainty where its external-consistency protocol requires it. Ordinary NTP-synchronized hosts should not copy that design claim unless their time service supplies and enforces a comparable bound.

Wall timestamps remain useful evidence during an incident, but order logs by trace relationships, request IDs, log positions, or causal metadata when correctness depends on order. A timestamp with millisecond precision can still be wrong by more than a millisecond.

## Define causality from program order and messages

Leslie Lamport's **happens-before** relation, written here as `a -> b`, starts from information flow rather than clock readings:

1. If events `a` and `b` occur in that order in one process, then `a -> b`.
2. Sending a message happens before receiving that same message.
3. The relation is transitive: if `a -> b` and `b -> c`, then `a -> c`.

These rules produce a partial order. If neither `a -> b` nor `b -> a`, the events are **concurrent**. Concurrent does not require the events to occur at the same physical instant. It means the execution contains no causal path from one to the other.

Suppose process A creates order 817, sends a message to process B, and B reserves stock. Creating the order happens before the send; the send happens before B receives it; receipt happens before the reservation. By transitivity, order creation happens before reservation. An unrelated cache refresh on process C may have a smaller wall timestamp than the reservation and still be concurrent with it.

The local-order rule is program order, not wall-clock order. A clock adjustment cannot reverse the fact that one process executed instruction 12 before instruction 13.

## Lamport clocks preserve one direction of the relation

Each process can maintain an integer logical clock:

- Increment it before assigning a timestamp to a local or send event.
- Attach the current value to every sent message.
- On receive, set the local clock to `max(local, received) + 1` and assign that value to the receive event.

These rules give the clock condition:

```text
a -> b  implies  L(a) < L(b)
```

The converse is false. If `L(a) < L(b)`, the events may be causally related, or they may be concurrent and happen to have different counter values. Equal Lamport values on different processes also do not mean simultaneous wall time.

Imagine two processes starting at zero. A timestamps local event `create` as 1 and sends a message stamped 2. B's clock is already 5 because it handled unrelated work. When B receives the message, it records `max(5, 2) + 1 = 6`. The receive is later in logical time than the send, even though B's earlier counter values came from unrelated events.

A pair `(Lamport timestamp, process ID)` can impose a deterministic total order for a queue or tie-breaker. That total order includes arbitrary choices between concurrent events; it does not turn those choices into causality. State this whenever a protocol uses Lamport clocks to order requests.

## Vector clocks retain enough information to detect concurrency

A vector clock assigns one counter slot to each participant. Process `i` increments slot `i` for its local event or send. A message carries the full vector. On receive, the process takes the component-wise maximum of its local vector and the message vector, then increments its own slot.

For vectors `V` and `W`:

```text
V <= W  when every component of V is <= the corresponding component of W
V < W   when V <= W and at least one component is smaller
V || W  when neither V <= W nor W <= V
```

With faithfully assigned vector clocks, `V(a) < V(b)` tells us that `a -> b`. Incomparable vectors identify concurrent events. For example, `(3,1,0)` and `(2,1,4)` are concurrent: the first knows more about process 1, while the second knows more about process 3.

That precision costs metadata. A fixed vector has one component per participant, which becomes awkward when thousands of processes join and leave. Replicated stores often use version vectors scoped to a replica set or object, dotted version vectors, or another compressed causal context. The data structure and membership rules must agree about who owns each counter slot. Reusing an old process identity after data loss can make new events look like continuations of old ones.

Vector clocks identify a conflict; they do not decide what the product should do with it. Concurrent shopping-cart additions may merge as a set union, while two owners assigned to one username require rejection or coordination.

## A global state includes local state and messages in transit

A debugger can pause one process and copy its memory, but a distributed service has no shared pause button. By the time it copies process B, process A may have sent another message. A useful **global state** therefore contains:

- The recorded local state of every process
- The recorded state of every communication channel, meaning messages sent before the cut but received after it

Picture one execution as horizontal process timelines. A **cut** selects a prefix of events from each timeline. A cut is causally consistent when it never includes a receive without including the corresponding send. It may include a send without its receive; that message belongs to the channel state.

An inconsistent cut can invent impossible state. Suppose the inventory process's snapshot includes `stock = 0` after it handled a reservation, but the order process's snapshot predates sending that reservation. No execution prefix contains that pair of facts. Restoring it would lose one unit without any order that explains the loss.

## Chandy-Lamport records a consistent cut while work continues

The original Chandy-Lamport algorithm assumes reliable FIFO channels and processes that follow the marker protocol. It does not require synchronized physical clocks, and it does not stop application messages.

An initiating process records its local state, then sends a **marker** on every outgoing channel before sending later application messages on those channels. When another process receives its first marker, it records its local state and sends markers on all outgoing channels. For the incoming channel that delivered the first marker, it records an empty channel state because FIFO order guarantees that no earlier application message remains behind that marker.

For every other incoming channel, the process records application messages arriving after its local-state recording until a marker arrives on that channel. Those messages were sent before the sender recorded its state but arrived after the receiver recorded its state, so they cross the cut. Once a process has received a marker on every incoming channel, its part of the snapshot is complete.

FIFO matters. A marker cannot overtake an earlier application message on the same channel. If the transport can reorder messages, the system needs sequence information, a barrier, or a snapshot variant with different channel assumptions. Likewise, the algorithm records state; it does not by itself copy files atomically, freeze an external payment provider, or decide how to restart a process that crashes mid-snapshot.

## Work one reservation snapshot

Two processes communicate over reliable FIFO channels. A owns order state; B owns inventory. A has already sent `reserve(op-91)` to B, but the message remains in transit.

1. B initiates a snapshot. It records `stock = 1`, then sends a marker to A.
2. A receives B's marker. A records `op-91 = reservation_sent` and sends its marker to B on the A-to-B channel.
3. Because the channel is FIFO, B receives the earlier `reserve(op-91)` before A's marker. B applies it and changes live state to `stock = 0`. Its recorded local state remains `stock = 1`.
4. B records `reserve(op-91)` as channel state because the message arrived after B recorded its local state and before B received A's marker.
5. B receives the marker and stops recording that channel.

The snapshot now says:

```text
A local state: op-91 = reservation_sent
B local state: stock = 1
A -> B channel: reserve(op-91)
```

That state is consistent. Replaying the in-transit message after restoring the two local states produces `stock = 0`, matching the live computation after step 3. A snapshot containing A's send and B's pre-receive state but omitting the channel message would not preserve the computation.

Now add a payment provider outside the marker protocol. A charge may complete even though no participating process has durably recorded its result. Chandy-Lamport cannot capture that provider's private state. A recoverable design needs an idempotency key, a durable local intent and observed result, plus reconciliation with the provider.

## Use snapshots for stable properties and recovery with care

The original paper uses snapshots to detect **stable properties**, facts that remain true once they become true, such as distributed termination or permanent loss of a token. A consistent cut can also support checkpointing, offline analysis, backup, and debugging.

Turning a recorded cut into a restart point adds work. Persist every process and channel record under one snapshot identity, retain the application version and schema needed to read it, include deduplication state, and define how restored processes reject messages from the abandoned execution. Logs or message brokers may make channel recovery easier by recording offsets instead of copying every in-flight payload.

During an incident, collect both physical and logical evidence. Wall timestamps help align dashboards; monotonic durations explain local stalls; trace edges establish message causality; terms, versions, and log indexes establish authority. If two logs disagree by 400 ms, check clock offset before rewriting the story. If a receive has no visible send, search by operation or message ID before assuming time travel.

## Summary

Distributed time is a set of tools for different jobs, not one universal clock.

- **Use monotonic time for elapsed duration.** Wall time can step and remains an estimate of UTC.
- **Keep synchronization uncertainty visible.** NTP estimates delay and offset from four timestamps, but path asymmetry prevents exact one-way timing.
- **Define causality through execution.** Program order, message delivery, and transitivity create happens-before; unrelated events remain concurrent.
- **Read logical clocks in the right direction.** Lamport timestamps preserve causal order but cannot prove it from a numerical comparison. Vector clocks can distinguish causality from concurrency at a metadata cost.
- **A global state includes channels.** A consistent cut may contain a send without its receive only when it also records the message in transit.
- **Markers capture a cut, not the outside world.** Chandy-Lamport records cooperating processes over its channel assumptions; checkpoint recovery and external side effects need extra protocols.

## References

- [CS 425 Fall 2025 L12: time and ordering](https://courses.grainger.illinois.edu/cs425/fa2025/L12.FA25.pdf)
- [Lamport: Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.org/pubs/time-clocks.pdf)
- [Chandy and Lamport: Distributed Snapshots, Determining Global States of Distributed Systems](https://www.cs.princeton.edu/courses/archive/fall17/cos418/papers/chandy_lamport.pdf)
- [RFC 5905: Network Time Protocol Version 4](https://www.rfc-editor.org/rfc/rfc5905.html)
- [Corbett et al.: Spanner, Google's Globally-Distributed Database](https://research.google.com/archive/spanner-osdi2012.pdf)
- [Linux `clock_gettime` manual](https://man7.org/linux/man-pages/man2/clock_gettime.2.html)

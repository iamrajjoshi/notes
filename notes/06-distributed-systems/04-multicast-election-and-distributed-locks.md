---
title: Order Group Messages, Elect Authority, and Exclude Stale Workers
description: Build from multicast delivery order to reliable views, leader election, distributed mutual exclusion, leases, and fencing without mistaking suspicion for authority.
slug: multicast-election-and-distributed-locks
order: 4
identifier: DS4
duration: 3 hours
difficulty: Advanced
tags:
  - multicast
  - causal-order
  - virtual-synchrony
  - leader-election
  - failure-detectors
  - distributed-locks
  - leases
  - fencing
---

## Working model

A message can arrive before it is safe to expose, a process can look dead while it is only slow, and an old leader can continue running after a replacement is elected. Ordering controls delivery, election chooses a coordinator under stated assumptions, and fencing makes the protected resource reject stale authority.

## Start with the shape of one communication

**Unicast** sends a message from one process to one destination. An RPC request and its reply are usually separate unicasts. **Broadcast** targets every process in a defined scope. The public Internet has no useful global broadcast primitive, so the scope must be named: a link, a subnet, a cluster, or an application membership list. **Multicast** sends one logical message to a selected group. Its implementation may use a network multicast facility, a broker, a tree, or many unicasts.

The sender calling `multicast(group, m)` does not mean every member has already seen `m`. At a receiver, distinguish two events:

- **Receive:** the protocol layer obtains the message from the network.
- **Deliver:** the protocol hands the message to application code.

A protocol may receive `m2`, place it in a hold-back buffer, receive missing `m1`, deliver `m1`, and only then deliver `m2`. This delay is not accidental latency; it is how the layer preserves an ordering promise. The application should reason about delivery order, while operators also inspect receive order and buffered messages to explain the delay.

## Choose the order the application actually needs

Ordering promises rule out different histories. They are not interchangeable.

| Order  | Promise                                                                                             | What remains unordered                                                                              |
| ------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| FIFO   | Each sender's messages are delivered in that sender's send order                                    | Messages from different senders                                                                     |
| Causal | If sending one message may have influenced sending another, every receiver delivers the cause first | Concurrent messages with no happens-before relation                                                 |
| Total  | Every receiver delivers the messages it delivers in the same global order                           | The order need not preserve causality or each sender's order unless the protocol also promises that |

Suppose P1 sends `profile-created` and later sends `welcome-email-requested`. FIFO order prevents one receiver from seeing P1's second message first. Now P2 receives `profile-created` and sends `avatar-index-requested` in response. The two sends occurred at different processes, but the second depends on the first. Causal order preserves that relationship; FIFO alone does not. If P3 independently sends `metrics-rollup`, it is concurrent with P2's request and causal order permits different receivers to place the two concurrent messages in different orders.

Total order answers another need. Replicas applying non-commutative commands such as `set owner = A` and `set owner = B` must choose the same order or they diverge. A sequencer can assign increasing numbers, but then the sequencer is an authority whose failure, duplication, and replacement need a protocol. Total order alone also does not promise that every correct member receives a message.

## Follow FIFO and causal delivery through a buffer

For FIFO multicast, each sender attaches a strictly increasing sequence number. Receiver R records the largest sequence delivered from each sender. If R has delivered P1 sequence 4 and receives P1 sequence 6, it buffers 6 because 5 is missing. Once 5 arrives, R delivers 5, advances its record, and then releases 6. Sequence numbers also identify duplicates; a value at or below the delivered position is not delivered again.

Causal delivery needs more context. In a fixed group of four processes, a vector such as `[3, 1, 0, 2]` records how many messages from each process the sender knows have been delivered. When P2 sends its next message, the receiver must verify two facts: this is the next P2 message, and every dependency in the other vector positions has already been delivered locally. Otherwise it buffers the message.

Use this worked history:

```text
P1 sends A with vector [1,0,0,0]
P2 delivers A, then sends B with [1,1,0,0]
P4 delivers A, then sends C with [1,0,0,1]
P3 receives B and C before A: buffer both
P3 receives and delivers A: both B and C become eligible
```

B and C each depend on A, but neither depends on the other. P3 may deliver B then C or C then B. Forcing one order would be a stronger total-order rule, not a requirement of causality. Vector clocks make this relationship explicit, but their metadata grows with the group and their indexes become awkward under dynamic membership. Production systems may track dependencies per shard, session, version vector, or log instead of attaching one full cluster-wide vector to every event.

## Add reliability without confusing it with order

A **reliable multicast** specification normally includes validity, agreement, and integrity: a correct sender's message is eventually delivered under the stated assumptions; correct recipients agree about delivery; and a message is not invented or delivered repeatedly. Exact definitions differ, especially on whether a message delivered by a process that later fails must reach every correct process. State whether the agreement is **uniform** or only concerns correct deliverers.

A simple teaching protocol has the sender unicast to every member and has each first-time receiver re-send the message to every member. If the sender crashes halfway through, a correct receiver that already obtained the message helps complete dissemination. This is expensive - up to quadratic traffic - and it still needs a stable message ID, duplicate suppression, and a clear rule about whether forwarding happens before application delivery. Real systems use trees, gossip, durable logs, acknowledgements, repair, or consensus according to the required guarantee.

Reliability and ordering are separate axes. A system can implement reliable FIFO, reliable causal, or reliable total delivery. A totally ordered message that never reaches one correct replica has not met reliable agreement. A reliably delivered set that each replica applies in a different order can still diverge.

## Treat membership changes as ordered events

**Virtual synchrony** organizes processes into membership **views**. A view might be `{P1,P2,P3,P4}`; a join, departure, or detected failure installs another view such as `{P1,P2,P3}`. Members agree on the sequence of installed views and on which messages belong to each completed view. This lets application code reason about group communication and membership change as coordinated events rather than unrelated callbacks.

The abstraction does not make an asynchronous network truly synchronous. A failure detector can divide a live cluster during a partition, and two components can form incompatible views unless the membership service has a primary-component or quorum rule. Virtual synchrony by itself is therefore not a consensus substitute. When a group controls external state, pair the view with an epoch and make the external resource accept only the current epoch.

## Introduce election as a safety and liveness problem

A leader election run tries to establish one coordinator and make the surviving participants agree on its identity. Two properties must be kept separate:

- **Safety:** two participants must not obtain valid authority for the same term or protected resource.
- **Liveness:** after failures and communication stabilize within the protocol's assumptions, a usable leader is eventually elected.

A timeout is a suspicion, not proof of a crash. If a failure detector misses a leader that really crashed, the immediate problem is lack of progress: no replacement may be elected, so liveness fails. If it falsely suspects a live leader, another process may try to take over. Without terms, intersecting durable votes, and fencing, both may act, which is a safety failure. False suspicion can also cause repeated elections and hurt liveness, but reversing these primary consequences produces the wrong repair.

## Learn ring and Bully election as constrained examples

In a **ring election**, each process knows a logical successor. An initiator circulates an election message containing a candidate identifier; larger identifiers replace smaller ones. When the winning identifier returns to its owner, that process circulates an elected announcement. The algorithm illustrates deterministic choice and message-complexity analysis. It assumes the ring can route around failures or be repaired. If a failed member remains the next hop, the message stops. Concurrent initiators and membership changes add more state.

The **Bully algorithm** assumes every process knows every identifier. A process suspecting the coordinator contacts higher-ID processes. If none responds within a justified timeout, it announces itself; a higher process that responds starts or continues an election of its own. This can converge in a sufficiently synchronous, stable, failure-free interval, but its timeout cannot guarantee termination in a fully asynchronous network. Neither historical algorithm gives a production resource safe authority merely because one process announces victory.

Production election is usually part of consensus. In a term or ballot, a candidate requests votes from a majority; a participant durably votes at most once per term, and log-freshness rules prevent an obsolete candidate from discarding committed history. Intersecting majorities mean two candidates cannot both collect valid votes in one term. A majority is protocol machinery, not a complete proof by itself: the term rules, durable state, membership transitions, and commit rule matter.

## Understand permission-based mutual exclusion

Distributed **mutual exclusion** allows at most one participant into a critical section. A central coordinator can queue requests and issue one token, but it is a bottleneck and its failover must not create a second token. A circulating ring token removes the central queue but delays access until the token arrives and can stall if the token or a ring member fails.

Ricart-Agrawala is a useful permission-based algorithm under a failure-free process model. A requester chooses a Lamport timestamp and sends `<timestamp, process-id>` to every other process. The pair is ordered lexicographically so concurrent equal timestamps have a deterministic tie-breaker. A receiver replies immediately unless it is inside the critical section or has an earlier outstanding request; otherwise it defers the reply. The requester enters only after every other process replies, and on exit it sends deferred replies.

The ordering is a total extension of causality, not causality itself. In the worst case, one entry uses `N-1` requests and `N-1` replies. If one participant crashes, every requester waiting for its reply can block. Removing the failed participant safely is a membership and consensus problem, not a timeout-only patch.

Maekawa reduces message fan-out by assigning each participant a voting set. Every pair of voting sets intersects, and a voter grants only one request at a time. If P and Q both collected all their votes, an intersection member would have needed to vote for both, so mutual exclusion follows. The basic protocol can deadlock: P waits for a voter held by Q, Q waits for one held by R, and the cycle eventually returns to P. Deadlock-free variants add priorities, failed-attempt messages, inquiries, and yields.

The commonly drawn row-plus-column construction for an `sqrt(N) by sqrt(N)` process grid gives each process `2*sqrt(N)-1` voters. That is `Theta(sqrt(N))`, not literally `sqrt(N)`. The original algorithm studies quorum constructions with `O(sqrt(N))` messages, but constants, deadlock handling, and failures remain operational costs.

## Finish authority with a lease and fencing token

A **lease** grants a holder authority until a time boundary. It limits how long others wait after a holder disappears, but it does not stop the old process at the instant the lease expires. The process may pause during a long garbage collection, lose its lease, wake up, and continue using a cached belief that it is leader.

A **fencing token** is a monotonically increasing number issued with each new grant. The protected resource remembers the greatest token accepted and rejects smaller values. Consider a backup compactor:

```text
t0  worker A receives lease and token 41
t1  A pauses for 45 seconds
t2  lease expires; worker B receives token 42
t3  B writes manifest generation 42
t4  A resumes and sends a write carrying token 41
t5  storage rejects 41 because it has accepted 42
```

The resource, not A's local clock, enforces freshness. If the target cannot compare tokens, the lease does not protect it from stale side effects. An API call to an external payment provider, for example, may instead need a stable idempotency key and provider-side deduplication because it has no fencing field.

## Diagnose authority and progress separately

For an ordering stall, inspect sender identity, message sequence, dependency vector or log position, receive time, delivery time, and the oldest hold-back dependency. For an election storm, compare term, voted-for state, membership, heartbeat latency, pause time, and successful commit position across members. A process saying `leader=true` is weaker evidence than a current term plus a quorum-confirmed commit.

For a lock incident, collect lease ID, expiration calculation, fencing token, resource's highest accepted token, and every rejected stale operation. If requests wait forever in Ricart-Agrawala or Maekawa, draw the missing-reply or wait-for graph before extending a timeout. A longer timeout may hide overload while leaving the authority rule unchanged.

## Summary

Group coordination is a stack of distinct promises. Delivery order controls when an application may observe received messages; reliable multicast controls which correct members deliver them; membership views place those messages around joins and failures; election chooses a coordinator; and fencing prevents a delayed former coordinator from changing protected state.

- **Name the communication scope.** Unicast has one destination, broadcast targets a defined whole scope, and multicast targets a selected group. Receive and deliver are different events because an ordering layer may buffer an arrived message.
- **Choose only the order required.** FIFO preserves each sender's order, causal delivery preserves happens-before dependencies, and total order gives every receiver one common order. Reliability is separate from all three.
- **State the membership and partition rule.** Virtual synchrony coordinates messages with ordered views, but a partition can create incompatible components unless a primary-component, quorum, epoch, or consensus rule selects authority.
- **Correctly classify failure-detector mistakes.** Missing a real crash primarily blocks progress; falsely suspecting a live leader can create competing authority unless terms, durable votes, and fencing preserve safety.
- **Treat classical algorithms as teaching mechanisms.** Ring and Bully elections, Ricart-Agrawala, and basic Maekawa make ordering and quorum arguments visible, but their failure assumptions do not make them production lock services.
- **Fence every time-bounded grant.** A lease can expire while its old holder still runs. A monotonically increasing token enforced by the protected resource makes the stale holder harmless.

## References

- [CS 425 Fall 2025 Lecture 16: Multicast](https://courses.grainger.illinois.edu/cs425/fa2025/L16.FA25.pdf)
- [CS 425 Fall 2025 Lecture 17: Leader Election](https://courses.grainger.illinois.edu/cs425/fa2025/L17.FA25.pdf)
- [CS 425 Fall 2025 Lecture 18: Mutual Exclusion](https://courses.grainger.illinois.edu/cs425/fa2025/L18.FA25.pdf)
- [Lamport: Time, Clocks, and the Ordering of Events in a Distributed System](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)
- [Birman and Joseph: Exploiting Virtual Synchrony in Distributed Systems](https://www.cs.cornell.edu/home/rvr/sys/p123-birman.pdf)
- [Ongaro and Ousterhout: In Search of an Understandable Consensus Algorithm](https://raft.github.io/raft.pdf)
- [Burrows: The Chubby Lock Service for Loosely-Coupled Distributed Systems](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/)
- [Ricart and Agrawala: An Optimal Algorithm for Mutual Exclusion in Computer Networks](https://www.cs.ucf.edu/~eurip/papers/Ricart-Agrawala.pdf)
- [Maekawa: A Square Root N Algorithm for Mutual Exclusion in Decentralized Systems](https://cseweb.ucsd.edu/classes/wi09/cse223a/p145-maekawa.pdf)

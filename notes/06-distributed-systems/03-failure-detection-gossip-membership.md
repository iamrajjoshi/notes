---
title: Failure Detection, Gossip, and Membership
description: Turn silence into bounded suspicion, spread updates without a central broadcaster, and maintain a useful membership view when processes pause, crash, recover, or disagree.
slug: failure-detection-gossip-membership
order: 3
identifier: DS3
duration: 3 hours
difficulty: Core
tags:
  - failure-detector
  - gossip
  - SWIM
  - membership
  - suspicion
  - incarnation
---

## Working model

A membership list is a replicated, changing opinion about which process identities are reachable. Timeouts create suspicion, probes gather more evidence, and gossip spreads that evidence; none of them turns silence into certain proof of a crash.

## Membership starts with identity, not health

A process group needs names before it can discuss failures. A member identity should distinguish one running incarnation from a previous process that used the same address. The record usually includes an address, protocol metadata, an incarnation or generation, and a status such as alive, suspected, leaving, or failed.

Bootstrap answers how a new process learns one or more existing addresses. A seed or introducer helps with discovery; it should not silently become the permanent authority for the group. Join authorization is separate again. If any host can claim an existing identity or inject an `alive` update with a large incarnation number, the membership protocol has become an attack path.

Different applications need different views. A cache may use an approximate live-member set to spread work and recover when it chooses a stale target. A replicated database needs a stricter procedure before moving ownership or deleting the last copy of data. A consensus group cannot admit a new voter merely because gossip found it. State whether the list is a routing hint, an operator catalog, a shard-placement input, or a voting configuration.

## Silence cannot identify one cause

Process A sends a probe to B and receives nothing before its timeout. Several executions fit that observation:

- B crashed before reading the probe.
- The probe or reply was lost.
- A's network path to B failed while another path still works.
- B paused for garbage collection, CPU starvation, disk I/O, or scheduler delay.
- A paused and checked its timer late.
- B replied, but A's receive queue or event loop did not run.

In an asynchronous system there is no fixed upper bound that separates these cases. Waiting longer can reduce mistakes, but it also delays recovery from a real crash. A timeout therefore means, "I did not receive the expected evidence within this policy window." It does not mean, "B is dead."

Suspecting a healthy process is a **false positive**. The phrase names the detector's mistake, not a failure by the suspected process.

Chandra and Toueg formalized failure detectors as information sources that may make mistakes. **Completeness** asks whether crashed processes eventually become suspected. **Accuracy** asks whether correct processes avoid suspicion. Definitions vary in whether every correct observer or at least one observer must obtain the result, and whether accuracy must hold from the start or only eventually. Name the exact variant when a proof depends on it.

Production design adds two costs. **Detection time** measures how long the application waits before some useful observer suspects a failure. **Load** includes probes, replies, retransmission, membership payload bytes, and processing per member. Message count alone can hide a protocol that sends the entire membership list in every packet.

## Compare heartbeat shapes before choosing gossip

A centralized monitor is easy to inspect, but it receives traffic from every member and becomes one failure and scaling boundary. A ring spreads load because each process watches a neighbor. Several adjacent failures can break the chain and delay detection, and a membership change must repair the ring.

All-to-all heartbeating gives every process direct observations, but each member sends or receives work proportional to the group size. One lost heartbeat should not immediately declare a failure; a practical detector uses a timeout or missed-probe policy. Even then, all-to-all traffic becomes expensive as the group grows.

Full-list gossip spreads heartbeat counters or member records through random contacts. It avoids one central monitor and tolerates several paths failing, but the list makes each message grow with the group. SWIM's main design move is to separate a constant-size failure probe from infection-style dissemination of recent membership changes.

The mean-time-to-next-failure arithmetic in the lecture is useful only as an intuition. If one machine fails once per ten years on average and failures are independent with a stable rate, 12,000 machines yield a machine failure somewhere much more often. Real fleets also have correlated rack, power, firmware, dependency, and operator failures, so multiplying one host's mean time by fleet size is not a capacity plan.

## Gossip trades exact simultaneity for spread

In **push gossip**, an informed process periodically selects random peers and sends an update. Push works quickly while few processes know the update because each informed process can create more informed processes. Near the end, many pushes hit peers that already know it.

In **pull gossip**, a process asks random peers for updates it lacks. Pull is slower to get started when almost nobody has the update, but uninformed members actively search near the end. Push-pull combines both phases in one exchange or one protocol.

Under uniform random peer selection, bounded fanout, enough bandwidth, and a connected group, epidemic analyses give dissemination on the order of `log(N)` rounds with high probability. That is not a delivery receipt. A partitioned subgroup hears nothing from the other side, a biased peer sampler can leave members untouched, and a congested core link can invalidate the homogeneous-mixing model.

Topology-aware gossip changes target probabilities so every update does not cross the same router. Payload selection matters too. A busy cluster may generate membership changes faster than one packet can carry them, so implementations prioritize recent updates, retransmit them a bounded number of times, and use pull or anti-entropy to repair omissions.

Gossip provides eventual spread when communication resumes and the update remains eligible for retransmission. It does not give atomic broadcast: observers can receive updates in different orders and hold different views at the same instant.

## SWIM separates probing from dissemination

During one SWIM protocol period, process A selects target B and sends `ping`. If B replies with `ack` before the direct-probe timeout, A has recent path evidence and moves on. If not, A asks a small set of other members with `ping-req(B)`. Each helper sends its own ping to B and relays an acknowledgement to A when B responds.

Indirect probes test different network and scheduler paths. They lower the chance that one broken A-to-B path causes a false suspicion, but they still cannot prove a crash. B may be isolated from all selected helpers, or every process involved may be overloaded.

SWIM chooses roughly one target per member per protocol period, so expected probing load per member stays constant as the group grows. A randomized traversal can ensure that every known member becomes a target within a bounded number of local periods while avoiding the repeated patterns of a fixed ring.

Failure detection produces an update; dissemination carries it. SWIM piggybacks recent join, alive, suspect, leave, and failed records on ordinary probe messages. Updates can also be sent through a separate infection-style broadcast path. Because members hear these records at different times, the service remains weakly consistent.

The original SWIM paper's scale and timing results depend on its network-loss model and protocol parameters. Do not copy a timeout, helper count, or retransmit multiplier from a slide without testing it under the application's pause times, packet loss, member count, and expected recovery window.

## Suspicion gives a healthy process time to refute a mistake

Declaring B failed immediately after one unsuccessful probe makes transient pauses destructive. A suspicion phase adds an intermediate state:

```text
alive, incarnation 12
        |
        | probe evidence times out
        v
suspected, incarnation 12
        |                     |
        | B refutes           | suspicion timer expires
        v                     v
alive, incarnation 13      failed
```

Only B may advance B's incarnation in the basic model. When B receives a suspicion about itself at incarnation 12, it increments to 13 and disseminates `alive(B, 13)`. Higher incarnations override lower ones. Within one incarnation, suspicion outranks alive, so an old equal-incarnation alive packet cannot erase newer suspicion. A final failed record or tombstone prevents an older alive record from resurrecting a removed member.

Tombstones need retention. Delete a failed record immediately and a delayed alive update can make the member reappear. Retain every tombstone forever and metadata grows without bound. The protocol must tie garbage collection to a dissemination or anti-entropy argument, or require a removed process to rejoin with a fresh identity.

Graceful leave differs from failure. A leaving process can announce intent, drain work, transfer ownership, and receive confirmation. A crash cannot perform those steps. Treating both as the same status throws away useful safety and operating options.

## Account for the observer's health

Classic SWIM assumes the local detector is healthy enough to schedule probes and process packets on time. A CPU-starved observer can fall behind, accuse healthy peers, and then amplify the error through gossip. HashiCorp's Lifeguard extensions add local-health awareness so a struggling process lengthens some protocol timing and so suspicion reflects information from more than one source.

This does not make a detector certain. It changes how quickly the protocol trusts evidence produced under local distress. Monitor event-loop delay, run-queue pressure, garbage-collection pauses, packet drops, and probe processing latency alongside suspicion counts. Otherwise the alert says "many peers failed" when the detector itself stopped keeping time.

Accrual detectors take another approach. Instead of emitting only alive or failed, they calculate a suspicion value from the observed distribution of heartbeat arrival times. The application chooses a threshold. Apache Cassandra uses a phi-accrual-style detector, and each node makes its own liveness decision; peers can therefore disagree temporarily about whether a node is up.

## Work one paused-member case

Suppose a five-member cache group probes once per second. For this example, direct and indirect probe evidence must arrive within 200 ms, and suspicion lasts five seconds. These are hypothetical numbers, not SWIM defaults.

Member A selects B. B has entered a four-second stop-the-world pause, so it cannot process A's direct ping. A sends `ping-req(B)` to C, D, and E. Their pings reach B's socket queues, but B still does not run; none can relay an acknowledgement in time.

A creates `suspect(B, incarnation 12)` and piggybacks it to C. C sends it to D, while E still considers B alive. The membership views now disagree, which the protocol permits. Routers should avoid assigning new work to a suspected B, but they should not delete B's durable data or elect a conflicting owner solely from this weak view.

After four seconds, B resumes. It processes a queued suspicion about itself, increments its incarnation, and sends `alive(B, 13)`. That higher-incarnation record overrides suspicion at A, C, and D as gossip spreads. B survived; the suspicion phase prevented a transient pause from becoming a final removal.

If B never resumes, each member eventually hears the suspicion and its local timer can advance B to failed. The exact transition times may differ. A higher-level placement system must decide when enough evidence permits repair, and a voting configuration must use its own consensus protocol before changing voters.

Now suppose A, not B, was starved. A would miss replies that reached its receive queue and accuse several peers in succession. Comparing A's local scheduler delay with the indirect-probe paths reveals the pattern. Lifeguard-style local awareness is meant for this case.

## Keep gossip membership separate from authority

Consul exposes the distinction clearly. Its agent-members endpoint returns the eventually consistent gossip view, which can differ by agent. The catalog uses a consensus-backed server path for a stronger view. An operator should not read one `members` response and assume every node agrees.

The same boundary appears in storage. Gossip can tell a coordinator which Cassandra peers appear reachable and can spread token metadata. It does not serialize writes to one key, choose one global leader, or make replica repair unnecessary. Membership answers who may participate; placement, quorum, and consensus protocols answer different questions.

During an incident, collect each observer's member record for the target, incarnation, last successful direct and indirect probe, suspicion start, dissemination receipts, local scheduler delay, packet loss, and recent joins or leaves. Draw the observer-target-helper paths. One node's timeout log is evidence about that path and window, not a death certificate.

## Summary

Failure detection turns missing evidence into a controlled suspicion and membership spreads that suspicion through a changing group.

- **Start with process identity.** Addresses can be reused; incarnations and join authorization keep old and new processes distinct.
- **A timeout cannot identify the cause.** Crash, delay, loss, path failure, and observer pause can produce the same local observation.
- **Measure several detector properties.** Completeness, accuracy, detection time, per-member work, and payload bytes pull the design in different directions.
- **Gossip spreads probabilistically.** Its logarithmic behavior relies on random mixing, connectivity, bounded fanout, and enough capacity.
- **SWIM separates jobs.** Direct and indirect probes gather evidence; piggybacked infection-style messages spread membership changes.
- **Suspicion prevents hasty removal.** A live process refutes a mistake with a higher incarnation, while tombstones block stale resurrection.
- **Membership is not ownership or consensus.** A weak view can route around suspected nodes, but durable placement and voter changes need their own protocols.

## References

- [CS 425 Fall 2025 L5: gossiping](https://courses.grainger.illinois.edu/cs425/fa2025/L5.FA25.pdf)
- [CS 425 Fall 2025 L6: failure detection and membership](https://courses.grainger.illinois.edu/cs425/fa2025/L6.FA25.pdf)
- [Das, Gupta, and Motivala: SWIM, Scalable Weakly-consistent Infection-style Process Group Membership](https://www.cs.cornell.edu/projects/quicksilver/public_pdfs/SWIM.pdf)
- [Chandra and Toueg: Unreliable Failure Detectors for Reliable Distributed Systems](https://research.ibm.com/publications/unreliable-failure-detectors-for-reliable-distributed-systems)
- [Lifeguard: Local Health Awareness for More Accurate Failure Detection](https://arxiv.org/abs/1707.00788)
- [HashiCorp Consul gossip documentation](https://developer.hashicorp.com/consul/docs/concept/gossip)
- [HashiCorp Consul agent-members API consistency](https://developer.hashicorp.com/consul/api-docs/agent#list-members)
- [Apache Cassandra: ring membership and failure detection](https://cassandra.apache.org/doc/stable/cassandra/architecture/dynamo.html#ring-membership-and-failure-detection)

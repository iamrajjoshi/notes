---
title: Consensus and Replicated State Machines
shortTitle: Consensus and replicated logs
description: Build one fault-tolerant authority from terms, quorums, ordered log entries, deterministic application, snapshots, and explicit client retry semantics.
collection: distributed-systems
slug: consensus-and-replicated-state-machines
order: 5
number: DS5
duration: 3 hours
difficulty: Advanced
tags:
  - consensus
  - Raft
  - Paxos
  - quorums
  - replicated-log
  - fencing
---

## Working model

Consensus is a protocol for making one decision survive disagreement, delay, and crash failures. A replicated state machine repeats that decision for a sequence of commands so several machines behave like one durable authority.

## Questions this note answers

- Separate failure detection, leader election, consensus, and replication
- State consensus safety and liveness without saying only "all nodes agree"
- Read a client-visible history and decide whether one register is linearizable
- Separate single-object linearizability from transaction serializability
- Explain why majority quorums prevent two conflicting committed values
- Follow one command through a Raft term, replicated log, commit, and apply step
- Relate Paxos proposers, acceptors, and ballots to the same quorum invariant
- Explain why retries, membership changes, snapshots, and external side effects still need design
- Diagnose a cluster by term, commit index, applied index, and quorum reachability

## Start with the failure that a leader alone cannot solve

Suppose server A is the current leader and accepts `set owner = Alice`. A network partition then isolates A from servers B and C. B and C time out and elect B. If A continues accepting changes while B also accepts changes, the system has two histories. Choosing whichever server reconnects last would discard acknowledged work and could assign one resource to two owners.

A leader-election algorithm answers who should coordinate now. Consensus adds durable evidence that only one history can become committed. Every leadership term has a monotonically increasing number, a candidate needs votes from an intersecting quorum, and a value is committed only under the protocol's replication rules. A stale leader may still run, but it cannot collect the quorum required to commit new work.

Failure detection is another separate layer. A timeout reports that a response did not arrive within an expected interval; it cannot distinguish a crashed peer from a slow peer or a broken path. The suspicion is useful for starting an election, but the term and quorum rules protect safety if the suspicion was wrong.

## Define the problem before naming an algorithm

For a single consensus instance, participants propose values and must satisfy three properties:

- **Agreement:** no two correct participants decide different values.
- **Validity:** a decided value came from the permitted proposal set rather than appearing from nowhere.
- **Termination:** correct participants eventually decide, under the liveness assumptions of the algorithm.

Agreement and validity are safety properties: a finite execution can demonstrate their violation. Termination is a liveness property: the system must eventually make progress. These need different assumptions. The Fischer–Lynch–Paterson (FLP) impossibility result says that a deterministic consensus protocol cannot guarantee termination in a completely asynchronous system with even one possible crash. It does not say that consensus is never reached. Practical crash-fault consensus systems use randomized election timeouts and an eventual-synchrony assumption: after some unknown point, enough messages and processing steps arrive within useful bounds for one leader to keep a quorum together.

Standard Raft and Paxos handle crash failures, delayed messages, duplication, and reordering when their storage assumptions hold. They are not Byzantine-fault protocols: a participant that lies, signs conflicting messages, or corrupts protocol state is outside that model.

## Read the client-visible history before claiming consistency

A **client-visible history** records each operation's invocation, matching response, and returned value. Internal messages and replica states may explain the result, but the consistency claim is judged from what clients could observe. **Real-time order** is the partial order between non-overlapping operations: if operation A returns before operation B is invoked, A must come before B.

For one register, **linearizability** asks whether every completed operation can appear to take effect once at some instant between its invocation and response. The resulting order must obey the register's sequential rules and real-time order. Overlapping operations have no real-time order between them, so either placement may be legal if it explains their results.

Take a register whose initial value is `pending`:

```text
Passes:
t1  C1 invokes write(paid)
t2  C1 receives ok
t3  C2 invokes read()
t4  C2 receives paid

Fails:
t1  C1 invokes write(paid)
t2  C1 receives ok
t3  C2 invokes read()
t4  C2 receives pending
```

The first history can place the write before the read. The second cannot: the write completed before the read began, so real-time order forbids placing the read first, while the register's rules forbid returning `pending` after `paid` was written.

**Serializability** asks a different question about committed transactions that may touch several objects. Their reads and effects must equal some serial, one-at-a-time transaction order, but that order need not respect real time. **Strict serializability** adds the real-time requirement. A service can therefore have linearizable single-object operations without making a multi-object read-check-write sequence serializable.

These are client contracts, not consequences of one internal mechanism. Quorum intersection is one part of an implementation proof: the rest must show how writes are ordered, how accepted state survives, how current authority is established, and why a read cannot return an older committed value. [DS7: Replication, consistency, and transactions](./07-replication-consistency-and-transactions.md) develops the full model.

## Quorum intersection carries the safety argument

With five voting members, a majority is three. Any two sets of three share at least one member. The protocol constrains how that overlapping voter may vote or accept values, so two disjoint groups cannot each commit a conflicting value for the same log position.

Consider a partition of `{A, B, C}` and `{D, E}`. The three-member side can elect and commit. The two-member side may continue serving stale observations if the API permits them, but it cannot safely elect a new leader or acknowledge writes as committed. Waiting for every node would lose progress after one failure; accepting any two nodes would allow two separate pairs to decide conflicting values. The majority is not a popularity rule. It is an intersection construction.

Quorum math does not by itself make a storage system linearizable. The protocol must bind votes to terms or ballots, preserve accepted log state durably, restrict leader eligibility, and define when reads are allowed. A broken implementation can count majorities and still violate safety.

## Turn repeated consensus into a replicated state machine

A service becomes a deterministic state machine when its next state and output are functions of its current state and one input command. If every replica begins from the same state and applies the same commands in the same order, every replica reaches the same state. Consensus supplies that order.

The log contains commands such as `reserve(item=7, operation=op-91)`, not arbitrary mutations made independently on each replica. Nondeterministic inputs such as wall-clock time, random numbers, or external API results must be chosen before the command is committed or represented explicitly in it. Otherwise replicas could apply the same log entry and still diverge.

The important positions are distinct:

| Position       | Meaning                                                       |
| -------------- | ------------------------------------------------------------- |
| Last log index | Highest entry stored locally; it may still be uncommitted     |
| Commit index   | Highest entry the protocol has made durable and authoritative |
| Applied index  | Highest committed entry executed by the local state machine   |
| Snapshot index | Highest applied prefix represented by a compact snapshot      |

A follower can have the latest committed log but an older applied state because its state machine is slow. Another follower can contain uncommitted entries from an old leader that will later be overwritten. Treating either follower's last stored entry as authoritative is incorrect.

## Follow one command through Raft

Assume five members are in term 8 and A is leader. A client sends operation `op-91`.

1. A validates the command and appends it to its local log at index 42 with term 8.
2. A sends append requests containing the preceding log position and term to its followers. That prefix check prevents a follower from silently attaching the command to a different history.
3. B and C store the entry durably and acknowledge. A now has the entry on a majority: A, B, and C.
4. Under Raft's commit rules, A advances its commit index and applies the command to its state machine. That deterministic transition first looks up `op-91` in a replicated deduplication table. If the operation is new, the same transition performs the reservation and stores its result under `op-91`; the business mutation and deduplication record are one atomic state-machine update.
5. A replies only after that transition has been applied, using the stored result. A process-local cache may make later lookups faster, but it is never the authority for the retry guarantee.
6. Later append messages tell the other followers the new commit index; each applies entry 42 in order after applying every earlier committed entry.

If A crashes after step 3 but before replying, the client does not know whether the operation committed. Retrying with a new operation identity could reserve twice. Retrying `op-91` lets the state machine return the stored result without repeating the business effect. This remains true if A crashes immediately after application because the result was not written in a separate post-application step. Consensus orders attempts; it does not infer that two differently identified commands represent one user action.

Raft has a subtle current-term rule. A leader does not declare an older-term entry committed solely because it observes that entry on a majority. It first commits an entry from its own current term; the log-matching and election restrictions then carry earlier entries with it. This prevents an old entry that appears replicated from conflicting with a history that a future eligible leader may hold.

## Read Paxos through ballots and accepted values

Paxos separates roles conceptually into proposers, acceptors, and learners, although one process may perform several roles. A proposer uses a numbered ballot. During preparation, a quorum of acceptors promises not to accept lower-numbered ballots and reports any value it previously accepted. The proposer must carry forward the value associated with the highest reported accepted ballot, or may choose a fresh value if none exists. It then asks a quorum to accept that value under its ballot.

The overlap between the prepare quorum and an earlier accept quorum ensures that a later successful proposer learns enough to preserve an already chosen value. Multi-Paxos establishes a stable leader and repeats the accept phase for log slots, avoiding a full preparation round during steady leadership. Raft packages comparable safety ideas into explicit terms, a strong leader, and a contiguous log to make the whole replicated-log protocol easier to follow.

Do not translate the roles mechanically and assume every implementation is identical. The useful shared questions are: what is the monotonic epoch, which records are durable before a response, which quorums intersect, how is a new leader prevented from omitting committed work, and when may the client believe a result?

## Membership, snapshots, reads, and side effects remain protocols

Changing voters cannot be treated as editing a configuration file on each machine. If an old configuration and a new configuration can each form nonintersecting majorities during the transition, they can elect conflicting leaders. Safe reconfiguration uses an overlapping transition, such as joint consensus, or another protocol whose old and new decision quorums intersect.

Logs also cannot grow forever. After applying a prefix, a replica can create a snapshot containing the state, included index and term, and any client deduplication records required for correct retry behavior. A lagging follower may install that snapshot and then receive later log entries. Snapshot publication must be atomic enough that recovery finds either the old valid state or the new valid state, never a half-written checkpoint.

A leader's presence does not automatically make every read linearizable. A leader that has lost its quorum may not yet know it is stale. Systems use a fresh quorum confirmation, a read-index protocol, or a carefully bounded lease before answering a linearizable read. Followers can often serve explicitly stale reads, but the API must name that weaker guarantee.

Finally, committing `send email` or `write object to external store` does not make the external effect transactional with the log. The replicated state machine should commit an intent with a stable ID, perform the effect through an idempotent or deduplicated interface, and record the observed result. When an external resource must reject stale leaders, send a monotonically increasing fencing token and make that resource enforce it.

## Inspect authority, durability, and application progress separately

During an incident, collect each member's current term, voted-for record, last log index and term, commit index, applied index, snapshot index, and peer reachability. A node that repeatedly becomes candidate without winning may lack quorum connectivity. A stable leader whose commit index does not advance may be unable to replicate durably to a majority. A growing gap between commit and applied indexes points instead to slow state-machine work. Frequent snapshot installation may mean a follower cannot retain or consume the live log fast enough.

For one client command, trace the operation ID, leader term, log index, quorum acknowledgements, commit transition, application result, and reply. "The leader logged it" is weaker than "the quorum committed it," and "the quorum committed it" is different from "the client received the result."

## Summary

Consensus turns intersecting quorum evidence into one durable decision, and a replicated state machine repeats that decision for an ordered command log.

- **Election, detection, and consensus are different.** A timeout creates suspicion, an election nominates a coordinator, and consensus prevents conflicting histories from both committing.
- **Name the client history before the mechanism.** Linearizability constrains operations on an object and respects real time; serializability constrains transactions and does not imply real-time order unless it is strict.
- **Safety comes from more than counting nodes.** Terms or ballots, durable accepted state, quorum intersection, and leader eligibility rules preserve previously chosen work.
- **Logs have stored, committed, and applied positions.** Confusing them produces stale reads, lost acknowledgements, and misleading incident conclusions.
- **Retries are part of the state machine contract.** Stable operation IDs and durable deduplication results handle the ambiguous interval between server commit and client receipt.
- **Reconfiguration, snapshots, and reads require protocol rules.** Voter sets must transition safely, snapshots must preserve recovery state, and linearizable reads must confirm current authority.
- **Consensus does not atomically control the outside world.** External side effects need idempotency, reconciliation, and fencing against stale actors.

## References

- [CS 425 Fall 2025 final review](https://courses.grainger.illinois.edu/cs425/fa2025/Llast.FA25.pdf): Places consensus and Paxos in the course's dependency map.
- [Herlihy and Wing: Linearizability - A Correctness Condition for Concurrent Objects](https://cs.brown.edu/people/mph/HerlihyW90/p463-herlihy.pdf)
- [Lamport: Paxos Made Simple](https://lamport.azurewebsites.net/pubs/paxos-simple.pdf)
- [Ongaro and Ousterhout: In Search of an Understandable Consensus Algorithm](https://raft.github.io/raft.pdf)
- [Fischer, Lynch, and Paterson: Impossibility of Distributed Consensus with One Faulty Process](https://groups.csail.mit.edu/tds/papers/Lynch/jacm85.pdf)
- [Google: The Chubby Lock Service for Loosely-Coupled Distributed Systems](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/)
- [etcd API guarantees](https://etcd.io/docs/v3.5/learning/api_guarantees/)

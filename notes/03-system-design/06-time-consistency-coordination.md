---
title: Reason About Time, Consistency, and Coordination
description: Specify what concurrent clients may observe, decide what happens during a partition, and use consensus, leases, fencing, outboxes, or sagas only where the invariant demands them.
slug: time-consistency-coordination
order: 6
identifier: SD6
duration: 3 hours
difficulty: Advanced
tags:
  - linearizability
  - serializability
  - CAP
  - Raft
  - leases
  - sagas
---

## Working model

Consistency is a promise about allowed histories. Coordination removes some histories by making participants wait; decide which history would violate the business invariant before paying that latency and availability cost.

For slower derivations, [DS2](../06-distributed-systems/02-time-causality-and-snapshots.md) covers causality, [DS5](../06-distributed-systems/05-consensus-and-replicated-state-machines.md) covers consensus and fencing, [DS7](../06-distributed-systems/07-replication-consistency-and-transactions.md) covers client-visible histories and distributed commit, and [DB4](../07-data-systems/04-transactions-concurrency-and-recovery.md) covers local transaction isolation.

## Read consistency as a rule for observable histories

An operation has an invocation, a response, and a state effect. A **history** is the order and overlap of those operations as clients observe them. Two operations are concurrent when their execution intervals overlap, so the system may have several valid ways to order them. A consistency guarantee rules out some of those histories.

Suppose client A changes order 817 from `pending` to `paid` and receives success. Client B then reads the order. Returning `pending` may violate the product even though one replica has not caught up. If B's read started before A received success, the operations overlap and more outcomes may be allowed. The guarantee needs that timing boundary in writing.

Common promises answer different questions:

| Promise              | Question it answers                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Read-your-writes     | Will one client see a write it already completed?                                                                 |
| Monotonic reads      | Can one client move backward to an older observed version?                                                        |
| Linearizability      | Does each operation appear to take effect at one point between its call and response, respecting real-time order? |
| Serializability      | Is the result of concurrent transactions equivalent to some one-at-a-time transaction order?                      |
| Causal consistency   | Will an observer see a cause before an effect that depends on it?                                                 |
| Eventual convergence | If writes stop and communication resumes, will replicas reach the same state?                                     |

Do not answer "strong consistency" without replacing it with the observation required by a named operation. A profile page may tolerate a stale avatar while an inventory reservation cannot tolerate two successful owners of the last unit.

## Name the guarantee precisely

Linearizability concerns individual operations in real time: once a write completes, a later read cannot return a state older than that write unless another operation changed the state. Serializability concerns transaction outcomes as if transactions ran in some serial order, which need not match wall-clock order. A system can provide one without the other.

Causal consistency preserves cause before effect while allowing unrelated operations to appear in different orders. Eventual consistency promises convergence after writes stop, but says little about what a client reads before convergence.

## Start with the history the business forbids

An invariant is a statement that must remain true across every accepted state transition. Examples include one active username per account namespace, inventory never allocated below zero, or one successful settlement per operation ID. Phrase the rule independently of a database feature. Then identify which records participate and which concurrent actions could break it.

Some rules fit a conditional write on one record. Others require a unique constraint, a serializable transaction, one ordered owner, or coordination across replicas. If temporary conflict is acceptable, clients can write independently and merge later, but the merge rule must preserve the product contract. Last-writer-wins is a conflict policy based on an ordering signal; it does not understand inventory, money, or user intent.

- State the forbidden result before selecting a lock or consensus system
- Name the smallest set of records that must change atomically
- Decide whether rejection, waiting, or later reconciliation is acceptable
- Specify the evidence that proves the rule held after recovery

## Use the smallest mechanism that protects the invariant

Coordination has a latency, failure, and operating cost. Start inside the smallest authority that owns all records in the rule, then widen the boundary only when the invariant crosses it.

| Mechanism                            | Suitable rule                                                                        | What must still be checked                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Conditional write or compare-and-set | Change one record only if its version or state still matches                         | Stable operation identity, retry result, and conflict response            |
| Unique constraint                    | Only one row may own a value such as a username or operation ID                      | Transaction handling when two inserts race                                |
| Transaction with row locks           | A small known set of rows must change together                                       | Lock order, wait deadline, deadlock retry, and replica read behavior      |
| Serializable transaction             | Concurrent reads and writes must behave like a serial order                          | Abort and retry rate under the real contention pattern                    |
| Consensus-backed authority           | Several machines must agree on one ordered control record or leader despite failures | Quorum availability, membership changes, log growth, and client fencing   |
| Asynchronous reconciliation          | Temporary conflict is acceptable and a deterministic merge can repair it             | User-visible conflict, convergence time, poison state, and audit evidence |

Optimistic concurrency stores a version with the record and updates only when the version still equals the one the caller read. Two writers may both compute a result, but only one conditional update succeeds; the loser rereads or reports conflict. Pessimistic locking makes a conflicting writer wait before changing the protected state. Neither approach fixes an invariant whose records live under unrelated authorities unless the design changes ownership or adds a wider protocol.

## CAP asks what you do when messages stop

A network partition means some nodes cannot exchange the messages required to establish current authority within the operation's time limit, even though the nodes themselves may still run. During that partition, a linearizable service can reject or delay operations that cannot reach the required quorum, preserving consistency at the cost of availability. An available service responds on both sides and must permit histories that a single up-to-date copy would reject.

> **CAP is not a database menu.** Latency, steady-state availability, transaction isolation, durability, and conflict resolution remain separate choices. 'Pick two' hides the actual contract.

## Consensus elects authority; fencing proves freshness

Consensus lets several participants agree on an ordered log even when some participants crash or messages arrive late, within the algorithm's failure assumptions. In Raft, a node is a follower, candidate, or leader for a term. A candidate wins a term after receiving votes from a majority. Clients send changes to the leader, which replicates log entries to followers; an entry becomes committed after the required majority has stored it under the protocol's rules. Followers then apply committed entries in order.

A majority is about intersecting quorums, not waiting for every replica. In a five-member group, three members can make progress while two are unavailable; a two-member fragment cannot safely elect a conflicting leader. Consensus does not make every business record globally serializable. Systems commonly use it for cluster membership, partition leadership, configuration, or a small metadata authority, then use other data protocols for the larger workload.

A lease grants authority for a bounded time and can avoid a round trip on each action, but it depends on timing assumptions. An expired holder may pause, wake up, and continue writing because it did not observe the new holder. Pair each grant with a monotonically increasing fencing token. The protected database, storage service, or worker accepts token 44 and rejects any later action carrying token 43, even if the stale process still believes its lease is valid.

## See why two correct local reads can break one rule

An account contains $100. Transaction A reads $100 and plans to withdraw $80; at the same time, transaction B reads $100 and plans to withdraw $50. Each local check passes. If both changes commit without detecting the read-write conflict, the system has approved $130 of withdrawals even if the final stored balance happens to show $20 or $50 because one write overwrote the other.

A serializable execution permits A then B or B then A. In either order, the second withdrawal sees insufficient funds and aborts, so at most $80 leaves. A **register** is the abstract single-value object supplied by read and write operations. Even a linearizable register does not automatically protect this multi-operation check; the read, decision, and update need one atomic conditional transition or a transaction with the required isolation. During a partition, a replica that cannot establish current authority must wait or reject the withdrawal if the invariant cannot tolerate conflicting approvals.

_The invariant concerns approved value, not only the final number stored in one row._

```text
initial balance = 100
A: read 100, request -80
B: read 100, request -50
unsafe outcome: both approvals leave the system
serial outcome: first commits, second rejects
```

## Choose the commit boundary before naming 2PC, a saga, or an outbox

A local database transaction is the simplest boundary: one transactional authority either commits all included row changes or exposes none of them. Keep an invariant there when the participating records can live under one database transaction. Splitting those records across services and then asking for atomic commit adds a protocol and a new failure state.

**Two-phase commit (2PC)** coordinates transactional resource managers. In the prepare phase, each participant promises it can commit and retains the locks or durable state needed to honor that promise. If all vote yes, the coordinator records and announces commit; otherwise it announces abort. Once prepared, a participant cannot independently guess the outcome. If the decision is unavailable after a coordinator failure, work can remain blocked while recovery finds the authoritative decision. 2PC can provide atomic commit across cooperating transactional systems, but it does not turn an arbitrary email API or payment provider into a transactional participant.

A **saga** accepts a different contract: each service commits an independent local transaction, and later failure triggers explicit compensating actions where the business permits them. Other clients may observe intermediate states. Compensation can fail, can need approval, and cannot erase every side effect. Use a saga when the business can name those intermediate states and repairs rather than pretending the whole sequence is one isolated transaction.

A **transactional outbox** closes one particular dual write. The application stores its business mutation and an event intent in the same local transaction; a relay publishes the outbox row later. It does not make the broker and database one distributed transaction. Publication may repeat, so the event needs a stable identity and consumers need deduplication or idempotent effects.

| Need                                                                          | Smallest usual mechanism                                      | Failure to design explicitly                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Several rows under one database authority change together                     | Local transaction with the required isolation and constraints | Serialization aborts, deadlocks, retries, and transaction duration                             |
| Cooperating transactional stores must expose one atomic decision              | 2PC                                                           | Prepared participants blocked on an unavailable decision; recovery and heuristic-action policy |
| Services can expose intermediate commits and reverse them with domain actions | Saga                                                          | Compensation failure, irreversible effects, timeouts, and operator ownership                   |
| One local commit must reliably create intent to publish                       | Transactional outbox                                          | Relay duplicates, poison rows, ordering scope, and consumer idempotency                        |

The [distributed transactions note](../06-distributed-systems/07-replication-consistency-and-transactions.md) follows the prepare/decision records and a transfer failure in more detail. In an interview, first state the invariant and authority boundary; then explain why the chosen mechanism pays less coordination cost than the alternatives while still covering the named failure.

## Publish facts after the transaction commits

A transactional outbox stores the business change and an event record in one local transaction; a relay later publishes the event, and consumers deduplicate repeats. A saga sequences local transactions with compensating actions, but compensation is business logic, not a magical rollback of time or external side effects.

Suppose checkout first reserves inventory and then asks a payment service to charge. A saga can record `inventory_reserved`, call payment with a stable operation ID, and either continue to fulfillment or issue a compensating inventory release after a terminal payment failure. Releasing stock does not erase an email already sent or make a payment-provider call unobservable. Store the saga step, retry identity, deadline, and compensation result so recovery can decide what remains safe to run.

An outbox and a saga solve different gaps. The outbox makes one local state change agree with the intent to publish an event. The saga records progress across several local commits. A design may use an outbox at each saga step, but it still needs idempotent consumers and reconciliation for an external side effect whose result remains ambiguous.

## Inspect authority and progress separately

During a suspected split brain, collect the leader term or epoch, membership view, commit position, applied position, and lease or fencing token from every participant. Two processes claiming leadership is not enough to prove two committed histories; compare what each could commit and what the protected resource accepted. Repeated leader changes with no commit progress often point to packet loss, overloaded peers, or pauses that exceed election timing rather than an application-level conflict.

For cross-service state, follow one business operation by its stable ID. Confirm the local transaction, outbox row, relay attempt, broker position, consumer receipt, and final side effect. Outbox age shows publication debt; duplicate-consumption counts test idempotency; compensation failures need their own queue and owner. Do not delete a stuck record merely to make lag fall. First determine whether the authoritative transaction committed and which later actions remain safe to repeat.

> **Clock boundary.** Wall-clock timestamps help explain events, but authority should come from a term, epoch, version, or token whose ordering the system enforces.

## Continuing worked case: invariants and event publication

Two invariants drive coordination. First, one tenant-scoped idempotency key produces one order result. Second, an accepted order or status transition and its notification intent either both commit or neither commits. The shard primary enforces both inside one PostgreSQL transaction: write the order and line items, record the operation result, increment the order version when needed, and insert an outbox row with a stable `event_id`. Because all four records share the shard and virtual bucket, this path does not need a distributed transaction.

Status updates compare the caller's expected version with the current row. A stale writer receives a conflict and must reread; wall-clock timestamps do not decide which transition wins. The create response comes from the primary transaction, and an immediate follow-up read stays on the primary or carries a commit position that a replica must reach before answering. Other list reads may accept the documented replica lag.

The outbox relay publishes at least once. It records the broker position but may crash after publication and before marking the row complete, so every consumer stores a receipt keyed by `event_id`. The email or push provider remains outside the database transaction. A stable provider operation ID and later reconciliation handle an ambiguous provider response; the design does not claim that two-phase commit makes the external side effect exactly once.

## Summary

Consistency design begins with the history the business must forbid. Name that invariant first, then choose isolation, consensus, leases, fencing, or compensation based on where concurrent actors and network partitions can violate it.

- **Use precise guarantees.** Linearizability orders individual operations consistently with real time; serializability makes transaction outcomes equivalent to some serial order. Neither term substitutes for durability, read-your-writes, or bounded staleness.
- **Model the forbidden race, then choose the narrowest guard.** Two withdrawals can each read a $100 balance and approve $80 and $50 unless the transaction mechanism detects or serializes the conflict. A conditional write, unique constraint, row transaction, serializable transaction, or consensus authority should protect only the records that participate in the rule.
- **Interpret CAP only during lost communication.** A linearizable service may reject or delay an operation that cannot reach authority; a service that answers on both sides of a partition must allow histories that a single current copy would reject.
- **Separate leader election from stale-actor protection.** Consensus establishes an authoritative term and committed log. A lease can expire while a paused holder still runs, so the protected resource should reject operations carrying an older monotonic fencing token.
- **Publish after commit without a dual write.** A transactional outbox records state and an event in one local transaction, then a relay publishes with deduplication. Sagas coordinate local commits and compensations, but compensation is domain logic and cannot erase every external side effect.
- **Do not merge atomic-commit patterns.** A local transaction has one authority, 2PC coordinates prepared transactional participants and can block on its decision, a saga exposes local commits plus compensations, and an outbox atomically records only local state plus publication intent.
- **Diagnose authority and progress independently.** Compare terms or epochs, membership, commit and applied positions, fencing tokens, and what the protected resource accepted. Repeated elections without commit progress often indicate packet loss, pauses, or overloaded peers rather than two durable histories.

## References

- [Herlihy and Wing: Linearizability: A Correctness Condition for Concurrent Objects](https://cs.brown.edu/people/mph/HerlihyW90/p463-herlihy.pdf)
- [PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [Perspectives on the CAP Theorem](https://groups.csail.mit.edu/tds/papers/Gilbert/Brewer2.pdf)
- [In Search of an Understandable Consensus Algorithm](https://raft.github.io/raft.pdf)
- [The Chubby Lock Service](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/)
- [Garcia-Molina and Salem: Sagas](https://www.cs.princeton.edu/research/techreps/598)
- [AWS Prescriptive Guidance: Transactional Outbox Pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html): Covers atomic business and outbox writes, duplicate publication, and idempotent consumers.
- [PostgreSQL: Two-Phase Commit](https://www.postgresql.org/docs/current/two-phase.html): Describes prepare, later commit or rollback, and the external transaction-manager boundary.

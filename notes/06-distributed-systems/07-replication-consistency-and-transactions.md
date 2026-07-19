---
title: Replicate State, Define What Clients See, and Commit Across Shards
shortTitle: Replication, consistency, and transactions
description: Connect replica mechanics to client-visible histories, convergent data types, concurrency control, and the durable prepare and decision records behind distributed commit.
collection: distributed-systems
slug: replication-consistency-and-transactions
order: 7
number: DS7
duration: 3.5 hours
difficulty: Advanced
tags:
  - replication
  - consistency-models
  - linearizability
  - serializability
  - CRDT
  - MVCC
  - two-phase-commit
  - distributed-transactions
---

## Working model

Replication decides where copies and authority live; a consistency model limits the histories clients may observe; transaction isolation limits how concurrent operations interleave; and atomic commit decides whether every participant makes one distributed transaction durable or none does. These are related layers, not synonyms.

## Questions this note answers

- Explain why systems replicate data and why correlated failures defeat simple availability arithmetic
- Trace passive primary-backup and active state-machine replication
- Distinguish linearizable, sequential, causal, session, and eventual consistency
- Explain why intersecting read and write quorums do not alone prove linearizability
- Use a CRDT only when its merge rule matches the application's meaning
- Separate ACID properties, serializability, and real-time operation order
- Compare strict two-phase locking, optimistic concurrency control, and MVCC
- Follow a transaction through prepare, durable votes, a commit decision, coordinator failure, and recovery
- Explain why two-phase commit can block and why consensus is related but not identical

## Replicas are copies with a protocol, not a guarantee

A **replica** is one maintained copy of logical state. A **replica set** is the processes responsible for those copies, and a **replication factor** is their intended count. Replication can improve durability, read locality, failover, and sometimes read capacity. It also creates new work: choosing authority, ordering concurrent updates, catching up a failed copy, removing obsolete copies, and telling clients which state they may observe.

If each of three replicas independently fails with probability `f`, the probability that all three fail is `f^3`, so at least one is available with probability `1-f^3`. Independence is the important word. Three virtual machines in one zone, on one storage control plane, or behind one broken credential may fail together. A write that requires two acknowledgements also cannot remain available with only one survivor, even though a readable copy exists. State availability per operation, not merely replica count.

Copies need not be byte-for-byte identical at every instant. One may have received log position 105 while another has applied only through 103. The protocol defines which positions are durable, committed, visible, and safe to serve. Operators therefore need commit position, applied position, replica lag, repair age, and current membership rather than a dashboard that says only `replicas = 3`.

## Compare passive and active replication by following a command

In **passive replication**, also called primary-backup, a leader receives a command, decides its order, executes it or appends it to an ordered log, and propagates the resulting update to followers. The response point matters. If the leader replies before enough durable copies hold the update, its crash can lose an acknowledged result. If a client retries after an ambiguous response, the new leader needs the operation ID and stored result to avoid applying the command twice.

Suppose command `op-88: increment quota_used by 5` reaches leader A. A appends it at log position 106, replicates it under the consensus protocol, marks it committed, applies it, and stores `op-88 -> success`. A response disappears. After failover, the client retries `op-88`; leader B returns the recorded result instead of incrementing again. Replication preserved the command, while operation identity preserved the application effect.

In **active replication**, every replica executes the same deterministic command sequence from the same initial state. If all replicas apply `set owner = Raj` and then `close account`, they reach the same state. A command such as `set expires_at = local_clock_now()` can diverge because clocks differ; choose the value once and include it in the ordered command. Random numbers, thread races, environment reads, and external side effects require the same treatment or must occur outside deterministic application.

Active replication needs a total command order, commonly a consensus-backed replicated log. Passive replication also needs a safe leader and failover history. The labels do not remove consensus, deduplication, state transfer, snapshot, or membership-change requirements.

## Define consistency from histories clients can observe

A **history** records operation invocations, responses, and returned values. A consistency model says which histories are allowed. Replace “strong consistency” with a named rule and an example read that the rule permits or forbids.

| Model                  | Client-visible rule                                                                                                                 | What it does not promise by itself                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Linearizability        | Every operation appears to take effect once between invocation and response, and later non-overlapping operations respect real time | Multi-record transaction serializability or durability                                   |
| Sequential consistency | There is one total order preserving each client's program order                                                                     | That the order respects real-time order between different clients                        |
| Causal consistency     | Every observer sees causally related operations in cause-before-effect order                                                        | One common order for concurrent operations                                               |
| Session guarantees     | One client's sequence avoids selected regressions while it may move among replicas                                                  | A global order for all clients                                                           |
| Eventual consistency   | If updates stop and communication continues, replicas eventually converge                                                           | A staleness bound, conflict-free application meaning, or useful reads before convergence |

Consider two replicas A and B. Client C1 writes `status=paid` to A and receives success at 10:00:01. Client C2 starts a read at 10:00:02. A linearizable service cannot return the older `pending` value because the operations do not overlap and real time places the completed write first. Sequential consistency could place C2's read before C1's write in the one global sequence because it need not respect cross-client wall-clock order. Causal consistency would require a later action explicitly depending on `paid` to appear after it, but an unrelated reader may still see older state.

This distinction matters operationally. Sending a receipt after payment is causally dependent on the payment fact. Showing a newly changed avatar may need only read-your-writes for the editing user. Assigning the last unit of inventory needs one authority that rejects a conflicting success, not eventual convergence after two customers have both been told they own it.

## Give a roaming client explicit session guarantees

Weakly consistent replication can still preserve one user's coherent experience. Four classic session guarantees are independent promises:

- **Read-your-writes:** a session's later reads include its earlier completed writes.
- **Monotonic reads:** once a session has observed a version, later reads do not move behind it.
- **Monotonic writes:** one session's writes are installed in that session's issue order.
- **Writes-follow-reads:** a write is ordered after the versions on which its preceding reads depended.

Suppose a phone edits a note through replica A, then its next request is routed to lagging replica B. Read-your-writes can route the request back to A, wait until B reaches the required version, or carry a version token and reject the read if B cannot satisfy it. Sticky routing is one implementation technique, not the guarantee itself. It fails over poorly unless the required version is portable.

Session guarantees are not transactions. They constrain operations associated with a client context but do not atomically commit several records or serialize all users. Also define when a session begins, how its version context is stored, how long it survives, and what the API returns when no reachable replica can satisfy it.

## Do not derive linearizability from quorum arithmetic alone

For `N` replicas, rules such as `R + W > N` create overlap between a read set of size `R` and a write set of size `W`. Overlap is useful: a read quorum intersects a previous write quorum. It is not a complete linearizability proof.

The protocol must still identify the newest authoritative value, order concurrent writes, repair stale members, handle membership changes, and prevent a superseded leader from serving or writing as current. Sloppy quorums may acknowledge temporary replicas outside the intended set. Clock-based last-writer-wins can choose a value with the greatest timestamp rather than the business-latest operation. A read that contacts an overlapping replica but accepts the first response may ignore the newer copy. A network partition can create two candidate memberships if epochs are not enforced.

Consensus protocols use intersecting quorums together with terms or ballots, durable voting rules, log-prefix constraints, and a commit rule. Leader-based linearizable reads add another proof that the leader is still authoritative, such as a quorum round or valid lease under explicit timing assumptions. “We use a majority” is therefore the start of the explanation, not the conclusion.

## Treat eventual convergence and conflict meaning separately

Eventual consistency says replicas converge after updates stop and messages are delivered. The merge may still destroy user intent. Last-writer-wins chooses one value by an ordering signal; two users concurrently edit different fields of a profile, and one whole-object write may erase the other. Convergence succeeded, but the product result is wrong.

A **conflict-free replicated data type**, or CRDT, encodes a merge with mathematical convergence properties. A state-based CRDT sends states whose merge is associative, commutative, and idempotent; replicas that receive the same information converge regardless of delivery order or duplication. An operation-based CRDT sends operations designed to commute under its delivery assumptions, which may include causal delivery and exactly-once effect at the CRDT layer.

A grow-only counter can keep one non-decreasing component per replica and merge by taking the component-wise maximum. Its value is the sum. Replica A can record three increments while disconnected, B can record two, and merging yields five without selecting a winner. This works for page-view counts under the stated identity and reset rules. It does not enforce a bank balance that must never go below zero, because concurrent withdrawals require an invariant across replicas. Escrow or bounded-counter designs allocate rights before disconnected updates; the data type must encode the invariant rather than merely converge.

CRDT choices include add-wins versus remove-wins sets, observed-remove sets, registers, maps, counters, and sequences. Each resolves concurrency differently and carries metadata, garbage-collection, identity, and deletion costs. Document the user-visible outcome of concurrent add/remove or edit/edit operations before choosing the type.

## Separate ACID from replication consistency

A **transaction** groups operations into one unit. Its ACID properties answer different questions:

- **Atomicity:** all transaction effects commit, or none do.
- **Consistency:** a transaction that starts from valid state preserves the application's declared invariants when its code and constraints are correct.
- **Isolation:** concurrent transactions are prevented from observing or producing disallowed interleavings.
- **Durability:** acknowledged committed effects survive the failures covered by the storage contract.

Database consistency in ACID is not the same term as replica consistency. A database does not infer that inventory must remain non-negative; the schema, transaction, constraint, or application must express that rule.

**Serializability** means committed transactions have an outcome equivalent to some serial, one-at-a-time order. **Strict serializability** also respects real-time order for non-overlapping transactions. Linearizability usually describes operations on an object; serializability describes transactions that may touch many objects. A system can provide serializable transactions in an order that does not respect wall time, or linearizable single-record operations without making a read-check-write sequence atomic.

## See the anomalies before choosing control

Start with two seats. T1 and T2 both read `available=1`, both decide a seat exists, and both write `available=0`. The final number looks plausible, but two reservations escaped. This is a lost update plus a violated uniqueness or inventory invariant. An atomic conditional update such as “decrement only if positive” may protect one row; a wider rule needs a transaction.

For a precedence graph, create one node per transaction. Add an edge T1 to T2 when a conflicting operation from T1 occurs before the conflicting T2 operation. A cycle means the history is not conflict-serializable. Checking only pairs of two transactions is not enough for a general workload.

Snapshot isolation can prevent many dirty or inconsistent reads yet permit **write skew**. Two doctors are both on call. T1 reads both rows and turns doctor A off; T2 reads the same snapshot and turns doctor B off. They update different rows, so both writes can commit under snapshot isolation, leaving nobody on call. Serializable isolation must reject or order one transaction, or the invariant must be represented by a row or constraint that both updates conflict on.

## Compare locking, optimism, and versions

**Two-phase locking** has a growing phase that acquires locks and a shrinking phase that releases them; after releasing one, the transaction acquires no new lock. Shared locks allow compatible readers, while exclusive locks exclude conflicting access. **Strict two-phase locking** holds write locks until commit or abort, preventing other transactions from reading uncommitted writes and making recovery safer. It provides conflict serializability under its rules but can deadlock.

The classic necessary conditions are mutual exclusion, hold-and-wait, no forced preemption, and circular wait. Omitting hold-and-wait leaves the usual explanation incomplete. With one instance of each resource, a cycle in the wait-for graph establishes a deadlock; multiple interchangeable instances require more analysis. Detect a deadlock, choose a victim, abort it, and retry with bounded backoff. Consistent lock ordering can prevent many cycles.

**Optimistic concurrency control** usually has read, validation, and write phases. Transactions compute without holding all conflicting locks, then validate that their read and write assumptions still hold. It works well when conflicts are rare and validation is cheaper than waiting. Under hot contention, repeated aborts waste work and increase tail latency. A version-checked compare-and-set is a small form of optimistic control; full OCC validates sets or predicates, not only one row.

**Multi-version concurrency control** stores several logical versions and lets readers use a snapshot while writers create newer versions. MVCC is a storage and visibility mechanism, not one isolation level and not simply another word for optimism. A database can combine versions with locks, validation, or serializable snapshot isolation. Old snapshots also delay version reclamation, so long transactions can create storage growth and vacuum or garbage-collection pressure.

When selecting an isolation level, state the forbidden anomaly and test it. Product names such as `READ COMMITTED`, `REPEATABLE READ`, and `SERIALIZABLE` can differ in exact behavior across engines. Handle serialization failures and deadlock-victim errors as expected retryable outcomes with a stable business-operation identity.

## Follow one transfer through two-phase commit

Move $30 from account A on shard East to account B on shard West. The initial balances are A=$100 and B=$50. Transaction coordinator C assigns stable ID `tx-884` and calculates tentative values A=$70 and B=$80. Each shard is itself replicated by its own consensus group; that keeps each participant available through some replica failures, while two-phase commit coordinates the all-or-nothing decision across the two shard groups.

The protocol is:

1. C sends `PREPARE tx-884` with the participant's intended writes.
2. East checks constraints, acquires or validates the required concurrency-control state, force-records `prepared tx-884: A=70` in durable replicated storage, and votes yes.
3. West similarly force-records `prepared tx-884: B=80` and votes yes.
4. After every required participant votes yes, C force-records `commit tx-884` before sending the decision. If any participant votes no, or fails before preparing and the protocol chooses abort, C durably records abort.
5. Participants receiving commit make the tentative writes visible, durably record the decision as required by their recovery design, release locks or intents, and acknowledge. C may forget completed state only after the protocol's cleanup condition is satisfied.

Now fail C after East receives commit but before West does:

```text
East: prepared -> commit received -> A=70 visible
West: prepared -> decision missing -> B=50 still visible, intent retained
C: durable decision = commit, process crashed
```

West cannot safely abort because East may already have committed. It cannot safely commit merely because it voted yes, because another participant might have voted no before C made a decision. West is in the **uncertain** or prepared state and may block while the decision is recovered. A restarted or newly elected coordinator reads the durable commit record and retransmits commit; West then exposes B=$80.

The commit decision is atomic, but physical application is not simultaneous at every machine. The concurrency-control and read protocol must stop another transaction from observing a non-serializable half-transfer: for example, West retains its prepared lock or intent while a cross-shard reader uses the transaction protocol or an appropriate snapshot. Two unrelated non-transactional reads issued to different shards can still observe different logical times. Two-phase commit does not create a globally synchronized read snapshot by itself.

If West votes no before entering prepared state, it may abort its local attempt; C must choose global abort. A participant that has durably voted yes has promised to retain the resources and information needed to obey the later decision. A timeout before that promise and a timeout after it therefore have different safe actions.

The client may also time out after submitting `tx-884`. It cannot infer abort. It queries or retries using the same transaction or business-operation ID and receives the stored terminal result. Creating a new transfer ID could debit twice.

## Separate atomic commit from consensus

Two-phase commit and consensus both involve agreement, but their validity conditions differ. Atomic commit may commit only when every required participant is prepared to commit; one no vote forces abort. Consensus chooses one proposed value under its own validity rule and can continue with a majority under the protocol's assumptions. Classic two-phase commit has one coordinator decision record and can block when that record is unavailable.

Replicating the coordinator with consensus removes a single machine as the only holder of the decision. Replicating every shard also lets a participant survive minority failures. These changes improve availability but do not turn quorum arithmetic into a distributed transaction proof. The design must specify how prepare and decision records enter each replicated log, how leadership changes preserve intents, how membership changes work, and when locks or provisional versions are released.

Paxos Commit applies consensus to participant commit records and generalizes classic two-phase commit. Modern databases use several related designs, but the beginner's durable-state questions remain useful: Who can vote? What was force-recorded before yes? Where is the one terminal decision? Which processes can reconstruct it? Which participant is allowed to forget first?

Do not place an external email, webhook, or ordinary payment API inside a database transaction unless that system is a real protocol participant. Use an outbox to couple a local state change with an event-publication intent, and use stable idempotency keys, workflows, or sagas for external effects. Compensation is a new business action, not an erasure of history.

## Diagnose replicas, transactions, and recovery as separate paths

For a stale read, record the requested consistency or session rule, client version token, selected replica, replica commit and applied positions, leader term, and response version. For divergence, record concurrent operation identities, causal metadata or timestamps, merge rule, repair age, and per-replica state. “Replica lag” is not a cause until the missing position and why it cannot apply are known.

For a transaction stall, search by one stable transaction ID. At every participant collect coordinator identity and epoch, local state (`active`, `prepared`, `committed`, or `aborted`), durable log position, held locks or intents, last message, and recovery source. A large prepared count after coordinator failover indicates blocked decision recovery; a high serialization-abort rate indicates contention or an invariant touching a wider read set than expected. Do not delete an intent to clear a dashboard until the terminal decision is proven.

## Summary

Replication creates copies and a protocol for ordering, authority, catch-up, and repair. Consistency models describe the histories clients may observe. Concurrency control rules out unsafe transaction interleavings. Two-phase commit carries one atomic decision across several participants. A design must name each layer because no one quorum, lock, or product label supplies all of them.

- **Replicate under an explicit failure model.** Independent-copy availability arithmetic fails under shared zones, control planes, credentials, or quorum requirements. Track committed and applied positions, membership, repair, and operation-specific availability.
- **Define the observed history.** Linearizability respects real time, sequential consistency preserves each client's order in one global sequence, causal consistency preserves dependencies, session guarantees protect one client's progression, and eventual consistency promises convergence only after communication resumes and updates stop.
- **Do not infer linearizability from `R + W > N`.** Intersection helps, but authority, version order, concurrent writes, membership epochs, read selection, and repair still determine the result.
- **Use CRDTs for matching merge semantics.** A convergent counter or set can accept disconnected updates, but convergence does not preserve arbitrary invariants such as non-negative balances or exclusive ownership.
- **Separate serializability from versions and locks.** Strict 2PL, OCC, and MVCC are mechanisms with different wait, abort, storage, and recovery costs. MVCC alone does not name the isolation level, and snapshot isolation can permit write skew.
- **Make prepared state and the decision durable.** In 2PC, a yes-voting participant cannot guess after losing the coordinator. It may block until the durable commit or abort decision is recovered. Consensus-replicated participants and coordinators improve availability but do not make atomic commit identical to consensus.

## References

- [CS 425 Fall 2025 Lecture 19-20: RPCs and Concurrency Control](https://courses.grainger.illinois.edu/cs425/fa2025/L19-20.FA25.pdf)
- [CS 425 Fall 2025 Lecture 21: Replication Control](https://courses.grainger.illinois.edu/cs425/fa2025/L21.FA25.pdf)
- [CS 425 Fall 2025 Lecture 24B: Consistency Models](https://courses.grainger.illinois.edu/cs425/fa2025/L24.B.FA25.pdf)
- [Herlihy and Wing: Linearizability - A Correctness Condition for Concurrent Objects](https://cs.brown.edu/people/mph/HerlihyW90/p463-herlihy.pdf)
- [Lamport: How to Make a Multiprocessor Computer That Correctly Executes Multiprocess Programs](https://lamport.azurewebsites.net/pubs/multi.pdf)
- [Terry et al.: Session Guarantees for Weakly Consistent Replicated Data](https://pages.cs.wisc.edu/~remzi/Classes/739/Papers/bayou-sessions94.pdf)
- [Shapiro et al.: Conflict-Free Replicated Data Types](https://people.eecs.berkeley.edu/~kubitron/courses/cs262a-F18/handouts/papers/Shapiro-CRDT.pdf)
- [PostgreSQL: Transaction Isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL: Concurrency Control and MVCC](https://www.postgresql.org/docs/current/mvcc.html)
- [Gray and Lamport: Consensus on Transaction Commit](https://arxiv.org/abs/cs/0408036)
- [Spanner: Google's Globally Distributed Database](https://research.google/pubs/spanner-googles-globally-distributed-database-2/)

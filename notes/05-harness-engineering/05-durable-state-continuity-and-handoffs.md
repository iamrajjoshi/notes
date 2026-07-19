---
title: Durable state, continuity, and handoffs
shortTitle: State and handoffs
description: Preserve progress across turns, workers, crashes, and ownership changes without replaying side effects or trusting an opaque transcript.
collection: harness-engineering
slug: durable-state-continuity-and-handoffs
order: 5
number: HE5
duration: 120 min
difficulty: Advanced
tags:
  - durable execution
  - checkpoints
  - handoffs
  - replay
---

## Working model

Continuity comes from explicit state and receipts, not a long transcript. Checkpoint decisions at stable boundaries, give every external effect an identity, and hand off a compact work package that another executor can verify.

## Questions this note answers

- Separate conversation history, working state, checkpoints, artifacts, and external effects
- Design a typed handoff with ownership and evidence
- Explain replay, step boundaries, versioning, and idempotency in durable execution
- Recover an interrupted run without silently repeating completed work

## Store facts according to their lifetime and authority

Conversation history records what was said, but it is a poor database for completed effects or artifact versions. Working state holds current hypotheses and a plan. Durable checkpoints record stable progress. Artifacts live in a filesystem or object store, while the external system remains authoritative for tickets, deployments, payments, and messages.

Link these layers with stable identifiers and hashes. A checkpoint should say which artifact version it reviewed and which effect receipt it observed. On resume, reconcile those references before taking another action; a stale summary must not overrule current repository or service state.

> **Toy storage split.** Keep model messages in the run record, resumable phase data in a checkpoint, and file bytes in an artifact store. A checkpoint points to an artifact digest; it doesn't copy the whole file or pretend that conversation history owns it.

## Persist a boundary another process can verify

A checkpoint needs a workflow and task identity, schema version, owner or lease epoch, current phase, input references, completed step records, artifact digests, external-effect receipts, pending approvals, remaining budgets, and an explicit next safe action. Store it atomically or use a versioned compare-and-set so two executors cannot both advance the same state without detection.

The checkpoint store owns resume metadata, while artifact storage owns file bytes and external services own their effects. Do not copy an external resource's entire state into the checkpoint and later treat that snapshot as current. Save its identifier, observed version, and receipt, then reconcile on resume. Encrypt and control access according to the included data because checkpoints can expose arguments, file names, customer identifiers, or approval decisions even when model transcripts are excluded.

- Completed step: recorded input, output, code version, and terminal class
- Pending step: no claim that an uncertain effect did or did not commit
- Ownership: executor identity plus epoch or compare-and-set version
- Resume rule: first reconciliation and the condition that permits progress

## A handoff is a typed change of ownership

A useful handoff names the task contract, completed work, artifacts, evidence, unresolved questions, remaining budget, blocked permissions, and next safe action. It also identifies the new owner and whether the previous owner may continue. Without that ownership edge, two workers can make conflicting changes after a seemingly harmless transfer.

Filter history before transfer. The receiver needs decisions and evidence, not every abandoned line of thought. Preserve links to the full trace for audit, label claims that have not been verified, and require the receiver to acknowledge the handoff version before acting on it.

_A receiver can check identifiers and evidence without replaying the whole conversation._

```yaml
handoff_version: 3
owner: evaluator
contract: task-42
artifacts:
  - id: patch-7
    digest: sha256:...
evidence:
  - focused-tests: passed
unresolved:
  - integration environment unavailable
next_action: inspect the stored diff
```

## Resume after a crash between an effect and its checkpoint

A worker applies patch operation edit-17 and receives artifact digest r2. It then creates an external draft using operation task-42:draft-pr. The forge commits the draft, but the worker crashes before saving the step result. The durable checkpoint still shows the draft step as started with an operation ID but no receipt. A replacement worker acquires a newer ownership epoch and must not call create immediately.

The replacement reads the current artifact digest, queries the forge for the prior operation or matching draft, and finds draft 913. It stores a reconciled receipt, marks the step complete through a version-checked checkpoint update, and continues to verification. If the draft cannot be located and the forge offers no idempotent create contract, the worker pauses for operator review. Guessing either success or failure would risk skipping required work or creating a duplicate.

_Recovery joins durable intent with current external state; it does not replay blindly._

```text
checkpoint v8: draft step started, operation ID stored
external system: draft 913 committed
worker crashes before checkpoint v9
new owner epoch: reconcile before create
receipt found -> checkpoint v9 -> resume verification
```

### Run the crash boundary in two processes

The public [durable harness](./examples/durable-harness.mjs) turns that sequence into a dependency-free Node 26 program. The caller supplies a file-backed SQLite path. Five tables keep the boundaries visible:

- `services` contains the business state and an effect counter.
- `operations` makes the stable operation ID unique and records its input digest and result.
- `run_checkpoints` stores the phase, JSON checkpoint, and compare-and-set version.
- `receipts` records effect, reconciliation, lease, and conflict outcomes.
- `leases` stores the current worker, expiry, and monotonically increasing fencing epoch.

Run the executable cases from the notes repository:

```bash
node --test tests/durable-harness.test.mjs
```

The crash case starts a child process, commits the maintenance change and operation record in one SQLite transaction, and deliberately exits with code 86 before updating checkpoint version 0. A fresh child process waits until the old lease is expired, acquires a newer epoch, queries `operations` by the original operation ID, writes a reconciled receipt, and advances the checkpoint to version 1. It never calls the business mutation during recovery, so the service's effect counter remains 1.

The ownership case leaves one resume process paused after it acquires a lease. A second process takes over after that lease expires and receives the next epoch. Its checkpoint update requires both the expected version and its current lease epoch. When the old process wakes, the transition rejects its stale epoch before changing the checkpoint; it returns `conflict` and stores a conflict receipt. A worker name is only a label: presenting the same name while its lease is active conflicts, and reusing it after expiry creates a new epoch. A restarted process therefore cannot inherit its predecessor's fencing token.

SQLite is a local teaching store here, not a multi-host workflow service. The example can transact the business row and operation record because both live in one database. If the effect belongs to a forge, cloud API, or payment service, send a stable idempotency key to that system and reconcile against its authoritative record instead of pretending a local transaction covers both systems. A production PostgreSQL implementation also needs an explicit isolation and locking design, bounded retries for serialization failures or deadlocks, database-derived lease time, and operational monitoring.

## Durable execution replays code, so effects need stable boundaries

Durable workflow systems checkpoint step inputs and outputs, then re-enter workflow code after interruption. Code outside a durable step may run again during replay. Keep nondeterministic reads and side effects inside recorded steps, and give the workflow and each external operation stable identifiers.

Recovery semantics have limits. A completed step can be reused, but a step interrupted mid-call may need retry or reconciliation according to the external system's contract. Version long-lived workflows when control flow changes, bound recovery attempts, and expose a cancel or pause path for operators.

> **Toy durable runner.** A database stores checkpoints and operation receipts, a lease assigns temporary ownership, and a queue may wake a worker. Checkpoints, delivery, leases, and effect records answer different recovery questions; none makes an external write safe to repeat by itself.

### Code walk: treat workflow code as persisted state

Open [durable-harness.mjs](examples/durable-harness.mjs) and inspect the five table definitions before reading the worker path. `run_checkpoints` stores phase and version, `leases` stores the current fencing epoch, and `operations` stores the stable effect identity beside its input digest and result.

Trace `applyBusinessEffect` next. It commits the business change and operation record in one SQLite transaction, then the demo can exit before the checkpoint advances. `reconcileAndAdvance` reads the operation, checks its digest, and advances only when both the checkpoint version and lease epoch still match. Mark which facts survive a process crash and which exist only in local variables.

Now imagine changing a saved phase name, removing a checkpoint field, or reordering two externally visible steps while old runs remain active. For each edit, decide whether old state still has one unambiguous next action. If not, keep the old worker code available or write a tested state migration; deploying new code doesn't rewrite saved history.

### Code walk: follow recovery through the worker

Run `node --test tests/durable-harness.test.mjs` and classify its four cases. One deduplicates a repeated effect, one rejects an expired lease, one reconciles after a process dies before checkpoint, and one rejects a stale worker after a lease race. For every case, record the durable fact that permits progress or forces a stop.

Add a fifth case on paper: the effect belongs to an external API that offers neither an idempotency key nor a lookup by operation ID. The replacement worker can't prove committed or absent, so the correct result is `needs_operator`, not another write.

## Watch ownership, replay, and stuck progress as different signals

Track checkpoint age, time since last successful transition, active owner epoch, compare-and-set conflicts, replayed-step count, uncertain effects, reconciliation outcomes, handoff acknowledgements, recovery attempts, and cancellation latency. A busy worker with an old checkpoint may be stuck before persistence; repeated version conflicts suggest overlapping ownership; repeated reuse of completed steps may be normal replay after process churn.

Keep a runbook for orphan detection and recovery. It should state how long ownership may remain silent, how a new owner is elected, which effects require reconciliation, when recovery stops, and who can cancel or repair a long-lived workflow version. Test recovery with controlled crashes before and after the effect boundary. The test must confirm both progress and absence of duplicate external state.

> **Takeaway.** Checkpoint stable decisions and effect identities, transfer ownership explicitly, and reconcile every step whose result is uncertain before resuming.

## Summary

Durable state must let a different process determine what happened and what remains safe to do. Save stable progress, artifact identities, ownership, and external receipts outside the conversation so recovery does not guess from prose.

- Keep conversation history, working notes, checkpoints, artifacts, and external systems as distinct stores with different authority.
- Include task identity, schema version, phase, owner epoch, artifact digests, completed steps, pending approvals, budgets, and next safe action in a checkpoint.
- Use atomic writes or compare-and-set updates so two workers cannot advance the same checkpoint silently.
- After a crash around an external effect, reconcile its operation ID with authoritative state before issuing another write.
- In the public SQLite case, only the current lease epoch and expected checkpoint version may advance a run; stale workers return a recorded conflict.
- Make a handoff name the new owner, whether the old owner must stop, the accepted evidence, unresolved risks, and the bounded next action.
- Put nondeterministic reads and effects inside recorded steps because workflow code outside them may run again during replay.
- Monitor checkpoint age, ownership conflicts, uncertain effects, replay counts, recovery attempts, and cancellation latency separately.

## References

- [DBOS: Workflows](https://docs.dbos.dev/python/tutorials/workflow-tutorial)
- [DBOS Python programming guide](https://docs.dbos.dev/python/programming-guide): Defines database-backed workflow and step state, including the local SQLite default and production PostgreSQL recommendation.
- [DBOS: Queues](https://docs.dbos.dev/python/reference/queues)
- [SQLite: Transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite: Atomic commit](https://www.sqlite.org/atomiccommit.html)
- [SQLite: Write-ahead logging](https://www.sqlite.org/wal.html)
- [PostgreSQL: Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL: Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [Durable harness](examples/durable-harness.mjs): Local SQLite example covering operation identity, leases, fencing, reconciliation, and checkpoint advancement.

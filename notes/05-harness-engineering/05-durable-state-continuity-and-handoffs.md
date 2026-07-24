---
title: Durable state, continuity, and handoffs
description: Preserve progress across turns, workers, crashes, and ownership changes without replaying side effects or trusting an opaque transcript.
slug: durable-state-continuity-and-handoffs
order: 5
identifier: HE5
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

## Learn the ownership vocabulary before recovering a run

| Term                       | Meaning in this note                                                                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkpoint                 | A durable, versioned record of stable workflow progress and the next safe action. It is not the worker's live memory or a copy of every artifact.                |
| Lease                      | Time-bounded permission for one worker to act as the current owner. Expiry allows takeover but does not prove the old worker stopped.                            |
| Ownership or fencing epoch | A monotonically increasing token issued with ownership. Durable writes reject an older epoch so a paused former owner cannot resume successfully after takeover. |
| Compare-and-set            | An update that succeeds only if the stored version still equals the version the caller observed; otherwise it reports a conflict.                                |
| Reconciliation             | A read from the authoritative system that determines whether an uncertain external effect committed before any retry.                                            |

For the general distributed-systems mechanics, see [leases and fencing tokens](../06-distributed-systems/04-multicast-election-and-distributed-locks.md#finish-authority-with-a-lease-and-fencing-token) and [version-checked optimistic control](../06-distributed-systems/07-replication-consistency-and-transactions.md#compare-locking-optimism-and-versions). This note applies them to agent-run continuity.

## Store facts according to their lifetime and authority

Conversation history records what was said, but it is a poor database for completed effects or artifact versions. Working state holds current hypotheses and a plan. Durable checkpoints record stable progress. Artifacts live in a filesystem or object store, while the external system remains authoritative for tickets, deployments, payments, and messages.

Link these layers with stable identifiers and hashes. A checkpoint should say which artifact version it reviewed and which effect receipt it observed. On resume, reconcile those references before taking another action; a stale summary must not overrule current repository or service state.

> **Toy storage split.** Keep model messages in the run record, resumable phase data in a checkpoint, and file bytes in an artifact store. A checkpoint points to an artifact digest; it doesn't copy the whole file or pretend that conversation history owns it.

### Put a disposable cache in front of durable artifacts

A session filesystem can present ordinary paths while storing committed bytes in a remote artifact store. The local disk is a cache and staging area, not the authority. A replacement worker should be able to open the same artifact from its digest even when it starts on another machine with an empty cache.

One safe write path has four transitions:

1. Write a temporary local file and compute its content digest.
2. Upload the immutable object under that digest, then verify the store's receipt or returned version.
3. Publish a small manifest that maps the session path to the digest through a conditional update.
4. Save the manifest version, artifact digest, and upload receipt in the checkpoint.

If the worker dies before step 2, the local file was never durable. A death after step 2 but before step 3 may leave an unreferenced object that garbage collection can remove after a safety interval. A death after step 3 can recover from the manifest even when the checkpoint is stale; the replacement reconciles the manifest version before it writes another path mapping.

Content-addressed objects make repeated uploads harmless when the bytes match, but mutable path names still need compare-and-set or one declared writer. Cache eviction should change latency, not visible content. Track cache hit rate, downloaded bytes, upload and manifest latency, digest failures, unreferenced objects, and recovery reads separately so a warm cache cannot hide a broken remote store.

### A stored snapshot is not yet a recovery point

A snapshot object can survive node loss while the workflow still restarts from scratch. Recovery also needs a durable head that another worker can discover from a stable run or session ID, plus a bootstrap path that knows how to open the referenced format.

Suppose a sandbox mounts immutable block image `B0` and records changed blocks in a private copy-on-write file. Every five minutes it uploads packed diff `D7` and mapping header `H7`; the header says which logical ranges come from `B0` and which come from `D7`. The daemon then remembers `H7` only in process memory.

```text
object store: B0, D7, H7
workflow record: no snapshot head
node dies
replacement worker -> knows only B0 -> starts from the original image
```

The bytes survived, but no control-plane record connects them to the run. A host-local pointer or a key derived from the old worker's volume ID has the same defect because a replacement may start on another node with a new volume identity.

A usable recovery point needs an explicit publication protocol:

1. Establish the required consistency boundary. Flush or quiesce the filesystem, and use the database's own backup protocol when crash recovery alone is insufficient.
2. Upload immutable data and mapping objects with checksums. Do not overwrite a published generation in place.
3. Compare-and-set a small durable head from the prior generation to the new header ID, keyed by the stable run or session ID.
4. Record the head version, snapshot schema, compatible reader version, and publication receipt in the workflow checkpoint.
5. Before deleting older objects, prove that a replacement with an empty local cache can resolve the head, fetch every dependency, and open the filesystem.

```text
run manifest --compare-and-set--> H7
                                 ├── changed ranges -> D7
                                 └── unchanged ranges -> B0

replacement worker -> run manifest -> H7 -> D7 + B0
```

A crash before step 3 leaves uploaded but unreferenced objects. Garbage collection may remove them after a safety interval. A crash after step 3 leaves a recoverable generation even if the workflow checkpoint has not yet advanced; the replacement reconciles the manifest before publishing another head.

Retention must follow references. Expiring `B0` breaks `H7` even when both `H7` and `D7` still exist, while deleting an intermediate diff can break every later header that maps ranges to it. Start from each retained head, mark every reachable header and data object, then delete only unreferenced generations after the recovery window.

Snapshot consistency remains a separate contract. Flushing a mounted filesystem and copying changed blocks while writes continue may produce a crash-consistent image that needs journal replay. It does not create an application-consistent database checkpoint. If the resumed worker needs a stronger promise, coordinate the application before publishing the storage head.

Use one replacement test as the acceptance criterion: given only a stable run ID on another node with an empty cache, can a new worker discover the current head, validate its dependencies, open it with a compatible reader, and identify the next safe workflow action? If not, the uploaded bytes are an artifact rather than a resumable checkpoint.

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

### Queueing, waiting, and watchdogs preserve different facts

Durable systems often put several control loops around the workflow history. They should not share one vague “recovery” label:

| Mechanism                   | State it preserves or observes                                                                            | What it does not prove                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Durable queue               | Submitted work, admission order, concurrency, and rate limits                                             | That a dequeued workflow completed or its external effect committed     |
| Queue partition or claim    | Which worker may pull one slice of queued work for a bounded lease                                        | Exclusive ownership after the claim expires                             |
| Completed step record       | The saved input, output, and position of one finished workflow operation                                  | The result of a call that crashed before its completion record          |
| Durable sleep or event wait | A wake time or awaited event that survives process replacement                                            | That a live worker or dependency will be healthy at wake-up             |
| Process watchdog            | A worker or event loop stopped making local progress                                                      | Whether the workflow's last external call committed                     |
| Orphan recovery scan        | Persisted work has no current executor and may need another recovery attempt                              | That retrying an uncertain effect is safe                               |
| Graceful worker drain       | New claims stop while active work reaches a recorded boundary or loses its lease after a bounded deadline | That already orphaned work or an uncertain external effect is resolved  |
| Retention cleanup           | Completed history meets a written deletion policy                                                         | That old history is no longer needed for deduplication or investigation |

Suppose an export workflow leaves a durable queue, completes `reserve_export`, and stores a wake time for a one-hour supplier window. Its worker exits during that wait. The queue record need not be recreated, and a watchdog need not rerun the reservation. A replacement reads the workflow history, observes the completed step and pending wake time, then waits or resumes from that boundary. If the process died inside a supplier call whose result was never recorded, orphan recovery must reconcile that operation instead of treating it like the completed reservation.

During a planned shutdown, mark the worker unavailable for new claims first, then give active work a bounded interval to publish its next durable boundary. Do not acknowledge or delete an incomplete queue item merely to make the process exit cleanly. When the deadline expires, the lease and stored history—not process memory—must let another worker distinguish a completed step, a safe retry, and an uncertain effect that requires reconciliation.

### Worked storage boundary: workflow code is part of persisted state

The five table definitions in [durable-harness.mjs](examples/durable-harness.mjs) make the storage boundary visible. `run_checkpoints` stores phase and version, `leases` stores the current fencing epoch, and `operations` stores the stable effect identity beside its input digest and result.

`applyBusinessEffect` commits the business change and operation record in one SQLite transaction, then the demo can exit before the checkpoint advances. `reconcileAndAdvance` reads the operation, checks its digest, and advances only when both the checkpoint version and lease epoch still match. The database rows survive a process crash; local variables do not.

Changing a saved phase name, removing a checkpoint field, or reordering externally visible steps can leave old state without one unambiguous next action. In that case, keep the old worker code available or provide a tested state migration. Deploying new code does not rewrite saved history.

#### A recorded step sequence constrains an upgrade

DBOS documents a change in which steps run, or the order in which they run, as a breaking workflow change. Assume each called function below is registered with `@DBOS.step()`. The history may already contain `validate_export` followed by `write_object`:

```python
@DBOS.workflow()
def build_export(export_id: str) -> None:
    validate_export(export_id)
    write_object(export_id)
```

Inserting `redact_export` between them without an upgrade rule gives an old history and new code different meanings for the same position. One patch path keeps both branches explicit:

```python
@DBOS.workflow()
def build_export(export_id: str) -> None:
    validate_export(export_id)
    if DBOS.patch("add-redaction-v2"):
        redact_export(export_id)
    write_object(export_id)
```

New workflows record the patch marker and run the new step; an old workflow that already crossed that history position follows the old branch. Keep the patch until old histories have drained, deprecate it through the workflow API, and remove it only after no resumable run depends on that branch. Application versioning is the other option: send new work to the new version while workers with the old code finish old histories.

The step sequence is only part of compatibility. Serialized arguments and results are persisted data, so renaming a step, changing a parameter's meaning, removing a field, or changing an output shape can strand an old execution even when the source still type-checks. Version those schemas or provide a tested adapter. A deployment that starts successfully says nothing about whether yesterday's checkpoint can resume.

### Executable recovery cases

`node --test tests/durable-harness.test.mjs` runs four cases. One deduplicates a repeated effect, one rejects an expired lease, one reconciles after a process dies before checkpoint, and one rejects a stale worker after a lease race. Each result follows from a durable operation record, lease epoch, or checkpoint version rather than a worker's local memory.

A fifth boundary is an external API that offers neither an idempotency key nor a lookup by operation ID. A replacement worker cannot prove committed or absent, so the correct result is `needs_operator`, not another write.

## Watch ownership, replay, and stuck progress as different signals

Track checkpoint age, time since last successful transition, active owner epoch, compare-and-set conflicts, replayed-step count, uncertain effects, reconciliation outcomes, handoff acknowledgements, recovery attempts, and cancellation latency. A busy worker with an old checkpoint may be stuck before persistence; repeated version conflicts suggest overlapping ownership; repeated reuse of completed steps may be normal replay after process churn.

Keep a runbook for orphan detection and recovery. It should state how long ownership may remain silent, how a new owner is elected, which effects require reconciliation, when recovery stops, and who can cancel or repair a long-lived workflow version. Test recovery with controlled crashes before and after the effect boundary. The test must confirm both progress and absence of duplicate external state.

> **Takeaway.** Checkpoint stable decisions and effect identities, transfer ownership explicitly, and reconcile every step whose result is uncertain before resuming.

## Summary

Durable state must let a different process determine what happened and what remains safe to do. Save stable progress, artifact identities, ownership, and external receipts outside the conversation so recovery does not guess from prose.

- Keep conversation history, working notes, checkpoints, artifacts, and external systems as distinct stores with different authority.
- Keep remote artifact bytes and manifests authoritative; a local session filesystem cache may disappear without changing committed content.
- Include task identity, schema version, phase, owner epoch, artifact digests, completed steps, pending approvals, budgets, and next safe action in a checkpoint.
- Use atomic writes or compare-and-set updates so two workers cannot advance the same checkpoint silently.
- After a crash around an external effect, reconcile its operation ID with authoritative state before issuing another write.
- In the public SQLite case, only the current lease epoch and expected checkpoint version may advance a run; stale workers return a recorded conflict.
- Make a handoff name the new owner, whether the old owner must stop, the accepted evidence, unresolved risks, and the bounded next action.
- Put nondeterministic reads and effects inside recorded steps because workflow code outside them may run again during replay.
- Treat step order and persisted input or output schemas as compatibility boundaries, and separate queue delivery, durable waits, watchdogs, orphan recovery, graceful drain, and retention.
- Monitor checkpoint age, ownership conflicts, uncertain effects, replay counts, recovery attempts, and cancellation latency separately.

## References

- [DBOS: Workflows](https://docs.dbos.dev/python/tutorials/workflow-tutorial)
- [DBOS: Upgrading workflow code](https://docs.dbos.dev/python/tutorials/upgrading-workflows)
- [DBOS Python programming guide](https://docs.dbos.dev/python/programming-guide): Defines database-backed workflow and step state, including the local SQLite default and production PostgreSQL recommendation.
- [DBOS: Queues](https://docs.dbos.dev/python/reference/queues)
- [DBOS methods: durable sleep, waits, events, and patch markers](https://docs.dbos.dev/python/reference/contexts)
- [SQLite: Transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite: Atomic commit](https://www.sqlite.org/atomiccommit.html)
- [SQLite: Write-ahead logging](https://www.sqlite.org/wal.html)
- [PostgreSQL: Transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL: Explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [Durable harness](examples/durable-harness.mjs): Local SQLite example covering operation identity, leases, fencing, reconciliation, and checkpoint advancement.

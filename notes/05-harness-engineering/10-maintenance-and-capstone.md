---
title: Maintenance and measured change
description: Version the moving parts, improve one real task against a baseline, and operate the harness with before-and-after evidence and a rollback path.
slug: maintenance-and-capstone
order: 10
identifier: HE10
duration: 180 min
difficulty: Advanced
tags:
  - maintenance
  - versioning
  - rollout
  - metrics
---

## Working model

A harness is a changing service, not a finished prompt. Pin what ran, compare one controlled change with a baseline, release behind measurable gates, and keep the old path available until the new one earns trust.

## Version the effective system, not only the prompt

Behavior can change when the model snapshot, sampling settings, instruction chain, tool schema, tool implementation, context retrieval, middleware order, sandbox image, policy, or grader changes. Remote interfaces belong in that list too: an MCP server can negotiate a new protocol version, change its capability catalog, or alter a prompt, resource, and tool definition without a local deploy. Emit an effective configuration manifest with each run so a regression can be tied to the system that produced it.

Treat changes as migrations. Define compatibility for saved checkpoints and handoffs, keep old workflow code available while durable runs may resume, and add version adapters only where their behavior can be tested. Remove a version after its active work is drained and its replay or audit obligation has expired.

> **Versioning rule.** Middleware order determines which attempts a retry counter, usage recorder, transcript check, or error adapter observes. Store that order beside the model, tool, policy, and grader versions so a changed trace can be attributed to the system that produced it.

## Change middleware order without losing attribution

Suppose harness version h17 runs usage accounting outside transient retry, while candidate h18 moves it inside. The same underlying model attempt may now contribute to a different metric count even when user-visible output stays unchanged. The effective manifest must record middleware names and order, model settings, tool and policy versions, context assembler, runtime image, and grader bundle for both candidates.

Run the same versioned cases against h17 and h18, then inspect both accepted outcomes and intermediate spans. If saved workflows can resume across the change, replay tests must cover an h17 checkpoint continuing under the supported path. If the ordering changes persisted behavior, pin active h17 runs to their code or provide a tested patch path. Release notes should state the changed observation semantics instead of describing the move as internal cleanup.

_The manifest identifies the system that produced a trace; names alone are placeholders for immutable versions._

```yaml
harness: h18
middleware_order: [loop_guard, transient_retry, usage, message_repair]
model_config: model-v5
tool_bundle: tools-v12
mcp_protocol: 2025-11-25
mcp_catalog_digest: sha256:catalog-digest
policy: policy-v9
runtime_image: sha256:runtime-digest
grader_bundle: graders-v6
telemetry_schema: gen-ai-schema-version
```

## Measure the same contract before and after one change

Choose a task family with a known defect or cost. Capture a baseline over the same case versions, environments, permissions, and graders you will use for the candidate. Change one main variable, repeat enough runs to see variance, and compare task success, hard-gate failures, intervention, latency, tokens, and cost per accepted task.

Do not invent improvement numbers or compare unmatched runs. Attach raw run identifiers and report uncertainty. If the candidate improves median latency by skipping a required check, its accepted-task cost and safety score should expose the trade rather than rewarding the shortcut.

- Quality: accepted tasks and failure severity by task family.
- Safety: denied actions, policy breaches, secret exposure, and uncertain effects.
- Efficiency: latency distribution, tokens, tool calls, and cost per accepted task.
- Operations: retries, no-progress stops, human interventions, and recovery success.

## Roll out with an owner, a stop rule, and a reversible path

Start with shadow or read-only runs when the task permits, then a small authorized slice with close trace review. Define promotion gates, maximum exposure, alert ownership, and automatic rollback conditions before rollout. Keep an operator control that can disable the new version without waiting for the model or worker pool.

A maintenance record should name who owns the task suite, tool contracts, policy, environment image, and incident response. Review stale tools and permissions, rotate credentials, refresh cases from incidents, and retire instructions that no longer match the code. Every incident fix should leave behind a test, control, or explicit reason that prevents the finding from disappearing.

> **Operational readiness.** If nobody can say which version is active, which cases guard it, and how to turn it off, the system is not ready for unattended effects.

## Assemble the production topology before tuning a worker

The public examples in this collection run in one local process so each contract stays visible. A production service separates durable authority from replaceable execution. Draw that split before choosing a queue or agent framework.

| Component                      | Owns                                                                                                   | Must not claim                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Run API                        | Authenticated submission, caller idempotency key, task contract, status and cancel requests            | That accepting a request means work completed                              |
| Run store                      | Run phase, checkpoint version, owner epoch, budgets, approvals, terminal claim                         | The bytes of every artifact or the current state of an external service    |
| Scheduler and queue            | Runnable-unit creation, priority, delay, delivery, and lease assignment                                | Exactly-once business effects                                              |
| Workers                        | Temporary model and tool-loop execution under one lease epoch                                          | Durable ownership after the lease expires                                  |
| Model gateway                  | Provider protocol adapters, model routing, request budgets, usage records, and retry classification    | Permission to execute a proposed tool call                                 |
| Tool broker                    | Schema validation, authorization, approval checks, stable operation IDs, effect dispatch, and receipts | That model text can widen authority                                        |
| Sandbox pool                   | Isolated filesystem, process, resource, and network boundaries for code execution                      | The authoritative copy of a ticket, deployment, payment, or long-lived run |
| Artifact store                 | Content-addressed inputs, patches, reports, and verification output                                    | Workflow phase or external-effect completion                               |
| Verifier                       | Independent acceptance checks against the task contract and artifact digests                           | Ownership of the implementation attempt                                    |
| Telemetry and operator control | Linked traces, bounded metrics, audit events, admission stop, cancellation, and version disablement    | Silent repair of uncertain effects                                         |

Keep one identifier chain across those boundaries. A run ID groups the user's contract, an attempt ID names one leased execution, a tool-call ID names one proposal, and an operation ID remains stable across retries of the same intended effect. Receipts point to artifact digests and external resource versions. Trace IDs help debugging, but they don't replace any of these durable identities.

```text
client -> Run API -> run store
                    |
                    v
              scheduler -> queue -> worker lease
                                   |       |
                                   |       +-> model gateway
                                   |       +-> tool broker -> external service
                                   |       +-> sandbox pool -> artifact store
                                   |       +-> verifier
                                   |
                                   +-> versioned checkpoint and receipts

operator stop -> admission gate + scheduler + active leases + tool broker
all components -> traces, metrics, logs, and audit events
```

### Normal trace: one patch run reaches a verified terminal state

Suppose `POST /runs` carries caller key `fix-842` and a contract that permits a patch only inside `packages/parser`. The API stores run `R204` at checkpoint version 0 before returning `202 Accepted`; the response points to status, event, and cancellation endpoints.

The scheduler turns the accepted run into unit `U1`, writes that decision, then enqueues its identifier. Worker `W7` claims `U1` under lease epoch 11 and records attempt `A3`. It assembles context from the pinned checkout, calls the selected model through the gateway, and receives a proposed file read. The tool broker validates the arguments and policy before the sandbox reads anything.

Later, the broker accepts a patch call scoped to the same workspace. The sandbox applies it against base digest `B6`; the artifact store records patch digest `P9`, while the broker stores receipt `T14`. The verifier checks `P9` with the required parser test and type check, writes report digest `V4`, and returns a structured pass. `W7` advances the run through a compare-and-set from checkpoint version 6 to 7, linking `P9`, `V4`, the effective harness manifest, and the accepted terminal claim. Only then does it acknowledge the queue delivery. The status API reads the run store; it doesn't infer completion from an empty queue or a worker log.

If the queue redelivers `U1` after that acknowledgement, a worker sees the terminal checkpoint and exits without repeating the patch or publishing a second result. Queue delivery and effect deduplication remain separate contracts.

### Worker-loss trace: reconcile before another effect

Now let `W7` die after the broker commits operation `R204:publish-draft` but before checkpoint version 6 records the receipt. Its heartbeat stops, yet the run doesn't become safe to replay merely because the process vanished. After the lease deadline, the scheduler grants epoch 12 to `W9`; epoch 11 can no longer advance the run.

`W9` loads checkpoint version 5 and finds the started operation ID with no recorded outcome. It asks the tool broker to reconcile that ID. If the forge reports draft 913 with the expected artifact digest, the broker stores a reconciled receipt and `W9` advances to verification. If the forge reports no matching operation and supports idempotent create under the same key, the broker may retry with that key. If neither fact can be proved, the run enters `needs_operator` instead of guessing.

Suppose `W7` wakes after epoch 12 exists. Its checkpoint compare-and-set includes epoch 11 and fails, even if its local memory says the publish succeeded. A trace for the stale attempt remains useful evidence; it doesn't regain ownership. The queue delivery may happen again, but current checkpoint version, fencing epoch, and effect receipt decide the next safe action.

### Stop path: cancellation reaches every source of new work

An operator stop has to do more than hide the submit button. First, the API closes admission for the affected harness version and stores the stop reason. The scheduler stops creating and leasing units, active workers observe cancellation through the run store, and the model gateway rejects new generations for those runs. The tool broker blocks new effects while still allowing authorized reconciliation and cleanup. Sandboxes receive bounded termination. A run reaches clean `cancelled` only after current effects are classified as committed or absent; an unresolved effect keeps it in `needs_operator` or a distinct uncertainty terminal state.

Keep the old version disabled until its active leases end and its uncertain operations have owners. Killing every worker first can erase the only fast path to a clean drain; leaving the tool broker open can let a stale worker create one more effect after the operator thinks the system stopped.

This topology doesn't require separate deployables for every row. A small installation can combine several responsibilities in one service, but it should retain separate state, identities, authorization checks, and evidence at the boundaries above.

## A public minimal harness ties the contracts together

The dependency-free [minimal-harness.mjs](examples/minimal-harness.mjs) is the baseline for one measured change. It already supplies a normalized streaming model adapter, two tools, manual schema validation, tenant-scoped authorization, execution receipts, JSON checkpoints, a step budget, uncertain-effect reconciliation, and deterministic verification. No model key, external repository, or network call is needed.

The unchanged baseline runs from the notes repository root:

```sh
node notes/05-harness-engineering/examples/minimal-harness.mjs
node --test tests/public-harness.test.mjs
```

Its output records the causal order. `call-read` returns a payment error rate and an untrusted instruction. `call-bad` has valid argument types but fails authorization because it targets another tenant. `call-write` commits under a stable operation ID, loses its reply, and succeeds only after reconciliation finds the matching argument digest. The final text does not grant success; `verification.checks` does.

The sections below are a hypothetical candidate design, not output from the unchanged baseline. They show the failure and success traces an implementation would need to produce while preserving tenant policy, stable operation identity, uncertain-result reconciliation, and deterministic verification.

### Before: the write has no concurrency precondition

The baseline `read_service` result contains current service fields, while `set_maintenance` requires only `tenantId`, `enabled`, and `operationId`. The operation ID prevents a retry from repeating the same logical effect, but it does not say whether the state observed before the proposal is still current. Another actor can change the service after the read and before the write.

### Expected failing trace: a stale decision still commits

In the hypothetical failing fixture, observable service state has an integer version but writes do not yet enforce it. The model reads `shop-42` at version 1. A scripted concurrent actor changes the same record to version 2. Because the old write contract carries no expected version, the proposed maintenance change still commits and advances the record to version 3.

```text
read_service -> { tenantId: "shop-42", maintenance: false, version: 1 }
concurrent update -> { maintenance: false, version: 2 }
set_maintenance without expectedVersion -> committed at version 3

oracle:
  staleWriteRejected = false
  maintenanceUnchanged = false
  effectCount = 1
result: rejected candidate
```

The existing idempotency and tenant checks both pass in this trace. That is expected: they guard duplicate effects and authority, not stale observations. The failed oracle identifies the missing concurrency contract without weakening either existing control.

### Change: bind a new operation to the observed version

The candidate adds `version` to each service record and to `read_service`, then requires an integer `expectedVersion` in the `set_maintenance` schema. For a new operation ID, `setMaintenance` compares the stored and expected versions before mutation. A mismatch returns a structured conflict containing expected and actual versions and leaves the record unchanged. A match changes maintenance state and increments the version in the same store update.

Operation replay is checked before the current-version comparison. If a prior call with the same operation ID and argument digest already committed, a retry returns its recorded result even though that successful write advanced the version. Reusing the operation ID with a different digest still fails. The digest now includes `expectedVersion`, so reconciliation can distinguish the exact stale or current proposal that produced an uncertain response.

### Expected outcomes: conflict, success, and replay remain distinct

| Case                                              | Receipt                                                                | Authoritative state                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------ |
| Expected version 1, current version 2             | `conflict`, with `expectedVersion: 1` and `actualVersion: 2`           | Maintenance remains false at version 2; effect count 0 |
| Expected version 2, current version 2             | First reply is lost; reconciliation returns `confirmed_applied`        | Maintenance becomes true at version 3; effect count 1  |
| Same operation ID and same arguments after commit | Stored result returns with `replayed: true`                            | Version remains 3; effect count remains 1              |
| Same operation ID with different expected version | `operation_id_conflict`; the recorded argument digest does not match   | Version remains 3; effect count remains 1              |
| Correct version but wrong tenant                  | Tenant policy returns `denied` before the state-changing executor runs | The unrelated tenant remains unchanged                 |

An implementation record would need the original baseline result, the stale-write failure above, a bounded source and test diff, conflict and successful-write receipts, the reconciled lost-response path, and final state-based verification. Validation establishes argument shape, authorization establishes tenant scope, optimistic concurrency protects the observed version, and operation identity protects retries; none substitutes for another.

## Resumable approval adds a durable control boundary

The next hypothetical change adds a human decision between an authorized proposal and execution. The bundled baseline does not implement this approval state. Its invariant is simple: `set_maintenance` must not execute until the host receives an unexpired approval bound to the proposed call ID and arguments digest.

### Before: authorization permits immediate execution

In the baseline, schema validation, tenant authorization, and the payment-error precondition lead directly to `executeTool`. Those checks prove that the call is well formed, in scope, and permitted by the standing task contract. They do not prove that a person reviewed this exact effect. In a hypothetical failure fixture, `set_maintenance` becomes approval-required, no decision is supplied, and the old host still calls the executor once. The candidate is rejected because `executorCalls` should remain zero while approval is unresolved.

```text
proposal call-write -> schema valid -> tenant allowed -> threshold true
approval decision -> absent
baseline executorCalls -> 1
required executorCalls -> 0
result: rejected candidate
```

### Change: store the reviewed intent before pausing

The candidate marks `set_maintenance` as approval-gated in its tool definition. After schema and tenant checks pass, it stores a pending record containing the call ID, tool name, arguments digest, preview, and expiry, then returns a paused status without calling `executeTool`. A resume decision must match the saved record before execution starts.

Keep approval state separate from the operation receipt. The approval permits a call; the operation record and `reconcileWrite` still prevent a repeated effect after a lost response.

The pending approval becomes part of resumable state, so the candidate adds a checkpoint schema version. It rejects an unsupported version with a named terminal reason instead of guessing how to resume it. The round-trip evidence proves that approval survives serialization without carrying an executor function, credential, or mutable reference.

### Expected fail-closed outcomes

The expected approval matrix uses the same pending call and resets the executor counter before each resume. A missing decision remains paused. An explicit denial becomes terminal `approval_denied`. A decision for a changed arguments digest becomes `approval_mismatch`, and a decision received after `expiresAt` becomes `approval_expired`. All four paths leave `executorCalls` at zero and store a distinct reason.

| Resume input                   | Terminal or paused state | Executor calls | External effect |
| ------------------------------ | ------------------------ | -------------: | --------------- |
| No decision                    | `awaiting_approval`      |              0 | None            |
| Explicit denial                | `approval_denied`        |              0 | None            |
| Changed arguments digest       | `approval_mismatch`      |              0 | None            |
| Matching decision after expiry | `approval_expired`       |              0 | None            |

### Expected accepted trace: a fresh host resumes the exact approved call

A correct accepted path would serialize a versioned checkpoint after the proposal, create a fresh host, load the checkpoint, and apply a decision that matches `call-write`, its arguments digest, and its expiry. The executor would run once. If its reply were lost after commit, the stable operation ID would still drive reconciliation; approval would not be requested again for the same recorded operation.

```text
checkpoint v4:
  schemaVersion: 2
  status: awaiting_approval
  pending: { callId: call-write, argumentsDigest: d17, expiresAt: T+10m }

fresh host -> load checkpoint v4
decision -> { callId: call-write, argumentsDigest: d17, approved: true, decidedAt: T+2m }
executorCalls -> 1
write reply -> lost after commit
reconciliation -> confirmed_applied for the same operation ID and digest
verification -> accepted from authoritative state
```

In such an implementation, the saved approval record would prove which proposal a person allowed. Tenant authorization would still constrain who and what may change; optimistic version checking would still reject stale state; the operation record would still deduplicate or reconcile the write; and final verification would still read authoritative state. A verification record would need the pre-change failure, four fail-closed decisions, the checkpoint round trip, the single approved executor call, the reconciled receipt, and the final accepted state.

## Retire old paths only after work and evidence have drained

Keep an inventory of active run versions, resumable checkpoints, tool clients, policy bundles, sandbox images, grader versions, owners, and retirement dates. Before removal, confirm that no supported workflow can resume into the old code, required audit records remain readable, rollback no longer depends on it, and the replacement has passed its release gates. A calendar date alone does not prove those conditions.

Review changes by incident and accepted-task data. Track rollback rate, version skew, checkpoint migration failures, deprecated tool calls, stale permissions, eval drift, cost per accepted task, and time to disable a faulty version. When a metric moves, link it to the effective manifests and case traces before attributing cause. Keep the rollback simple enough to rehearse; an emergency path that requires editing prompts or rebuilding images during an incident is not ready.

> **Takeaway.** Pin the whole effective harness, compare one controlled change, release behind prewritten gates, and remove the old path only after resumable work has cleared it.

## Summary

Maintain the harness as a versioned service whose behavior depends on more than the prompt. Compare a controlled candidate with a matching baseline, release through prewritten gates, and keep rollback viable until active work no longer depends on the old path.

- Record an effective manifest containing model settings, instructions, context assembly, tools, middleware order, runtime image, policy, and graders. Include negotiated MCP and workflow compatibility versions plus the telemetry schema.
- Compare baseline and candidate on the same cases, environments, permissions, budgets, and acceptance rules.
- Change one main variable and repeat enough trials to separate a real effect from run-to-run variance.
- Define rollout owner, maximum exposure, promotion checks, stop conditions, and rollback action before traffic reaches the candidate.
- Keep run state, queue delivery, worker leases, model calls, tool effects, sandbox artifacts, verification, and operator stop as explicit production boundaries.
- In the worked design, version-checked writes preserve tenant policy, operation deduplication, reconciliation, and deterministic verification while rejecting stale observations.
- Track active run versions and resumable checkpoints so an older workflow cannot wake into missing code.
- Retire a path only after work has drained, audit records remain readable, and rollback no longer requires it.

## References

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Google SRE Workbook: Implementing SLOs](https://sre.google/workbook/implementing-slos/)
- [MCP 2025-11-25: Lifecycle and version negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
- [OpenTelemetry: Traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- [DBOS: Workflow recovery](https://docs.dbos.dev/production/workflow-recovery)
- [Minimal harness](examples/minimal-harness.mjs): Local baseline with scripted models and deterministic tools referenced by the worked designs.
- [Durable harness](examples/durable-harness.mjs): Local recovery example for checkpoint versions, leases, and reconciliation.

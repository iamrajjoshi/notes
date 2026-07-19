---
title: Agent orchestration
shortTitle: Orchestration
description: Assign planning, work, and evaluation roles with explicit dependencies, controlled parallelism, and stopping rules.
collection: harness-engineering
slug: agent-orchestration
order: 8
number: HE8
duration: 120 min
difficulty: Advanced
tags:
  - orchestration
  - parallelism
  - planner-worker-evaluator
  - stopping
---

## Working model

Orchestration is dependency management around bounded workers. Split work only when ownership and merge rules are clear, then let an evaluator judge collected evidence against the original contract.

## Questions this note answers

- Choose between one agent, manager-as-tools, handoff, and planner-worker-evaluator patterns
- Read a team manifest as enforceable roles, capabilities, dependencies, budgets, and terminal states
- Represent task dependencies before launching parallel work
- Account for fan-out latency and child work inside one parent budget
- Merge worker evidence without hiding disagreement or artifact conflicts
- Choose isolated or shared context according to the work and trust boundary
- Enforce success, no-progress, budget, and operator-stop conditions

## Add roles only when they create a clear boundary

One agent with several tools is easier to trace and often enough. A manager can call specialized agents as tools when it should retain the conversation and assemble the final result. A handoff fits a real ownership transfer, while planner-worker-evaluator separates task decomposition, execution, and acceptance.

Role names do not create independent judgment by themselves. Give the evaluator the task contract, candidate artifacts, and raw evidence rather than the worker's conclusion alone. If planner and evaluator share the same model and context, record that correlation instead of presenting their agreement as two independent votes.

> **Orchestration smell.** If every worker receives the full task, edits the same artifact, and reports prose to the same model, the design added concurrency without defining ownership.

## A team is a manifest executed by one runner

A model provider does not supply a durable engineering team. The host creates one by binding role contracts to model profiles, tools, context sources, authority, dependencies, and budgets. A framework can ship the manifest schema, runner, join logic, and a few reference teams; the application still owns production manifests because only it knows which repositories, accounts, data, and effects each role may reach.

The runner reads the manifest, resolves model profiles to configured providers, constructs each member's context, issues short-lived tool credentials, and schedules work whose dependencies are satisfied. It does not trust a role name such as `reviewer` to imply read-only access. The tool broker and sandbox enforce that role's declared capabilities and write set.

This provider-neutral example describes a planner, two parallel readers, one writer, and an evaluator. Profile names are local routing labels, not model product names.

```yaml
schema_version: team.v1
team_id: retry-fix

run:
  contract: fix retry regression without changing the public API
  source_revision: git:r1
  plan_epoch: 7
  aggregate_budget:
    model_calls: 18
    tool_calls: 40
    input_output_tokens: 120000
    cost_usd: 1.20
    deadline_seconds: 480
  terminal_states: [accepted, rejected, needs_human, cancelled, timed_out, budget_exhausted]

members:
  - id: planner
    role: decompose work and assign dependencies
    model_profile: reasoning-medium
    tools: [create_task, start_worker, cancel_worker, read_receipt]
    context_sources: [task_contract, repository_map]
    allowed_writes: []
    budget: { model_calls: 3, tool_calls: 8, tokens: 18000, seconds: 60 }
    depends_on: []

  - id: implementation_reader
    role: trace current retry behavior
    model_profile: analysis-small
    tools: [read_file, search_code]
    context_sources: [task_contract, source_revision, assigned_paths]
    allowed_writes: []
    budget: { model_calls: 3, tool_calls: 8, tokens: 18000, seconds: 90 }
    depends_on: [planner]

  - id: test_reader
    role: find the missing regression case
    model_profile: analysis-small
    tools: [read_file, search_code]
    context_sources: [task_contract, source_revision, test_map]
    allowed_writes: []
    budget: { model_calls: 3, tool_calls: 8, tokens: 18000, seconds: 90 }
    depends_on: [planner]

  - id: writer
    role: make one owned candidate change
    model_profile: coding-medium
    tools: [read_file, apply_patch, run_focused_test]
    context_sources: [task_contract, joined_reader_evidence, candidate_branch]
    allowed_writes: [candidate_branch:retry_module, candidate_branch:retry_tests]
    budget: { model_calls: 4, tool_calls: 10, tokens: 30000, seconds: 150 }
    depends_on: [reader_join]

  - id: evaluator
    role: judge the candidate against the original contract
    model_profile: evaluation-medium
    tools: [read_diff, read_test_receipt]
    context_sources: [task_contract, candidate_revision, raw_receipts]
    allowed_writes: []
    budget: { model_calls: 2, tool_calls: 4, tokens: 16000, seconds: 90 }
    depends_on: [writer]

joins:
  - id: reader_join
    requires: [implementation_reader, test_reader]
    rule: all_required_results_with_matching_source_revision_and_plan_epoch
    on_missing: needs_human
    on_conflict: preserve_both_and_pause

evaluation:
  owner: evaluator
  accepts_when: contract_checks_and_required_receipts_pass
  otherwise: [one_bounded_repair, rejected, needs_human]

cancellation:
  parent_cancel: propagate_to_all_children
  worker_timeout: cancel_tools_then_mark_timed_out
  grace_seconds: 5
  late_result: reject_unless_run_id_revision_and_plan_epoch_match
```

The manifest records intent; enforcement still lives in code. The scheduler must refuse undeclared tools, the executor must reject writes outside `allowed_writes`, and the budget service must debit actual child use from the aggregate. A YAML file that the model may reinterpret is documentation, not policy.

## Choose among three control patterns

All three patterns can use the same model and tool adapters. They differ in who owns the conversation, who may decide the next step, and where terminal responsibility sits.

### A manager calls specialists as bounded tools

The manager retains the user task and final answer. A specialist call looks like any other tool call: the manager supplies a narrow input contract, the runner starts an isolated child, and the child returns a structured result or error. The specialist cannot talk to the user, delegate beyond its cap, or silently take ownership of the run.

Suppose a manager debugging a checkout failure can call `inspect_logs` and `inspect_schema`. Each specialist receives only the relevant time range or schema objects, has read-only tools, and returns cited findings at a pinned revision. The manager compares both results and decides what to ask next. This pattern fits bounded expertise whose output feeds one continuing line of reasoning. It is still one manager-controlled loop, not five peers voting on an answer.

Avoid this shape when the manager must copy most of its context into every call or when a specialist needs hours of durable ownership. The tool boundary then adds token cost without reducing ambiguity.

### A handoff transfers ownership

A handoff ends one owner's active control and installs another. The transfer record contains the original contract, current messages or a bounded summary, completed receipts, pending effects, remaining budget, authority, source revision, and a reason for transfer. The receiving role must accept or reject that record before the old owner releases its lease.

An intake agent might identify a database recovery incident and hand it to a recovery controller that has the right runbooks and approval path. After acceptance, the recovery controller chooses subsequent actions and owns the terminal report; the intake agent does not keep composing an answer in parallel. A failed acceptance returns ownership to the sender or enters `needs_human` according to the manifest.

Use handoff for a real phase or authority change. Do not bounce a task between roles for stylistic review, because every transfer can lose context, split budgets, and muddy who owns an uncertain effect.

### A planner fans out readers, then one writer and an evaluator finish

The planner converts the contract into a dependency graph. Read-only workers inspect disjoint areas against the same immutable revision. A join rejects stale work and preserves disagreement; it then gives one writer an owned branch or resource set. After the writer produces a candidate revision, an evaluator with no write tool reads the original contract, raw receipts, and candidate artifacts.

This is the strongest pattern for repository work that has parallel discovery but one integration boundary. The single writer avoids competing patches, while the evaluator cannot quietly repair the work it is judging. Independence is limited if both roles share a model family or instruction chain, so the trace should record those common dependencies.

Do not use this graph for a one-file change whose focused test takes ten seconds. Planning, queueing, context construction, and joins can cost more than the task.

## Keep one agent when coordination would dominate

A team is the wrong default when each step depends on the full result of the last one, several roles would mutate the same object, or the task fits inside one bounded loop with one acceptance check. It also adds little when every role uses the same model profile, context, tools, and authority; new labels do not create a new source of evidence.

Stay with one owner when the work is shorter than worker startup and join time, when the parent cannot state independent output contracts, or when the budget cannot reserve enough capacity to finish after one worker fails. Fix an unclear task contract before splitting it. Parallel ambiguity produces more reports, not a better decision.

## Decompose by evidence and write boundaries

A planner owns the dependency graph, not the truth of each finding. A worker owns one bounded investigation or write set and returns artifacts plus evidence. A join owns conflict detection and version matching. An evaluator owns comparison with the original contract, while the runner owns budgets, cancellation, authority, and terminal state. These roles can run in one process or several; separate names matter only when the contracts differ.

Partition by objects that can be inspected or changed independently. Read-only research across unrelated subsystems often splits well. Editing two isolated packages can split when each has a defined interface and later integration check. Work that shares a schema, migration order, deployment target, or source file needs an explicit dependency. If the merge rule cannot be stated before launch, keep one owner until the shared boundary is understood.

- Input contract: exact question, allowed sources, authority, and budget
- Output contract: findings, artifacts, evidence links, uncertainty, and version
- Write ownership: one worker or isolated branch for each mutable object
- Join contract: agreement checks, conflict handling, and stale-result rejection

## Fan out independent reads; serialize conflicting effects

Build a dependency graph before launch. Research across unrelated sources, tests against immutable candidates, and inspection of separate subsystems can run concurrently. Two workers editing the same file or mutating the same resource need isolation, an ownership partition, or serialization.

Every worker should receive a bounded sub-contract and return structured findings with evidence links, confidence or uncertainty, artifact versions, and unresolved conflicts. The join step should preserve disagreement. It must not collapse incompatible observations into a smooth summary that no source supports.

_Dependencies and write sets make safe concurrency visible before workers start._

```yaml
plan:
  - id: inspect-api
    writes: []
  - id: inspect-tests
    writes: []
  - id: patch
    depends_on: [inspect-api, inspect-tests]
    writes: [candidate-branch]
  - id: evaluate
    depends_on: [patch]
    writes: []
```

## Price fan-out before launching it

Parallel workers reduce the critical path only when their tasks are independent and capacity is available. Suppose three read-only investigations take 12, 18, and 9 seconds, followed by a 6-second join and evaluation. Sequential execution takes `12 + 18 + 9 + 6 = 45` seconds. Ideal fan-out takes `max(12, 18, 9) + 6 = 24` seconds, saving 21 seconds before queue and startup overhead.

The model bill does not receive the same reduction. If those workers cost $0.18, $0.27, and $0.11 and the join costs $0.09, the run still costs $0.65. Repeating a 10,000-token repository briefing in every isolated child can make fan-out more expensive than a single long-lived context. Report wall-clock latency and aggregate work separately.

A child budget is a subdivision of the parent budget, never a new allowance. For an 18-call parent cap, reserve 3 calls for planning and 3 for evaluation; the runner may reserve at most 12 across workers. If two readers reserve 4 calls each, only 4 remain for the writer. Charge actual calls, release unused reservations when a child ends, and reject delegation whose reservation would exceed the parent's remaining cap. Apply the same ledger to tokens, tool calls, money, elapsed deadline, and nested children.

Deadlines compose differently from token totals. A child with a 90-second timeout cannot extend a parent deadline that expires in 40 seconds. The scheduler gives it `min(child_timeout, parent_time_remaining)`, including cleanup time. This prevents nested delegation from manufacturing time.

## Isolate context by default and share records

Shared context lowers handoff cost because every member can see prior conversation and tool output. It also spreads irrelevant data, malicious retrieved text, secrets, and one worker's framing error across the team. Concurrent members can read different points in a changing shared transcript unless the runtime snapshots it, and a growing conversation consumes every member's input budget.

Isolated context gives each worker the task slice, source revision, tools, and evidence it needs. That makes least privilege and attribution easier, but workers may duplicate discovery or miss a dependency that the planner failed to include. The join must therefore exchange typed records rather than informal summaries: finding, source, revision, plan epoch, uncertainty, artifact digest, and unresolved question.

A useful default is a shared immutable contract plus isolated working context. Share stable identifiers and accepted artifacts through the store; do not expose every worker's scratch reasoning. Use a shared transcript only when turns truly depend on the same evolving conversation and all members have compatible data authority.

## Run two inspections before one owned patch

A task asks for a retry regression fix. Worker A reads the retry implementation and returns the current state transition with line references. Worker B reads the focused tests and returns the missing failure case. Both operate on immutable revision r1 with no write tools, so they run concurrently. The join checks their revision IDs and retains a disagreement about whether timeout errors count toward the attempt limit.

The planner assigns one patch worker the accepted contract, both evidence records, and a private candidate branch. That worker produces r2. A test worker evaluates r2 without edit authority, while a policy worker checks the diff scope. The evaluator receives r2, raw check receipts, and the unresolved semantic question. Because that question affects intended behavior, the runner pauses for the product owner rather than asking another worker to average the two interpretations.

_Parallelism follows immutable inputs and disjoint effects; the dependency graph preserves the join._

```text
r1 -> inspect implementation || inspect tests
join -> retain evidence and semantic disagreement
owner decision -> resolve intended timeout behavior
single patch worker -> candidate r2
r2 -> focused tests || read-only scope review
evaluator -> accept, repair request, or pause
```

## Stopping belongs to the runner, not the worker's mood

The runner stops successfully when the evaluator can attach all required proof to the candidate. It stops unsuccessfully on a hard budget, operator cancellation, denied authority, or a repeated no-progress signature. An evaluator may request repair, but each request should point to a failed criterion and consume a bounded attempt.

Track model calls, tool calls, elapsed time, tokens, monetary cost, repeated states, and pending worker count. Cancel sibling work when its result can no longer affect the outcome. Preserve the termination reason and partial artifacts so an operator can resume or inspect the run without guessing what the system did.

> **Runner rule.** A planner that delegates work still spends the parent's budget. The runner warns near the limit, blocks calls beyond it, and records which child consumed each unit; delegation can't create an uncounted loop.

## Treat worker loss and stale work as explicit outcomes

Give every child a run ID, parent ID, source revision, plan epoch, lease, and deadline. A heartbeat renews the lease while the child or its tool is active. When the lease expires, the runner marks the worker lost and decides from the effect class: a read-only task can usually restart inside the remaining budget, while a state-changing task with an unknown result must reconcile against the external authority before any retry.

Cancellation is cooperative first and enforced second. The runner signals the model adapter and active tools, waits the declared grace period, then revokes credentials and terminates the sandbox where supported. It records `cancelled`, `timed_out`, or `effect_unknown` instead of treating missing output as an empty result. If one branch proves the contract impossible, siblings whose evidence cannot change that terminal decision should be cancelled; already useful partial findings remain attached to the run.

Joins accept results only from the expected run, revision, and epoch. Suppose the planner replans from epoch 7 to epoch 8 after a schema change and a slow worker later returns a patch against `r1` tagged epoch 7. The join stores that result for audit but rejects it from the candidate. A downstream worker begins only from the newly accepted revision, such as `r2`, rather than whichever response arrived last.

Worker crashes do not erase parent accounting. Calls and tool effects already attempted stay charged, reservations for impossible future work return to the parent, and the trace links the failure to any retry. A restarted child gets a new attempt ID under the same task ID so the join can distinguish repeated work from two independent findings.

### Code walk: follow the team manifest to terminal status

Use the `team.v1` manifest near the start of this note. Before scheduling work, check that member IDs are unique, dependencies resolve, every write path belongs to one writer, and reserved member budgets fit inside the aggregate limits. A role label such as `evaluator` grants nothing by itself.

Run the planner and both readers with scripted results, but tag `test_reader` with plan epoch 6 while the manifest expects epoch 7. `reader_join` must reject the stale result and choose its declared `on_missing` outcome; the writer never starts. Repeat with epoch 7, let the writer produce candidate `r2`, and give the evaluator a failed test receipt. Trace the single repair allowance to either a new accepted candidate or `rejected`.

At each transition, record the manifest field that permits it, the budget debit, the accepted artifact revision, and the stop reason. If the runner can't point to those records, the YAML describes a team without enforcing one.

## Detect orchestration waste before it becomes a loop

Record queue time, active workers, dependency wait, cancelled work, stale-result rejection, artifact conflicts, duplicate investigations, join disagreements, repair depth, and cost per accepted task. A high worker count with long dependency waits indicates premature fan-out. Frequent stale results mean tasks outlive the revisions they inspect. Repeated conflicting edits show that write ownership or isolation is missing.

Review whether each worker result changed a later decision. Remove roles that only restate the task or summarize another worker. Cap nested delegation and count child calls against the parent budget. When one branch proves the task impossible or already satisfied, cancel siblings whose output cannot change the terminal decision. Keep partial evidence and cancellation reasons so the saved cost does not erase useful work.

> **Takeaway.** Split independent evidence gathering, serialize shared effects, preserve disagreement at joins, and let one runner enforce the aggregate stop rules.

## Summary

Orchestration should expose dependencies and ownership, not add agents for appearance. Parallel work pays off when workers can inspect immutable inputs independently and return evidence that a join can compare against one revision.

- Start with one agent and several tools unless another role has a distinct contract, authority, or ownership boundary.
- Treat a team as a manifest plus an enforcing runner: role names alone do not grant tools, writes, budget, or terminal authority.
- A manager keeps ownership while calling specialists as tools; a handoff transfers ownership; a planner graph joins bounded workers before one writer and an independent evaluator finish.
- Run unrelated reads concurrently against a pinned revision, but serialize effects that touch the same artifact or resource.
- Reject results whose run ID, source revision, or plan epoch is stale, and preserve conflicts instead of averaging them away.
- Charge children to one parent ledger; the runner owns timeouts, worker loss, cancellation, uncertain-effect reconciliation, and terminal state.
- Prefer a shared immutable contract with isolated working context and typed evidence records unless the work needs one evolving transcript.

## References

- [OpenAI Agents SDK: Multi-agent orchestration](https://openai.github.io/openai-agents-python/multi_agent/)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)

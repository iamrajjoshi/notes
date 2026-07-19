---
title: Model, agent, harness, and failure taxonomy
description: Separate model behavior from the agent loop and its host runtime, then classify failures at the layer that can actually fix them.
slug: model-agent-and-harness
order: 1
identifier: HE1
duration: 95 min
difficulty: Foundation
tags:
  - agent loop
  - workflows
  - failure taxonomy
  - middleware
---

## Working model

The model proposes the next move. The agent loop lets it observe and act. The harness owns the rails: inputs, capabilities, state, limits, evidence, and termination.

## A model predicts; an agent acts through a host

A language model maps input context to output tokens. It does not read a repository, call an API, or retain durable memory on its own. An application must expose tools, execute selected calls, return results, and decide when the run ends.

An agent is that model inside a feedback loop: observe, choose an action, receive a result, and continue. The harness is the ordinary software that builds context, validates tool arguments, manages state, applies policy, records traces, and accepts or rejects the result. Calling all three layers "the agent" makes incident reports hard to act on.

> **Toy harness.** Imagine a host that wraps each model call with a retry classifier, a usage counter, a transcript validator, and a hard turn limit. The model doesn't own any of those controls, even though each one can change the result a user sees.

## Learn the runtime vocabulary before tracing a failure

| Term           | Meaning in these notes                                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Message        | One structured conversation item, such as a user request, model response, tool call, or tool result                      |
| Token          | A model's unit of text input or output; a word may become one token or several                                           |
| Context        | The messages, instructions, retrieved material, and tool results supplied to one model call                              |
| Context window | The model's limit on the tokens it can consider in one call, including both input and generated output                   |
| Tool           | A host-defined capability with a name, input contract, executor, and result contract                                     |
| Tool call      | The model's proposal to invoke a tool with particular arguments; it has no effect until the host accepts and executes it |
| Executor       | The code and identity that perform the accepted operation against a filesystem, process, API, or other system            |
| Agent loop     | The code that alternates model calls with observations until a terminal condition is reached                             |
| Workflow       | Code that fixes the allowed steps and branch conditions instead of asking the model to choose all of them                |
| Harness        | The host system around the loop or workflow: context, tools, state, policy, budgets, evidence, and stopping              |
| Middleware     | Host code wrapped around model or tool calls to observe, modify, retry, reject, or stop them under explicit rules        |
| Trace          | A time-ordered record that links the task, model calls, tools, effects, checks, and terminal decision                    |

A **prompt** is the model-facing content used for a call. In a chat API it may be assembled from several messages rather than one text string. A **run** is the larger attempt to satisfy one task contract; it can contain many model calls, tool calls, retries, and checkpoints. Keeping call, turn, and run separate prevents a per-call retry from being mistaken for a restart of the whole task.

## Assign each decision to the layer that can enforce it

The model owns no durable authority. It produces a proposed message or tool call from the context it received. The agent loop owns turn sequencing: send context, inspect the response, execute an allowed action, append the observation, and decide whether another turn is permitted. A workflow owns branches written directly in code rather than selected by the model.

The harness owns everything that must remain true when the model is mistaken. It authenticates the caller, constructs the task contract, selects tools, validates arguments, chooses the executor identity, records effects, checks budgets, persists resumable state, and evaluates completion. External systems still own their records. A ticketing API, database, or deployment controller remains the source of truth after a tool returns, so the harness must reconcile uncertain results there.

- Model output: a proposal that may be malformed or factually wrong
- Agent-loop state: messages, pending calls, attempt count, and stop reason
- Harness state: policy, receipts, checkpoints, evidence, and budgets
- External authority: the current repository, service, account, or resource state

## Use fixed workflows until the path truly depends on observation

A workflow follows code-defined branches. An agent chooses some branches at runtime from observations. A refund policy with known checks is usually a workflow; diagnosing an unfamiliar build failure may justify an agent because the next useful command depends on the last result.

Agency has a carrying cost. Each extra decision can select the wrong tool, repeat a side effect, consume context, or wander after success. Start with the smallest decision surface that fits the task, and leave authentication, policy checks, transaction boundaries, and final acceptance in deterministic code.

- Workflow: the developer fixes the path and branch conditions.
- Agent: the model chooses among bounded actions from current evidence.
- Harness: code enforces what may happen around either control style.

## Follow one code repair without blurring the layers

Suppose a task asks for a failing parser test to pass without changing the public schema. The harness first records that acceptance rule, grants read access to the package and write access to a temporary branch, then supplies the relevant repository guidance. The model proposes reading the failing test. The host validates the path, performs the read in the sandbox, and returns bounded output with the file revision.

After another turn, the model proposes a patch. The harness checks the write set, applies the edit, records the new artifact digest, and runs the required focused test through a deterministic tool. A zero exit status is useful only if the receipt also shows that the intended test was collected. The harness compares the diff and test evidence with the original contract. It marks success and stops; the model's closing sentence does not decide completion.

_Each arrow crosses an explicit boundary with a record that later steps can inspect._

```text
contract -> allowed paths + acceptance checks
model -> read request
host -> validated file result at revision r1
model -> patch proposal
host -> artifact r2 + focused-test receipt
harness -> contract check + terminal status
```

## Run one read-only tool loop first

The [first tool loop](examples/first-tool-loop.mjs) is the smallest executable version of the model, host, and tool boundary. It uses one scripted model and one read-only service lookup, so it runs offline with built-in Node modules:

```sh
node notes/05-harness-engineering/examples/first-tool-loop.mjs
node --test tests/first-tool-loop.test.mjs
```

Read its trace in this order:

1. **Model proposal:** the model returns a structured `read_service` call with `{ service: "checkout" }`. This is data, not an executed function.
2. **Host validation:** ordinary code checks the tool name and requires exactly one non-empty string argument.
3. **Tool execution:** only after validation does the host call the read-only executor.
4. **Observation returned:** the host packages the result as a tool message with the proposal's call ID and appends it to the message list.
5. **Model terminal answer:** the model receives that updated list, reads the observation, and returns text. The host then ends this two-turn run.

The model never calls `readService` directly. `runFirstToolLoop` receives the proposal, validates it, invokes the function, and decides what the model sees next. The messages make the boundary concrete: `user -> assistant tool call -> tool result -> assistant text`.

This example stops before production concerns on purpose. It has no writes, authorization, hostile data, provider streaming, checkpoints, reconciliation, or independent acceptance check. Those mechanisms are easier to understand once this control handoff is familiar.

## Continue with the recurring full-system harness

The first loop is the beginner bridge. The public [minimal harness example](examples/minimal-harness.mjs) is the recurring full-system example used across later chapters. It keeps the same model-host-tool handoff, then adds the mechanisms that the first loop omits. It also uses a scripted model, so it runs offline and produces the same trace every time. Start at the notes repository root:

```sh
node notes/05-harness-engineering/examples/minimal-harness.mjs
node --test tests/public-harness.test.mjs
```

The task asks the model to enable maintenance for `shop-42` when its payment error rate exceeds five percent. The first tool reads that rate. Its result also contains a hostile string telling the model to change `shop-99`; the scripted model follows the string, but host policy denies the proposed write because retrieved text never grants authority. The model then proposes the permitted write with the task's stable operation ID.

That write commits and loses its reply. Retrying blindly could repeat an effect, so the harness looks up the operation ID in authoritative state, confirms the stored argument digest, and records a `succeeded_after_reconciliation` receipt. Only then does the model produce its terminal text. Deterministic verification checks the actual tenants, the policy denial, the committed operation, the reconciliation record, and the model's stop reason before accepting the run.

Provider adapters disagree about event names, but the host needs only two normalized outputs here: content deltas plus a stop reason. `assembleModelStream` joins partial text or JSON arguments and returns a message whose parts are either `text` or `tool_call`. Everything after that point is provider-neutral.

The checkpoint store remains deliberately plain. Its messages, receipts, step counter, and terminal decision survive a JSON round trip, which makes the state easy to inspect and later move to durable storage. Process memory is not durable storage; the example isolates that missing production concern instead of disguising it.

## Name the broken contract before changing the prompt

Intent failures start with an underspecified goal or a wrong acceptance rule. Context failures omit, stale, or bury relevant evidence. Tool failures cover bad selection, malformed arguments, misleading results, and unhandled errors. Environment failures include missing dependencies, denied permissions, network policy, and sandbox drift.

State failures lose progress or replay an effect. Verification failures accept plausible text without testing the artifact. Safety failures expose data, exceed authority, or ignore a budget. A run can cross categories, but the first violated contract is a useful starting point: prompt edits cannot grant a filesystem permission, and a retry cannot repair an unsafe tool definition.

> **Incident habit.** Record the first bad decision and the evidence visible at that moment. The final wrong answer is often several steps downstream of the fixable defect.

### Worked trace: separate the turn loop from its guardrails

In [minimal-harness.mjs](examples/minimal-harness.mjs), `runHarness` passes one iteration through `assembleModelStream`, argument validation, authorization, tool execution, receipt storage, and `verify`. Several branches can reject or stop the run without asking the model for permission.

`ScriptedModel`, `InvalidArgumentsModel`, and `LoopingModel` produce different proposals, while the same host code enforces schemas, tenant scope, effect reconciliation, and the step budget. Each control has a visible trigger, reads host-owned state, takes a deterministic action, and refuses to hide a named failure.

## Start incident review at the first unsupported transition

Read the trace in causal order. Compare the task contract with assembled context, the model proposal with allowed capabilities, validated arguments with executor logs, the tool receipt with authoritative state, and collected evidence with the terminal decision. The first transition that lacks support identifies the component to inspect. Later errors may be consequences rather than separate causes.

Keep counts by failure owner: contract rejection, context miss, schema rejection, permission denial, executor failure, uncertain effect, checkpoint error, verification failure, policy block, and budget stop. Pair each count with a trace sample and software version. A rising permission-denial rate after an image rollout calls for an environment or policy check; it does not justify a broader prompt or more model retries.

> **Runbook entry.** For every failure class, record the owner, evidence location, safe retry rule, escalation path, and condition that closes the incident.

## Summary

Keep the layers separate when designing or debugging an agent. The model proposes an action, while code outside the model grants authority, performs effects, records evidence, and decides whether the run may continue.

- A model call produces tokens; it cannot inspect a repository, retain state, or call an API without a host.
- The agent loop sequences observations and proposed actions. A workflow keeps predetermined branches in ordinary code.
- Use an agent only when new observations must decide the next step; fixed policy checks belong in a workflow.
- The harness owns context assembly, tool policy, sandboxing, budgets, receipts, verification, and termination.
- The first offline example shows one read-only proposal, host validation, execution, returned observation, and terminal model answer without later-course mechanisms mixed in.
- The recurring minimal-harness example adds streamed arguments, a policy denial, an uncertain effect, reconciliation, checkpoints, and deterministic acceptance.
- Diagnose incidents in causal order: contract, context, proposal, authorization, execution, receipt, then acceptance.
- Fix the first layer whose evidence does not support its transition instead of changing the prompt by default.

## References

- [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/)
- [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
- [MCP 2025-11-25: Tools and schemas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [First tool loop](examples/first-tool-loop.mjs): Small offline example of proposal, validation, execution, observation, and stop.
- [Minimal harness](examples/minimal-harness.mjs): Offline example with policy, receipts, reconciliation, verification, and a step budget.

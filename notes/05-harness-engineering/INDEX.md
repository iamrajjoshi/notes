---
title: Harness engineering
description: Agent contracts, context, MCP and tools, durable state, verification, safety, orchestration, evaluation, and maintenance.
slug: harness-engineering
order: 7
duration: 21 to 24 hours
---

## Scope

How to turn an ambiguous request into a bounded run, connect tools and context through explicit protocol boundaries, preserve state across failures, collect proof, evaluate behavior, and release changes with safety and cost controls.

The sequence defines the model, host runtime, and task contract before it introduces context assembly, MCP, durable state, verification, production authority, orchestration, evaluation, and maintenance. Bundled examples use scripted models and local state, so their programs and focused tests run without a model key or access to another repository. Design traces that are not implemented by those examples say so explicitly.

## Reading path

| Note                                                                   | Why it comes here                                                                                              |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [HE1: Model to harness](01-model-agent-and-harness.md)                 | Separates model proposals, the agent loop, deterministic workflows, host execution, and harness controls.      |
| [HE2: Executable intent](02-intent-and-executable-contracts.md)        | Defines success, scope, authority, evidence, and stopping before the run receives consequential tools.         |
| [HE3: Context architecture](03-context-architecture-and-agents-md.md)  | Builds one attributable model input from policy, task facts, selected evidence, skills, and working state.     |
| [HE4: Tools, MCP, sandboxes](04-tools-environments-and-sandboxes.md)   | Connects proposals to typed capabilities, protocol boundaries, executor identity, isolation, and safe effects. |
| [HE5: State and handoffs](05-durable-state-continuity-and-handoffs.md) | Preserves progress, ownership, artifacts, and uncertain effects across processes and failures.                 |
| [HE6: Verification loops](06-verification-and-feedback-loops.md)       | Binds independent evidence to one candidate and uses failed checks to drive bounded repair.                    |
| [HE7: Safety controls](07-production-safety-and-control.md)            | Applies least privilege, approvals, tenant boundaries, containment, and operator stops to the full path.       |
| [HE8: Orchestration](08-agent-orchestration.md)                        | Splits work among bounded roles only after one run's contracts, state, proof, and safety are explicit.         |
| [HE9: Agent evals](09-evaluation-engineering.md)                       | Measures the resulting system with representative tasks, layered graders, repeated trials, and attack cases.   |
| [HE10: Measured maintenance](10-maintenance-and-capstone.md)           | Versions, deploys, observes, rolls back, and eventually retires the complete harness.                          |

## Useful background

- Comfort reading TypeScript or Python and structured configuration
- Basic knowledge of HTTP, queues, containers, and distributed tracing
- Experience writing tests or reviewing test evidence
- No prior agent framework or MCP experience; the first four notes define that vocabulary
- No model training or machine-learning research experience required

[AI inference infrastructure](../04-ai-inference/INDEX.md) is optional background for how a model call is served. This collection treats the model call as one dependency and begins independently with the model-agent-host boundary.

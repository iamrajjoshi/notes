---
title: Verification and feedback loops
shortTitle: Verification loops
description: Turn tool output into evidence, run the cheapest decisive checks first, and bound repair attempts when a candidate fails.
collection: harness-engineering
slug: verification-and-feedback-loops
order: 6
number: HE6
duration: 125 min
difficulty: Core
tags:
  - verification
  - feedback
  - tracing
  - repair loops
---

## Working model

A tool result says what the tool reported. Verification compares independent evidence with the task contract. Feedback then changes the next action without weakening the original acceptance rule.

## Questions this note answers

- Distinguish action results, evidence, and acceptance decisions
- Build a verification ladder from static checks to runtime observation
- Design a bounded diagnose-repair-retest loop
- Capture traces that explain both success and failure
- Separate low-cardinality operations data from protected model and tool content

## Execution output is not the same as independent evidence

A write tool can return success while producing the wrong artifact. A test command can exit zero because it selected no tests. Verification should inspect the resulting state and confirm that each acceptance check actually ran against the intended target.

Build a ladder from cheap, local checks to slower, broader checks. For code this might begin with schema or syntax validation, then focused tests, a type check, the final diff, and a runtime probe in an appropriate environment. The exact order follows cost and diagnostic value, not a fixed ceremony.

> **Evidence rule.** Record the command or probe, target, environment, exit status, relevant output, and artifact version. A bare "tests passed" cannot be reproduced or tied to a candidate.

## Name the candidate, oracle, and decision owner

The candidate is the exact artifact or external state under review, identified by digest, revision, or resource version. An oracle is the rule that interprets an observation: a schema, test assertion, policy decision, state predicate, rubric, or human judgment. Evidence is the recorded observation tied to the candidate and environment. Acceptance is the deterministic decision that all required oracles passed under the task contract.

Tool authors own truthful, structured receipts. Test and policy owners define exact oracles. The harness binds observations to the candidate and applies the acceptance rule. A model judge may supply one scored observation, but it should not alter the rubric, omit deterministic failures, or approve its own consequential action. Human reviewers own exceptions that change the contract, and those exceptions need their own recorded authority and scope.

- Candidate identity prevents evidence from one revision accepting another
- Environment identity exposes differences in dependencies and permissions
- Oracle version explains why the same observation may receive a new decision
- Decision record lists required checks, results, exceptions, and terminal reason

## A failed check should narrow the next move

A useful feedback loop preserves the original contract, identifies the first failed check, gathers the smallest extra evidence needed to explain it, changes one plausible cause, and reruns the affected check before the wider suite. Rewriting the acceptance rule after a failure hides the regression instead of repairing it.

Prefer deterministic signals when they can decide the case: parsers, schema validators, tests, policy engines, and state reconciliation. Use a model judge for qualities that resist exact checks, such as whether a handoff preserves the important risks. Calibrate that judge against human-reviewed examples and retain the judged artifact for later review.

- Stop on success only after all required evidence is attached to the candidate.
- Stop on repeated no-progress states rather than spending the full budget by default.
- Escalate when the failed check exposes an unresolved product or policy choice.
- Revert or quarantine a candidate that cannot be shown to preserve required behavior.

## Repair one candidate without weakening its proof

Candidate r2 changes a JSON parser. Syntax validation passes, but the focused test command exits with pytest code 5 because it collected no tests. The harness marks the command complete and the required test evidence missing. It checks the node identifier in the command rather than changing acceptance to 'exit zero.' The corrected selector runs four intended tests; one fails on a nested-array case with a stable assertion difference.

The agent reads only that test, the parser branch it covers, and the relevant contract. Candidate r3 changes one condition. The harness reruns the four focused tests, then the package type check and regression suite against r3. It inspects the diff for unrelated files and stores each receipt with the r3 digest. If the same failure signature returns after the configured repair count, the run stops and preserves r2, r3, and the unresolved observation for review.

_A failed proof step changes the next diagnostic action, not the acceptance rule._

```text
r2 syntax: pass
r2 focused test: no tests collected -> evidence missing
r2 corrected selector: 3 pass, 1 fail
r3 focused test: 4 pass
r3 type check + regression + scoped diff: required next
```

## Trace the causal path, then cap the repair loop

A trace should connect the task contract, model calls, tool arguments, sanitized results, artifact versions, checks, retries, approvals, and termination reason. Metrics show how often a pattern happens; logs keep selected details; traces explain how one run reached its outcome. Correlation identifiers let evidence cross worker and service boundaries.

Repair logic must be bounded by attempts, elapsed time, tokens, cost, or a combination. Detect repeated tool calls and unchanged failure signatures. When a message stream becomes invalid, repair only the protocol defect needed for the next valid turn and record that repair; do not silently rewrite evidence that influenced an earlier decision.

> **Toy repair loop.** Give the host separate rules for transcript validity, retryable transport faults, usage recording, and the step budget. Keeping them separate makes the trace say whether a turn was repaired, retried, observed, or stopped.

### Code walk: classify four control paths

Build four scripted cases around a toy model adapter:

| Trigger                                                           | Host action                                                                                    | Boundary                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A saved transcript ends with a tool call whose executor never ran | Append an explicit aborted-call result before the next model turn                              | Don't invent tool output or rewrite an earlier observation     |
| The provider connection drops while streaming a candidate         | Discard the partial candidate and retry only when the error class and attempt budget permit it | Don't join text from two attempts or repeat an external effect |
| The next model call would exceed the run's step budget            | Store `budget_exhausted` and stop before the call                                              | Don't ask the model whether its own limit applies              |
| The provider reports input and output token counts                | Record bounded usage fields on the call span                                                   | Don't let missing usage data change authorization or success   |

For each row, write a positive test and a nearby negative test. [minimal-harness.mjs](examples/minimal-harness.mjs) already supplies two useful fixtures: `assembleModelStream` constructs one candidate from streamed events, and `LoopingModel` reaches a host-enforced step limit. Keep the repair and retry fixtures scripted so the exercise runs without a provider account.

## Trace the operation without copying the whole payload

Start a run span at the task boundary, then connect model turns, tool calls, handoffs, policy decisions, checks, and durable steps beneath it. Use stable identifiers to join the trace to the task contract, candidate digest, checkpoint, approval, and effect receipt. Put bounded categories such as tool name, result class, stop reason, retry class, model identifier, and oracle version in indexed fields; keep user text, prompts, arguments, results, and artifacts out of ordinary labels.

OpenTelemetry now publishes separate GenAI semantic conventions for agent invocation and tool execution. The conventions include operations such as `invoke_agent` and `execute_tool`, plus model usage and latency attributes, but the GenAI surface remains under development. Pin the emitted schema version and test dashboards when upgrading instead of assuming an attribute name will stay fixed. OpenTelemetry also warns that system instructions, messages, tool arguments, and tool results may contain sensitive data; content capture should be off by default and enabled only through a reviewed policy.

Framework tracing does not replace the system trace. For example, the OpenAI Agents software development kit (SDK) records model generations, tool calls, handoffs, guardrails, and custom events, while a durable workflow or sandbox may emit separate spans. Propagate one trace context across those boundaries, preserve the framework's version, and add the external receipt or candidate identity needed for verification. A pretty span tree with no artifact version still cannot prove success.

> **Cardinality check.** A metric label should come from a bounded catalog. Put run IDs, full paths, prompts, error bodies, and customer identifiers in protected trace or log records only when retention policy permits them.

## Measure proof coverage and repair usefulness

Track required checks attempted, checks with valid target selection, pass and failure rates by oracle version, evidence age, candidate mismatches, judge-human disagreement, repair attempts, unchanged failure signatures, and accepted runs later rolled back. Split infrastructure unavailability from candidate failure so a broken test environment does not become a model regression.

Sample successful runs too. Confirm that commands selected the intended tests, receipts refer to the accepted digest, runtime probes used the stated environment, and exceptions carried valid authority. A verifier that catches only obvious failures can still accept unsupported success. Retain the smallest useful diagnostic output and a pointer to the protected full record rather than copying secrets or whole customer artifacts into ordinary traces.

> **Takeaway.** Bind every check to one candidate and environment, let failures narrow the next action, and stop when repair no longer produces new evidence.

## Summary

Verification decides whether a named candidate satisfies the original contract; successful execution is only one observation. A repair loop should use failed evidence to narrow the next change while keeping the same acceptance rule and a firm attempt limit.

- Identify the candidate and environment, then name the oracle for each check: parser, schema, assertion, policy rule, state query, rubric, or reviewer.
- Confirm that a test selected the intended cases, and inspect resulting state through an independent path after a write reports success.
- On failure, gather the smallest diagnostic evidence, change one plausible cause, and rerun the focused check before wider tests.
- Stop repair after a fixed budget or repeated failure signature, and preserve the candidate plus trace for review.
- Connect model, tool, policy, checkpoint, and verification spans to stable task and candidate identities without indexing prompts or customer data.
- Treat current OpenTelemetry GenAI conventions as versioned development schemas and keep content capture off unless an explicit data policy enables it.
- Track proof coverage, stale evidence, candidate mismatches, grader disagreement, and later rollbacks as separate signals.

## References

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
- [OpenTelemetry: GenAI observability and content capture](https://opentelemetry.io/blog/2026/genai-observability/)
- [OpenAI Agents SDK: Tracing](https://openai.github.io/openai-agents-python/tracing/)
- [pytest: Exit codes](https://docs.pytest.org/en/stable/reference/exit-codes.html): Exit code 5 distinguishes a run that collected no tests.
- [Minimal harness](examples/minimal-harness.mjs): Offline streamed-model and loop-budget fixtures.

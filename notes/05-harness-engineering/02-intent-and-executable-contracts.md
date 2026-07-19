---
title: Intent and executable contracts
shortTitle: Executable intent
description: Translate a human request into testable outcomes, typed actions, evidence requirements, and stop conditions before the run spends authority.
collection: harness-engineering
slug: intent-and-executable-contracts
order: 2
number: HE2
duration: 105 min
difficulty: Core
tags:
  - intent
  - contracts
  - schemas
  - acceptance criteria
---

## Working model

A useful task contract is a small test oracle written before the work starts. It states what may change, what must stay true, which evidence counts, and when the runner must stop or ask.

## Questions this note answers

- Rewrite an ambiguous goal as observable acceptance criteria
- Specify preconditions, postconditions, invariants, and non-goals
- Design a typed tool contract with explicit error and side-effect semantics
- Define success, escalation, and stop rules that code can check

## Make success observable before giving the agent tools

Requests such as "make onboarding better" hide several decisions: who the user is, which artifact may change, what quality means, and which constraints cannot move. The harness should turn that request into a goal, scoped inputs, non-goals, acceptance checks, required evidence, and an escalation rule.

Acceptance criteria should be observable by a reviewer or program. "The page is fast" is weak; "the measured route stays under the agreed latency threshold in the named test setup" gives the run a check. Keep the threshold and setup in task data so they can be reviewed and versioned rather than buried in a system prompt.

> **Contract test.** If two reviewers could accept different artifacts while honestly following the criterion, the criterion still contains a hidden choice.

## Separate the goal from the rules that guard it

The goal names the desired state. Preconditions describe facts that must hold before work begins, such as a clean candidate branch or a known failing test. Postconditions describe facts that must hold afterward. Invariants must remain true through every intermediate step, while non-goals state which tempting work is outside scope. Evidence rules name the observations that prove each condition.

Ownership matters when the request leaves a choice unresolved. The user owns product intent and authority expansion; repository policy owns local change and proof rules; the tool executor owns argument validation and side-effect enforcement; the verifier owns the final comparison with the contract. The model can identify ambiguity and propose a choice, but it cannot silently assign itself the right to resolve a product or policy decision.

- Goal: one observable end state
- Preconditions: required starting facts and their evidence
- Postconditions: results that must exist when the run finishes
- Invariants and non-goals: boundaries that work must not cross
- Escalation: the missing decision, its owner, and a safe paused state

## A tool schema is necessary, but its operational contract is larger

JSON Schema can reject a missing field or an invalid enum before execution. It cannot explain whether a call is read-only, which identity performs it, how long it may run, whether a retry is safe, or what partial success looks like. Put those facts in tool metadata and enforcement code.

Useful contracts state preconditions, result shape, error classes, timeout behavior, side effects, idempotency, and approval needs. Validate returned data too. A tool that claims success with an empty artifact or changes a resource after returning an error can mislead every later step even when its input schema is perfect.

_Operational metadata gives the runner facts that a parameter schema alone cannot express._

```yaml
name: update_record
input_schema: RecordUpdateV1
side_effect: write
idempotency_key: required
approval: before_execute
timeout: 15s
postcondition: returned_version > prior_version
```

### Code walk: follow tool metadata into approval enforcement

Suppose a host registers the `update_record` contract above. When the model proposes that tool, the host validates its arguments and builds an approval record before execution:

```json
{
  "callId": "call-17",
  "tool": "update_record",
  "argumentsDigest": "sha256:reviewed-input",
  "preview": "Set record 42 from version 8 to version 9",
  "expiresAt": "2026-07-18T18:00:00Z"
}
```

The host stores that record and returns `awaiting_approval`; it hasn't run the tool. On resume, the decision must name `call-17`, match the arguments digest, and arrive before expiry. A missing, denied, stale, or mismatched decision becomes a rejected tool result. Test those four cases plus the accepted path, and assert that only the accepted path calls the executor.

## Compile a flaky-test request into executable checks

A request says, 'Fix the flaky retry test without changing product behavior.' The harness narrows the write set to the retry package and its tests. The known precondition is a recorded intermittent failure under a named command and environment. The invariant is that production retry count, delays, and surfaced errors keep their existing meaning. The postcondition requires the focused test to pass repeatedly and the relevant regression suite to pass once against the same artifact digest.

The edit tool accepts a normalized repository path, expected prior digest, patch text, and task operation ID. It rejects paths outside the package, a stale digest, malformed patches, and an operation ID reused with different content. Its receipt returns the changed paths and new digest. The test tool returns command, working directory, environment identifier, collected-test count, status, and bounded output. A missing intended test fails the evidence check even when the process exits zero.

_The contract names proof and unresolved ownership before any edit starts._

```yaml
goal: remove the observed flake
write_scope: [retry-package, retry-tests]
invariant: public retry behavior unchanged
acceptance:
  - focused test passes in repeated trials
  - regression suite passes once
  - final diff stays inside write_scope
escalate: intended retry behavior is ambiguous
```

## Success and stopping are separate decisions

A run may stop because the contract passed, because a hard budget expired, because progress stalled, or because a required choice belongs to a human. Only the first condition is success. Store the termination reason separately from the result status so an interrupted run cannot appear complete.

Executable checks should guard invariants before and after risky actions. For a code task, a clean diff boundary can be a precondition, tests and type checks can be postconditions, and "no unrelated file changed" can remain an invariant. The model can propose commands; deterministic code decides whether the evidence satisfies the contract.

> **Host rule.** Put typed tools behind policy checks and keep retries, transcript repair, approval, and completion in ordinary code. A model's prose response can't satisfy those contracts.

## Log contract failures as data, not prose

Store a versioned contract ID with each run and record every check as pending, passed, failed, skipped with authorization, or unavailable. A terminal result should name the exact reason: accepted, rejected, paused for a named decision, budget exhausted, cancelled, or environment unavailable. That structure lets an operator distinguish incomplete work from work that failed its acceptance rule.

Review patterns over time. Frequent escalation on the same hidden choice means the task template needs another field. Repeated stale-digest rejection suggests concurrent ownership or an outdated handoff. A growing count of skipped checks may indicate that environments or permissions drifted from the contract. Change the contract only through a versioned decision, then retain the prior result under the rules that governed it.

> **Takeaway.** Do not start a side effect until scope, authority, evidence, and terminal reasons can be represented in data the runner understands.

## Summary

A task contract turns a request into a decision procedure before the run receives tools. It defines the permitted change, the proof required for acceptance, and the conditions that require a stop or an explicit human choice.

- Record the goal, scoped inputs, non-goals, preconditions, postconditions, invariants, and escalation rule.
- Make every acceptance check observable against a named artifact, environment, or external resource version.
- Treat a tool schema as argument validation only; identity, side effects, retry rules, deadlines, and partial success need separate policy.
- Preserve the original acceptance rule when a check fails. Repair the candidate or report the failure instead of weakening the check.
- Store check states explicitly: pending, passed, failed, unavailable, or skipped with recorded authorization.
- Keep termination reason separate from result status so cancellation, budget exhaustion, and success cannot be confused.

## References

- [RFC 2119: Key words for requirement levels](https://www.rfc-editor.org/rfc/rfc2119.html)
- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [MCP 2025-11-25: Tools and schemas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Minimal harness](examples/minimal-harness.mjs): Inspect schema validation, tenant policy, receipts, and deterministic acceptance in one offline example.

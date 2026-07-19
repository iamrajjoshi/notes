---
title: Evaluation engineering
description: Build representative task suites, layered graders, and trace-based diagnostics that can detect regressions without rewarding shortcuts.
slug: evaluation-engineering
order: 9
identifier: HE9
duration: 150 min
difficulty: Advanced
tags:
  - evals
  - rubrics
  - graders
  - task suites
  - traces
---

## Working model

An eval is a measurement system. The task set samples behavior, the environment produces observations, graders convert evidence into scores, and traces explain why the score moved.

## Sample the work you intend to trust

Start with a behavior inventory: common tasks, expensive failures, edge conditions, and adversarial inputs. Turn real incidents into sanitized cases, add small synthetic cases for specific invariants, and keep a holdout set away from prompt and harness tuning. Record why each case exists and which capability it measures.

An agent task includes an environment, available tools, initial state, permissions, time or cost budget, and a success contract. Pin mutable dependencies where possible. Seed known nondeterminism, repeat enough runs to see variance, and mark infrastructure failures separately from task failures.

> **Coverage breadth.** A hundred similar happy paths are one behavior family, not a broad suite. Count distinct decisions and failure modes before counting cases.

## Use several narrow oracles instead of one vague score

Deterministic graders should check exact facts such as tests, schema validity, resource state, file scope, secret leakage, and budget limits. A rubric-based model judge can assess qualities such as diagnosis quality or handoff completeness when an exact oracle is unavailable. Human review remains useful for policy choices, calibration, and disputed cases.

Write rubric levels with observable anchors. Blind a judge to candidate identity and unrelated metadata, randomize presentation when order can bias it, and test the grader on examples with known labels. Measure judge agreement and inspect disagreements; a stable agent score from an unstable grader is false comfort.

_Hard invariants gate the result; a calibrated rubric scores the quality that remains._

```yaml
graders:
  - name: required-tests
    type: deterministic
    weight: gate
  - name: scope-control
    type: deterministic
    weight: gate
  - name: diagnosis-quality
    type: rubric-judge
    scale: [0, 1, 2]
review: human-on-disagreement
```

## Trace one candidate through gates and a scored rubric

Suppose an eval case asks a coding agent to repair one parser defect without writing outside its package. The environment starts from pinned revision case-17, exposes read tools and a scoped edit tool, and sets the same call and time budgets for baseline and candidate. Each system runs several independent trials because model sampling and timing can change the path even when the case stays fixed.

A deterministic grader checks the required test, write scope, final artifact digest, secret scanner, and budget. Any failure rejects that trial. For trials that pass, a rubric judge scores whether the diagnosis cites the failing behavior and distinguishes cause from symptom. Human-reviewed anchor cases define the score levels. The report keeps every trial, grader version, trace, and intervention; it does not replace failed trials with a best run or average a policy breach into a quality score.

_The measurement record keeps task, environment, candidate, grader, and trial identity separate._

```text
case-17 + environment-v4 + fixed authority
baseline trials and candidate trials
hard gates: behavior, write scope, secrets, budget
rubric: diagnosis quality against reviewed anchors
report: distribution + trace-linked failures + review queue
```

## Read repeated trials as a distribution

One pass does not establish a stable property. Let `p` be the probability that one independent trial of one pinned case passes all required gates. Three related metrics answer different product questions:

| Metric   | Question                                   | If the single-trial rate is `p` |
| -------- | ------------------------------------------ | ------------------------------- |
| `pass@1` | Does one ordinary attempt succeed?         | `p`                             |
| `pass@k` | Does at least one of `k` attempts succeed? | `1 - (1 - p)^k`                 |
| `pass^k` | Do all `k` attempts succeed?               | `p^k`                           |

If `p = 0.75`, then `pass@3 = 1 - 0.25^3 = 98.44%`, while `pass^3 = 0.75^3 = 42.19%`. The first metric rewards search with several chances; the second measures repeatability. A coding assistant that can generate four candidates and run tests may care about `pass@4`. An unattended refund agent usually cares about `pass@1`, hard safety gates, and a reliability measure such as `pass^5`.

The formulas assume attempts have the same success probability and fail independently. Shared caches, reused worktrees, rate limits, provider incidents, or a common bad fixture create correlation, so do not manufacture `pass@10` from one observed `pass@1` number. Run the repeated trials in isolated environments and retain their actual outcomes.

For a finite sample, suppose `n = 10` trials contain `c = 7` passes. `pass@1` is `7/10 = 70%`. The unbiased estimator introduced with HumanEval is `1 - C(n-c, k) / C(n, k)`, where `C(a, b)` counts ways to choose `b` items from `a`. For `k = 3`, this gives `1 - C(3,3)/C(10,3) = 119/120 = 99.17%`. The matching all-success estimator is `C(c,k)/C(n,k) = C(7,3)/C(10,3) = 35/120 = 29.17%`. Ten trials are still a small sample; the calculation does not remove uncertainty.

Keep the full trial distribution. For each case, report passes out of attempts, gate failures, latency, tokens, tool calls, cost, and intervention. Across a suite, average case-level rates so a case with extra retries does not receive more weight by accident. Show latency and cost for every attempted task as well as for accepted tasks; conditioning only on success can make a system that times out often look fast.

## Pair baseline and candidate trials before estimating a change

Run the baseline and candidate on the same case version, environment image, authority, budget, resource floor and ceiling, and trial schedule. Give each pair a stable trial ID. Matching a random seed helps when the stack honors it, but it does not guarantee identical sampling or timing; the trace must still record what happened.

For binary success, define one difference per pair: candidate result minus baseline result. A value of `1` means only the candidate passed, `-1` means only the baseline passed, and `0` means they agreed. The mean of those differences is the paired change in pass rate. Pairing removes case difficulty from the comparison: both systems face the same hard and easy cases rather than two unrelated samples.

Suppose eight valid pairs produce differences `[0, 0, 1, 0, 0, 1, 0, 0]`. The candidate gains two passes and loses none, so the observed change is `2/8 = 25` percentage points. Eight pairs cannot support a precise release claim. A small paired bootstrap makes that limitation visible:

1. Sample eight of the observed pair differences with replacement.
2. Compute their mean and save it.
3. Repeat with a fixed random seed, for example 10,000 times.
4. Use the 2.5th and 97.5th percentiles as a 95% percentile interval.

For these eight differences, the possible bootstrap means are coarse; the percentile interval runs from 0 to 62.5 percentage points. It includes no improvement, so the right conclusion is "promising but underpowered," not "+25 points." With repeated trials nested inside many cases, resample whole cases and keep their paired trials together. That cluster bootstrap preserves the fact that trials of one case share a specification and environment.

Predeclare the comparison metric, resampling unit, interval method, and release threshold. Do not run several analyses and publish only the most favorable one. A confidence interval describes sampling uncertainty under the design; it does not absorb grader bugs, contaminated cases, or unmatched infrastructure.

## Decide infrastructure exclusions before reading outcomes

First choose what the eval measures. An end-to-end production reliability eval should count provider outages, tool latency, and sandbox failures that users would experience. A narrower model or harness capability eval may exclude a verified infrastructure fault, but only under a rule written before candidate labels and outcomes are inspected.

An exclusion is eligible when an independent runner signal identifies the fault, the failure is outside candidate control, and the trial never reached a point where candidate behavior could have caused the outcome. Examples include a container image that cannot start, an unavailable model endpoint before the first response, or a fixture checksum mismatch. These are not eligible exclusions:

- The agent exhausts its own call budget, chooses an invalid tool, or causes an out-of-memory condition with unbounded output.
- A candidate makes twice as many calls and hits the shared deadline more often; that is an efficiency or reliability difference.
- The external write may have committed before a connection failure. Grade it through reconciliation, not by deleting the trial.
- The grader crashes only on the candidate artifact. Treat that as a grader defect and block the comparison until it is fixed.

If one member of a baseline-candidate pair has an eligible setup failure, invalidate the pair and rerun both sides under the same configuration. Never rerun only the failed candidate until it passes. Set a retry cap; after that cap, retain an `invalid_infrastructure` outcome outside the pass-rate denominator and report its count, cause, candidate split, time, resource configuration, and raw rate. A large or asymmetric exclusion rate invalidates the comparison even if the remaining interval looks narrow.

Resource settings belong in the experiment record. Container reservation, hard limit, CPU model, concurrency, egress, timeout, and time of day can move an agentic coding score. Anthropic's infrastructure-noise study shows why a small leaderboard gap should not outrank a mismatched execution environment.

## Separate capability suites from regression suites

A capability suite asks what the system can sometimes do near its current boundary. It should contain difficult but valid cases, and a low initial pass rate can be useful because it leaves room to measure progress. `pass@k` helps when several proposals or repairs are allowed, while traces reveal newly successful strategies. Do not use a frontier suite as a per-commit gate that fails most days.

A regression suite protects behavior the product already claims to support. Cases should have clear contracts, stable fixtures, fast graders, and high baseline reliability. Use `pass@1` and repeated all-success checks to catch flakiness; hard safety cases may require every run to pass. When an incident is fixed, add its smallest stable reproduction here, while leaving the broader difficult task in the capability suite if it still measures useful headroom.

Keep separate dashboards and release rules. A saturated capability suite stops distinguishing better systems, but the same near-100% behavior can make an excellent regression gate. A regression case that sits at 40% pass rate creates alert fatigue and should return to capability research until the task, grader, environment, or system becomes dependable.

## Prove each task and grader can succeed

A reference solution is a known artifact or action sequence that satisfies the written task under the same tools, authority, environment, and budget. Run it through every grader and save the resulting receipts. This proves that the case is solvable and that the positive path through the grader works; it does not prove that every valid solution will be accepted.

Add known-bad near misses as negative controls: a correct answer in the wrong file, a skipped required check, an out-of-scope write, or a plausible final sentence without the external effect. The grader should reject each for the stated reason. Avoid exact-diff grading when several implementations can meet the contract. If domain experts cannot produce a reference solution or agree on whether it passes, repair the task before using its score to judge an agent.

Keep reference solutions away from candidate context and protected holdouts. Their purpose is evaluator maintenance, not few-shot prompting. Version them with the task and rerun them whenever the environment or grader changes.

## A score without a trace cannot tell you what to fix

Store the task version, environment version, model and settings, instruction bundle, tool schemas, sanitized calls and results, artifact digests, grader versions, and termination reason. When performance moves, compare the first divergent decision and the evidence each candidate had at that point.

A failure may belong to the agent, harness, tool implementation, environment fixture, or grader. Replay deterministic components when possible and retain enough evidence to reproduce state. Redact secrets and personal data before persistence; an eval store is not exempt from the system's data policy.

> **Toy eval trace.** Record retries, transcript repairs, policy denials, step-budget stops, and usage beside the terminal result. Those events show whether a failure came from the model's proposal, host repair, blocked execution, or forced stop.

### Bundled eval trace: read a scenario test as an eval case

`runEvalSuite` in [minimal-harness.mjs](examples/minimal-harness.mjs) runs scripted models against five visible contracts: accepted work, tenant isolation, uncertain-write reconciliation, argument validation, and the host step limit. No case calls a live model.

The uncertain-write case contains four parts: initial task and store, injected model behavior, expected receipt boundary, and terminal assertion. `tests/public-harness.test.mjs` adds nearby negative controls for cross-tenant authority, malformed arguments, and looping behavior. Because every model response and tool result is scripted, repeated runs should produce matching traces.

A shallow grader that accepts the model's final sentence without checking committed state would make the reference run look successful while missing the known-bad case. The state-based assertion is therefore part of the evaluator's contract, not incidental test code.

## Evaluate attacks against the whole deployed path

A prompt-injection eval is not one string sent to the base model. Put adversarial instructions in the places the deployed agent actually reads: web pages, issue comments, retrieved files, tool results, resource metadata, remembered notes, and worker handoffs. Give the case the same tools, identities, network policy, approval rules, and output handling used in production. This tests whether the system blocks an unsafe effect even when the model follows the injected text.

Pair attack cases with nearby benign tasks. An agent that refuses every document or external page has low attack success because it no longer performs the job. Report benign task success, policy violations, attempted unsafe calls, blocked calls, committed effects, and data exposure separately. For a high-impact capability, one successful committed effect should remain visible as a gate failure instead of disappearing inside an average score.

Static attack sets become tuning targets. Keep a protected set, vary the injection location and encoding, and run adaptive attempts that use prior observations when the threat model permits them. NIST's public agent-hijacking work and 2026 red-team reporting both show why a clean single pass is weak evidence. Store the first unsafe transition and the policy evidence visible at that moment so the fix can land in the model, context boundary, tool contract, executor, or grader that actually failed.

> **Security-eval rule.** Grade both the proposed action and the external effect. A blocked exfiltration attempt is a model failure and a policy success; an unrecorded committed write is a system failure.

## Make grader shortcuts and contamination observable

Grader hacking means the candidate receives a passing score without satisfying the intended contract. It does not require malicious intent. A coding agent may delete a failing test, write the answer into a cache the grader trusts, inspect hidden fixtures through permissive filesystem access, or print the string a shallow output grader expects. Grade authoritative state, keep grader code and secrets outside the candidate's write set, verify test and fixture digests, and include negative controls that exercise likely shortcuts.

Model judges need the same boundary. Candidate text, retrieved documents, and tool output are untrusted data that may contain instructions for the judge. Pass them in a quoted field under a fixed rubric, give the judge no production tools, require a small output schema, and route malformed or suspicious grades to review. A judge that can execute a candidate's request is another agent, not a grader.

Contamination occurs when release cases or their answers enter model training, prompt tuning, retrieval, demonstrations, or developer iteration. It can also happen inside the eval runner: Anthropic reports trials gaining information from git history left by prior trials. Separate public development cases from protected release cases, start every trial from a clean snapshot, log holdout access, and never place case IDs or reference artifacts in candidate-visible paths.

No control can prove that a third-party model never saw a public benchmark. Treat public scores as one signal, add fresh private cases modeled on current work, and inspect suspiciously exact outputs. When a holdout leaks, mark its history, remove it from release decisions, and replace it; silently retaining it converts memorization into apparent capability.

## Aggregate by risk, then inspect the tails

Track task success, hard-gate failures, invalid actions, tool errors, human interventions, latency, tokens, and cost per accepted task. Report distributions and slices by task family rather than one average. A candidate can improve common cases while regressing the rare high-impact case that matters most.

Set release rules before comparing candidates. Require no regression on safety gates, a stated confidence rule for quality changes, and manual review for material tradeoffs. Keep failed cases in the suite after the fix so the measurement system remembers why the guard exists.

## Monitor the evaluator as a production dependency

Track invalid cases, environment setup failures, grader errors, judge-human agreement, score drift on anchor cases, repeated-trial variance, task-family coverage, holdout access, and time from incident to regression case. Version every grader and rerun a fixed calibration set before changing release thresholds. If an exact gate and a judge disagree, inspect the gate, artifact, and rubric rather than choosing the more favorable result.

Protect the suite from contamination. Limit who can view holdout cases, log access, and keep tuning examples separate from release cases. Refresh mutable fixtures without changing the behavior contract silently. When a case no longer represents supported work, retire it with a reason and preserve its history. Eval data often contains repository content, traces, or user artifacts, so apply the same retention and access rules used by the source system.

> **Takeaway.** Treat task cases, environments, graders, and reports as versioned measurement code; a score is useful only when each layer can be audited.

## Summary

An evaluation is only useful when its cases resemble trusted work, its environment is pinned, and each score can be traced back to evidence. Hard correctness and safety gates should remain separate from softer quality judgments.

- Use `pass@1` for one-attempt success, `pass@k` when any of several attempts may succeed, and `pass^k` when every repeated attempt must succeed.
- Compare matched baseline-candidate trials and report an uncertainty interval; a point estimate alone cannot separate a change from sampling noise.
- Exclude infrastructure failures only under a prewritten rule, rerun both sides of an invalid pair, and publish exclusion counts and resource settings.
- Keep difficult capability suites separate from high-pass-rate regression suites, with different dashboards and release rules.
- Prove each task and grader with a protected reference solution plus known-bad negative controls.
- Apply deterministic outcome and safety gates before rubric scores; isolate judges from candidate instructions and calibrate them against reviewed anchors.
- Track attack utility, grader shortcuts, contamination, invalid cases, setup failures, drift, repeated-trial variance, and holdout access.

## References

- [Anthropic: Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- [Anthropic: Quantifying infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise)
- [Evaluating Large Language Models Trained on Code](https://arxiv.org/abs/2107.03374): Introduces HumanEval and an unbiased finite-sample estimator for pass@k.
- [Efron: Bootstrap Methods—Another Look at the Jackknife](https://doi.org/10.1214/aos/1176344552)
- [Inspect AI documentation](https://inspect.aisi.org.uk/)
- [SWE-bench: Can Language Models Resolve Real-World GitHub Issues?](https://arxiv.org/abs/2310.06770)
- [NIST CAISI: Strengthening AI agent hijacking evaluations](https://www.nist.gov/news-events/news/2025/01/technical-blog-strengthening-ai-agent-hijacking-evaluations)
- [NIST CAISI: Large-scale agent red-teaming findings](https://www.nist.gov/blogs/caisi-research-blog/insights-ai-agent-security-large-scale-red-teaming-competition)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [Minimal harness](examples/minimal-harness.mjs): Scripted eval cases for accepted work and four failure boundaries.

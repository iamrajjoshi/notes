---
title: Production safety and rollout
shortTitle: Safety and rollout
description: Ship a versioned model behind explicit privacy, tenant, evaluation, canary, observability, and rollback controls.
collection: ai-inference
slug: production-safety-and-capstone
order: 9
number: AI9
duration: 180 min
difficulty: Advanced
tags:
  - provenance
  - canary
  - privacy
  - Langfuse
---

## Working model

A model release is a distributed software release with a larger artifact and another quality dimension. Treat identity, provenance, capacity, behavior, and rollback as one versioned unit.

## Questions this note answers

- Verify model, tokenizer, adapter, container, and configuration provenance
- Set tenant, authentication, secret, prompt, and trace-data boundaries
- Design offline, shadow, canary, and online rollout gates
- Correlate application traces with engine and infrastructure metrics
- Write a fallback and rollback path that works under overload
- Include power and energy in capacity, telemetry, and release comparisons
- Calculate and defend a full inference-service answer for an infrastructure interview

## Pin every input that can change model behavior

Record immutable identities for model weights, tokenizer, prompt template, adapters, quantization configuration, runtime image, engine build, drivers, and serving configuration. Verify digests and provenance before a worker loads them.

Keep model artifacts in controlled storage, restrict who can publish aliases, and make rollback point to a known immutable bundle. A mutable latest tag turns incident response into archaeology.

> **Separate trust from compatibility.** A signed artifact can still be wrong for the model server, and a compatible artifact can still come from an untrusted publisher. Test both.

## A model can run code while it loads

PyTorch's traditional pickle-based checkpoint format can execute code during deserialization. Prefer tensor-only formats such as Safetensors where the engine supports them, reject unsafe formats by default, and perform any required conversion in a short-lived isolated job without production credentials or broad network access. A tensor-only file prevents that deserialization path; it does not prove that the weights are benign, licensed for the use, or compatible with the stated architecture.

Custom model implementations loaded with `trust_remote_code=True` are code execution too. Review the code, pin the repository commit rather than a branch, build it into the tested runtime artifact, and keep the serving worker's filesystem, cloud identity, and egress permissions narrow. Malware scanning helps triage an artifact repository but does not replace review and isolation.

## Prompt and trace collection needs an explicit policy

Authenticate callers, authorize model and tenant access, isolate caches and adapters, bound request size, and rate-limit by a stable identity. Keep secrets out of images and request logs; rotate credentials without rebuilding a model.

Prompts, retrieved documents, generated text, token IDs, embeddings, and tool arguments can all contain sensitive data. Define collection purpose, redaction, retention, regional handling, and access before enabling payload capture. Metadata-only tracing should remain possible.

Prefix caches and adapter pools need the same boundary. Namespace reusable state by every model-relevant input and the allowed sharing domain; if the threat model forbids cross-tenant reuse, partition or disable it. A timing or hit-rate signal can leak information even when a caller cannot read another request's KV tensors directly.

## Generated text and tool calls remain untrusted input

Prompt injection is an application control problem, not something a faster model server fixes. Treat model output as untrusted data, validate structured output against the required schema, and authorize every external action outside the model process. A JSON grammar can make output parseable; it cannot prove that a requested action is safe.

Tool-enabled applications should expose only the required operations, use the caller's identity and least privilege, cap iterations and spend, and require a separate approval step for high-impact changes. Keep tool credentials out of the inference worker. Input-token limits, output-token limits, concurrency quotas, deadlines, and cancellation also protect the shared serving pool from accidental or hostile resource exhaustion.

## Quality and systems gates belong in the same rollout

Run the [held-out task and safety gate](08-inference-performance-and-sre.md#construct-the-quality-gate-before-load-testing) before traffic. Shadow requests can compare behavior without returning the new output, but they duplicate compute and still process production data. A canary exposes a small, bounded cohort to the new bundle while watching quality proxies, errors, TTFT, decode cadence, queueing, cost, and saturation.

Promotion needs an observation window and explicit thresholds. Rollback must drain or cancel old work safely, restore routing, and preserve enough known-good capacity. If overload caused the failure, retrying every request against the fallback can sink that pool too; use admission limits.

## Work a promotion gate from start to decision

Suppose a private document assistant answers questions from supplied files, extracts fields into JSON, summarizes documents, and abstains when the evidence is absent. Its held-out representative set contains 800 cases based on observed product share: 400 grounded questions, 200 extractions, 120 summaries, and 80 abstentions. Report long-context, OCR-noise, Spanish, and missing-evidence slices separately instead of trusting the weighted average.

Add 400 targeted safety cases outside that production weighting: 100 each for instructions hidden inside documents, cross-tenant data requests, attempts to reproduce secrets, and unauthorized tool actions. These cases test release blockers; their rarity in ordinary traffic must not dilute them.

Run deterministic checks on every applicable output: parse JSON, validate its schema, enforce stop and length rules, verify that cited identifiers exist in the supplied source, and reject forbidden tenant identifiers. A stratified sample of 200 open responses receives blind human review, with 50 double-graded to expose rubric disagreement. A versioned model grader scores the larger set only after comparison with those human labels. It can flag cases for review, but it cannot overrule humans or deterministic failures.

Use a small rubric that graders can apply consistently:

| Dimension       | 0                                                          | 1                                                      | 2                                                       |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Grounding       | Contradicts evidence or makes a material unsupported claim | Mostly supported but omits or weakens a material fact  | Every material claim follows from the supplied evidence |
| Task completion | Does not perform the requested task                        | Partly completes it or violates a material instruction | Completes the requested task and required format        |

Safety is a separate pass or fail. An output is acceptable only when both rubric dimensions score 2 and no safety rule fails. Style preferences stay diagnostic unless the product contract makes one mandatory.

Before running the candidate, write the thresholds: at least 99.5 percent deterministic-check pass; no overall human-rated regression larger than 2 percentage points; no required slice regression larger than 5 points; zero critical safety failures; p95 TTFT at most 800 ms; p95 delivered token spacing at most 40 ms; goodput no lower than baseline; and energy per useful output token no more than 10 percent above baseline.

The representative set is not infinite evidence. Near a 95 percent pass rate, the smallest 80-case slice has an approximate 95 percent sampling interval of about plus or minus 4.8 points. Compare baseline and candidate on the same cases, report intervals for their paired difference, and gather more examples when an interval crosses a release bound. For 100 prompts that use stochastic sampling, run three fixed seeds and report the variation rather than selecting the best run. Near-duplicate prompts do not create independent evidence merely because the row count rises.

The hypothetical results are:

| Gate                              |       Baseline |                                                      Candidate | Result                                                              |
| --------------------------------- | -------------: | -------------------------------------------------------------: | ------------------------------------------------------------------- |
| Deterministic checks              |          99.6% |                                                          99.7% | Pass                                                                |
| Human acceptable rate             |          96.5% | 96.0%; paired difference 95% interval from -1.8 to +0.8 points | Pass: lower bound stays above the -2-point limit                    |
| Worst required slice              |          93.8% |                92.5%; difference interval from -4 to +2 points | Pass: lower bound stays above the -5-point limit                    |
| Model-grader acceptable rate      |          96.8% |                                                          98.7% | Diagnostic only; it conflicts with the human comparison             |
| Critical safety cases             |   400/400 pass |                                                   398/400 pass | **Fail: two hidden-instruction cases produce unauthorized actions** |
| p95 TTFT / token spacing          | 780 ms / 36 ms |                                                 720 ms / 33 ms | Pass                                                                |
| Goodput / energy per useful token |       Baseline |                                          14% higher / 7% lower | Pass                                                                |

Do not promote this candidate. The latency, goodput, and energy results are better, but the predeclared zero-critical-failure rule blocks release. Preserve the two failures, fix the behavior, create development variants without exposing the held-out answers, and rerun the full gate. The model grader's higher score is evidence that its calibration missed this failure mode, not evidence that the candidate is safe.

## Join model traces to the engine and the node

A request trace should carry a sanitized request identifier, tenant class, model bundle, route, queue phase, prefill and decode timing, output count, status, and rollout cohort. Engine metrics then explain batches and KV pressure; Kubernetes and device metrics explain placement, memory, clocks, power or thermal limiting, accumulated energy, and faults.

A tracing system such as Langfuse can hold application-level model spans and evaluation metadata. OpenTelemetry can connect service and infrastructure spans. Keep raw prompts disabled unless policy permits them, and never place private endpoint names, credentials, or customer identifiers in a teaching example.

> **Hypothetical example.** Suppose a model-serving team records application traces in Langfuse and infrastructure traces with OpenTelemetry. A generated trace ID joins a sanitized model version and its queue phases to node telemetry without storing raw prompts. Every tenant and payload in the exercise is synthetic.

## Work a complete infrastructure interview prompt

Suppose the interviewer asks for a regional streaming service for one hypothetical 70-billion-parameter model. Traffic averages 40 requests per second, with 1,200 input and 300 output tokens per request; the p95 prompt is 4,096 tokens. The client needs p95 TTFT below 800 ms and p95 delivered token spacing below 40 ms. Prompts are private, the service must tolerate one serving-group failure, and the chosen engine and accelerator fleet are open decisions.

Start by stating the API and workload boundary. Ask about chat templates, streaming events, maximum input and output, structured or tool output, adapters, context limits, regions, retention, quality gates, burst shape, the joint prompt-and-output distribution, the exact latency clocks, and any rack-power or energy-cost constraint. The mean demand is 48,000 input tokens and 12,000 output tokens per second, but those two rates must be compared with separate prefill and decode measurements.

### Freeze the illustrative assumptions before calculating

The rest of this worked case uses deliberately hypothetical inputs so the method is inspectable. They are not specifications or performance guarantees for a named model, engine, accelerator, or cloud instance. Assume this model has 80 transformer layers, 8 key/value heads per layer, head dimension 128, and a BF16 KV cache with 2 bytes per element. Its BF16 checkpoint contains exactly 140,000,000,000 bytes of weights. Assume each hypothetical accelerator has 80 GiB of physical memory, but only 70 GiB enters the serving allocation after a 10 GiB per-device fixed non-model reserve. The available server has a tested four-device high-bandwidth link domain, and this exact model build has been validated at tensor-parallel degree four. A three-device build might be possible for another model or topology; memory arithmetic alone does not establish its support or performance.

For throughput, assume replay of the exact bundle, engine, four-device group, request mix, and latency targets measured a simultaneous **SLO-compliant envelope** of 18,000 input tokens per second and 4,500 output tokens per second per group. These are invented replay results for the exercise. Do not substitute them for a benchmark of the real system, and do not combine independent prefill and decode peaks unless replay proves that the group can sustain both together.

```text
input demand = 40 requests/s x 1,200 tokens = 48,000 input tokens/s
output demand = 40 requests/s x 300 tokens = 12,000 output tokens/s
BF16 weights = 140,000,000,000 bytes / 2^30 = 130.385 GiB
```

### Fit the smallest supported serving group

Two devices expose 140 GiB to the serving process. The weights alone occupy 130.385 GiB, leaving only 9.615 GiB before KV cache, graph pools, activations, communication buffers, allocator behavior, or the required group workspace reserve. That is not a safe two-device placement. The validated four-device group exposes 280 GiB. Reserve another 30 GiB across the group for workspaces and fragmentation after loading the weights:

```text
two-device remainder = (2 x 70 GiB) - 130.385 GiB = 9.615 GiB

four-device logical KV budget
  = (4 x 70 GiB) - 130.385 GiB weights - 30 GiB reserve
  = 119.615 GiB
```

An aggregate fit is necessary but not sufficient. The build still has to prove that sharded weights, per-rank KV blocks, and workspaces fit on every device rather than averaging away one rank's peak. Keep each four-device group inside the validated high-bandwidth link domain; crossing a slower node boundary changes the collective budget and requires another measurement.

### Calculate request-state memory and concurrency

The [GQA KV formula](02-serving-lifecycle.md#work-the-gqa-number-before-choosing-concurrency) gives the logical, group-wide cache bytes per retained token:

```text
KV bytes/token
  = 2 for key and value
    x 80 layers
    x 8 KV heads
    x 128 elements/head
    x 2 bytes/element
  = 327,680 bytes/token
  = 320 KiB/token
```

Use 1,500 retained tokens as a conservative completed-size footprint for the average request: 1,200 input plus 300 output. The supplied p95 is only for the prompt, so 4,096 plus the stated average 300-token output is a planning scenario, not a statistically valid p95 total length. A real design needs the joint prompt/output distribution.

```text
average-size request
  = 1,500 tokens x 327,680 bytes/token
  = 491,520,000 bytes
  = 0.4578 GiB of logical KV

p95-prompt planning scenario
  = (4,096 + 300) tokens x 327,680 bytes/token
  = 1,440,481,280 bytes
  = 1.3416 GiB of logical KV

theoretical cached-token limit
  = floor(119.615 GiB x 2^30 / 327,680)
  = 391,953 tokens

theoretical average-size sequence limit
  = floor(119.615 GiB / 0.4578 GiB)
  = 261 sequences

theoretical p95-prompt-scenario limit
  = floor(119.615 GiB / 1.3416 GiB)
  = 89 sequences
```

These are logical planning limits, not scheduler settings. Block allocation, prefix sharing, per-rank sharding, fragmentation, temporary activations, and the changing length of a live decode all require engine measurement and operational headroom.

For an intentionally conservative residence-time estimate, charge 300 delivered tokens at the full 40 ms token-spacing target, add the 800 ms TTFT target, and round 12.8 seconds up to 13 seconds. Little's Law then estimates 520 concurrent requests at the fleet boundary:

```text
residence assumption = (300 x 0.040 s) + 0.800 s = 12.8 s, rounded to 13 s
mean concurrency = 40 requests/s x 13 s = 520 requests

with four healthy groups = 520 / 4 = 130 requests/group
after one group fails = 520 / 3 = 173.3, plan for 174 requests/group

average-shape KV at 130/group = 130 x 0.4578 GiB = 59.5 GiB/group
average-shape KV at 174/group = 174 x 0.4578 GiB = 79.7 GiB/group
```

The average-shape failure case fits the 119.615 GiB logical budget. A fleet of 174 requests at the p95-prompt scenario would require about 233.4 GiB, so request count cannot be the admission unit. Charge each request for its retained tokens and permitted output, then reject or delay it before that token reservation crosses the tested watermark.

### Choose group count from the measured envelope

Both prefill and decode independently require three groups under the hypothetical replay result:

```text
input groups  = ceil(48,000 / 18,000) = 3
output groups = ceil(12,000 / 4,500) = 3
steady throughput requirement = max(3, 3) = 3 groups
one failed-group spare = 3 + 1 = 4 groups
fleet size = 4 groups x 4 accelerators/group = 16 accelerators
```

With all four groups healthy, the envelope is 72,000 input and 18,000 output tokens per second. After one group fails, three groups still provide 54,000 input and 13,500 output tokens per second. Both leave 12.5 percent headroom over demand in the failed state:

```text
input headroom after failure = (54,000 - 48,000) / 48,000 = 12.5%
output headroom after failure = (13,500 - 12,000) / 12,000 = 12.5%
```

Twelve and a half percent is thin if arrivals burst, output length grows, cache hits fall, or one surviving group slows. Replay those conditions and add groups if the promised burst and SLO cannot fit; the arithmetic proves only this declared steady mix and one complete group loss.

### Make topology, admission, and rollout promises explicit

Draw the request path next: authenticated gateway, token-aware admission, model router, bounded queue, warm serving groups, streaming proxy, and cancellation propagation. Place immutable model bundles in controlled object storage with node-local caching. Run each tensor-parallel group inside one validated link domain, and spread the four data-parallel groups across zones with group and node anti-affinity. A 2/1/1 placement reduces correlated exposure, but this 4-group calculation guarantees only one serving-group failure. Losing the zone that holds two groups leaves two, below the 3-group throughput minimum. Full single-zone tolerance would need at least 5 groups placed 2/2/1, or another measured design; zone placement alone is not zone-failure capacity.

Tie the queue to the deadline rather than choosing an arbitrary request count. As another hypothetical replay result, suppose non-queue work from accepted request through first token consumes 600 ms of the 800 ms TTFT budget. Admission may wait at most 200 ms and must reject before enqueue when predicted service start is later than `client_deadline - 600 ms`. At the mean 40 requests per second, 200 ms corresponds to roughly 8 fleet arrivals, but that is not a safe fixed queue length because prompts have different token costs. Apply queue age, waiting input tokens, active-plus-reserved KV tokens, tenant quota, and cancellation state together. For example, an 80 percent operational KV watermark is `floor(391,953 x 0.80) = 313,562` retained-token equivalents per group; validate or lower it with allocator and failure replay rather than exposing the theoretical limit.

Four groups are the minimum steady fleet, not free rollout capacity. Add a fifth candidate group for a bounded canary while all four known-good groups remain available. If promotion must reach 100 percent while preserving immediate, warm rollback and one-group-failure tolerance, temporarily build four candidate groups alongside the four known-good groups: 8 groups, or 32 accelerators, during the full cutover. A cheaper rolling replacement can use less overlap, but then it must state the reduced rollback or failure promise instead of claiming the steady-state guarantee still holds. Admission must limit fallback traffic to the known-good envelope so retries cannot overwhelm it.

Finish with failure and release behavior. Explain what happens when a client disconnects, one rank hangs, the artifact store is slow, a long prompt blocks decode, a device lowers clocks under a power or thermal limit, a quantized build fails quality checks, or the fallback pool receives a retry wave. Name client, engine, device, energy, and collective telemetry; then describe offline evaluation, a bounded canary, rollback to an already warm bundle, and prompt-retention policy. [Framing the problem](../03-system-design/01-frame-the-problem.md) and the [interview studios](../03-system-design/11-interview-studios.md) cover the general interview flow.

An interviewer may supply different numbers. Keep the sequence: clarify the contract, calculate static and request-state memory, split prefill from decode demand, choose the smallest parallel group that fits, scale with replicas, bound overload, and prove failure recovery.

## Translate a percentage into traffic and fallback capacity

Assume the service receives 100 requests per second and sends 5 percent to a canary bundle. The canary sees about 5 requests per second on average, while the known-good pool keeps about 95. If shadowing also copies 10 percent of production requests to the new bundle, the new pool performs work for about 15 requests per second even though only 5 responses can reach users. Capacity and privacy review must count both paths.

Use a minimum sample count and an observation window, not only a percentage. At 5 requests per second, a 30-minute window offers about 9,000 canary requests before filtering by route and task class. Compare matched cohorts for task checks, error rate, TTFT, token spacing, queue age, and cost. Promotion can move through fixed steps such as 5, 20, 50, and 100 percent only when every gate passes. Before each step, prove the old pool can take traffic back without a cold start or an overload loop.

_Actual samples vary with arrival rate, routing eligibility, retries, and excluded requests._

```text
production arrivals = 100 requests/s
5% canary = 5 requests/s returned to users
10% shadow = 10 extra requests/s not returned
new-bundle work = 15 requests/s
30-minute canary sample ~= 5 x 1,800 = 9,000 requests
```

## Rollback is a sequence of observable actions

Write the trigger first: for example, a sustained error threshold, a phase-latency limit, a failed task check, artifact mismatch, or device-fault rate. The rollback controller stops promotion, routes new requests to the known-good bundle, limits admission to its measured capacity, and decides what happens to existing streams. Draining lets healthy streams finish; cancellation ends them sooner but changes client behavior. The correct choice belongs in the API contract.

During a drill, record detection time, decision time, route convergence, queue movement, old and new bundle capacity, retry volume, and time until SLO recovery. Verify that dashboards and traces still work when the canary process is dead, not only when it reports a clean error. Preserve the bundle digests, configuration, evaluation result, approval, rollout events, and rollback reason as one release record. After recovery, replay the failing cohort in an isolated test before attempting another canary.

- Artifact fault: quarantine the bundle and block its alias from further loads.
- Capacity fault: shed or reroute work without exhausting the fallback pool.
- Behavior fault: preserve sanitized examples and exact bundle identity for offline reproduction.
- Telemetry fault: halt promotion because missing evidence makes the gate unknowable.

## Use one final design review

A complete AI-infrastructure proposal should survive these questions:

1. What product behavior, model family, quality gate, request shape, traffic distribution, privacy rule, and latency boundary define success?
2. Can you trace one accepted request through prompt rendering, tokenization, queueing, prefill, decode, streaming, cancellation, and cleanup, naming the owner of each state?
3. Do weight, workspace, activation, graph, and KV-cache estimates fit the chosen dtype, hardware, concurrency, and failure headroom?
4. If the model crosses devices, which ranks exchange which bytes over which physical links, what state stays copied, and how does one slow or dead rank recover?
5. How does a declared Pod become a warm replica, and which topology, driver, artifact, image, startup, and autoscaling constraints can block that path?
6. Which replay proves quality, phase latency, goodput, overload behavior, and energy per useful request or token at the stated system boundary?
7. Can the team identify the exact bundle, protect prompts and loading paths, detect a bad release, stop promotion, and return traffic to warm known-good capacity without causing another overload?

If an answer relies on “the GPU is busy,” a vendor throughput chart, or a product name without the request and failure mechanics, the design is incomplete.

## Summary

Production safety treats a model release as a versioned software-and-data bundle with quality, privacy, capacity, and rollback obligations. A rollout is safe only when every input is identifiable, traces avoid sensitive payloads, canary traffic is bounded, and the known-good path has enough capacity to take traffic back.

- **Pin all behavior-changing inputs.** Record immutable identities for weights, architecture, tokenizer, prompt template, adapters, quantization, runtime image, engine, drivers, and serving configuration. Verify provenance and compatibility as separate checks.
- **Set an explicit prompt and trace policy.** Authenticate and authorize by tenant and model, isolate caches and adapters, bound request size, rotate secrets outside images, and log sanitized identifiers and metadata rather than raw sensitive prompts.
- **Treat model loading as a code boundary.** Prefer tensor-only checkpoints, isolate format conversion, and review and pin any custom model code. A digest proves identity, not safety or compatibility.
- **Keep generated actions outside the model's authority.** Validate schemas, authorize tools with the caller's identity, minimize permissions, cap iterations and spend, and require approval for high-impact changes. Structured output is parseable, not trusted.
- **Gate quality, systems behavior, and energy together.** Representative tasks, targeted safety slices, deterministic checks, blind rubric review, and uncertainty bounds precede traffic. The worked candidate is faster and uses less energy, but two critical safety failures correctly block promotion.
- **Turn interview assumptions into one auditable capacity decision.** The illustrative 70B case chooses a four-device group only after weights, reserve, and KV arithmetic; replay then requires three groups for both input and output demand plus one failed-group spare, or 4 groups and 16 accelerators. The figures are hypothetical inputs, not vendor guarantees.
- **Count every path in rollout capacity.** At 100 requests/s, a 5% canary handles 5 requests/s. Adding 10% shadow traffic makes the new pool execute about 15 requests/s even though only 5 responses can reach users; privacy and capacity reviews must include both.
- **Write rollback as observable actions.** Predefine triggers and authority, stop promotion, route new work to the known-good bundle, enforce its measured admission limit, and choose whether existing streams drain or cancel. Verify recovery with user-boundary metrics rather than deployment state alone.

## References

- [NIST: AI Risk Management Framework](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.100-1.pdf)
- [NIST: Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
- [SLSA specification](https://slsa.dev/spec/v1.2/)
- [Kubernetes: good practices for Secrets](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)
- [Argo Rollouts documentation](https://argo-rollouts.readthedocs.io/)
- [OpenTelemetry: traces](https://opentelemetry.io/docs/concepts/signals/traces/)
- [Langfuse documentation](https://langfuse.com/docs)
- [Hugging Face Transformers: security policy for model artifacts and remote code](https://github.com/huggingface/transformers/security/policy)
- [OWASP GenAI: excessive agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/)

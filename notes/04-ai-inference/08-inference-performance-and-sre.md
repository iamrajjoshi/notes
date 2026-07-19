---
title: Inference performance and SRE
description: Define request-phase SLOs, replay a real workload, and turn latency, useful throughput, power, and energy measurements into capacity decisions.
slug: inference-performance-and-sre
order: 8
identifier: AI8
duration: 170 min
difficulty: Core
tags:
  - TTFT
  - TBT
  - goodput
  - admission control
---

## Working model

A good inference service returns acceptable output inside a stated latency target while demand, failures, and cost vary. GPU utilization alone cannot answer that question. Measure output quality, request phases, useful throughput, overload behavior, device health, energy, and total service cost under a defined workload.

## Define what “good” means before measuring it

Performance terms answer different questions:

| Term                        | Question it answers                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness or quality gate | Does this exact model bundle still produce acceptable results for the tasks the product needs?                                                                                                                |
| Latency                     | How long does one request or phase take? Report a distribution rather than only an average.                                                                                                                   |
| Throughput                  | How much work finishes per unit time, such as requests or output tokens per second?                                                                                                                           |
| Goodput                     | How much work finishes while meeting the stated quality and latency rules?                                                                                                                                    |
| Utilization                 | During what fraction of sampled time did a resource report activity? It does not say whether the work was useful.                                                                                             |
| Saturation                  | Has a constrained resource or queue reached the point where added demand increases waiting, rejection, or missed deadlines?                                                                                   |
| Availability                | Can an eligible request reach enough healthy serving capacity to receive the promised response? Define which planned rejections and client faults count.                                                      |
| SLI and SLO                 | A service-level indicator (SLI) is a measurement. A service-level objective (SLO) sets its target and evaluation window, such as 99% of eligible requests receiving a first token within 800 ms over 28 days. |

Site reliability engineering (SRE) connects those product targets to measurement, capacity, change management, and failure response. State workload and eligibility beside the SLO. Model bundle, prompt and output distributions, arrival process, streaming mode, cache state, adapters, and hardware all change the result. A service can meet a latency target by returning bad output or rejecting most traffic, so quality, success, rejection, and offered demand remain visible together.

## Construct the quality gate before load testing

A general benchmark score does not define whether a product works. List the tasks the service actually performs, estimate their production shares, and preserve important slices within each task: short and long inputs, noisy documents, languages, customer cohorts, or other conditions that change behavior. Add targeted safety and abuse cases separately. Those cases may be rare in ordinary traffic, but averaging them at production frequency can hide a serious failure.

Keep a held-out gate set that engineers do not tune against. Run the baseline and candidate on the same inputs and decoding settings. Use the least subjective check that matches each requirement:

| Requirement                                                  | Suitable evidence                                                                                                  |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| JSON shape, required fields, allowed values, stop rules      | Deterministic parser and assertions                                                                                |
| A cited identifier or quotation exists in supplied context   | Deterministic source lookup, followed by a semantic check when mere string presence is insufficient                |
| Summary preserves the material facts and follows the request | A written rubric applied by blinded human graders on a stratified sample                                           |
| A broad first-pass review of many open responses             | A versioned model grader calibrated against human-labeled cases, with disagreements and known bias slices reported |

Write the rubric before seeing candidate results. Define what earns each score, what counts as a material error, and which safety failures block release regardless of the average. Have more than one person grade a subset, hide model identity and output order where possible, and resolve or report disagreement. A model grader can reduce review cost after calibration; it is not ground truth. Published LLM-judge work documents position, verbosity, and self-enhancement biases, so pin the judge model and prompt and keep human checks in the gate.

Counts need uncertainty. For a binary pass rate `p` over `n` independent cases, the standard error is approximately `sqrt(p x (1 - p) / n)`. At 95 passes out of 100, an approximate 95 percent interval is `95% +/- 4.3 percentage points`; a one-point difference between candidates is not established by that sample. Use an appropriate interval or paired resampling for the real decision, show each slice's sample count, and repeat a fixed subset when stochastic decoding adds run-to-run variance.

Set thresholds before the run: a minimum overall result, maximum regression for every required slice, and zero tolerance for named critical failures where the product requires it. The [production rollout note](09-production-safety-and-capstone.md#work-a-promotion-gate-from-start-to-decision) applies this method to one candidate and then joins the result to latency, goodput, and energy.

## Define each latency clock before drawing a chart

Time to first token (TTFT) measures request arrival to first delivered token, unless a team explicitly chooses a narrower server boundary. Time between tokens (TBT), also called inter-token latency, describes streaming cadence. Time per output token (TPOT) definitions vary: some divide decode duration by generated tokens, while others exclude the first token. State the formula and denominator.

End-to-end latency ends at the final response event. Report percentiles by prompt size, output size, model, priority, and streaming mode. A single p50 across mixed workloads cannot explain user experience.

> **Goodput, not busy work.** Count requests or tokens that meet the service contract. Work completed after a client deadline can raise throughput while making the product worse.

## Closed-loop tests can hide a collapsing queue

A closed-loop client waits for one response before sending its next request, so the offered rate falls automatically as the server slows. Open-loop generation maintains a planned arrival process and exposes queue growth, rejections, and missed deadlines. Use both for different questions, but do not call closed-loop concurrency a traffic forecast.

Replay prompt and output-length distributions, cancellations, adapters, cache-hit rates, and streaming consumers. Warm the service deliberately, then include a separate cold-path test. Observe queue depth, batch composition, KV use, prefill and decode time, errors, GPU memory, device activity, CPU, network, and storage.

Keep correlations from real traffic. Shared prefixes often arrive with a particular tenant or route; long prompts may request longer outputs; one adapter may dominate at a specific hour. Sampling each dimension independently creates a workload that never existed. Include multimodal preprocessing, constrained output, speculative mode, and reasoning-heavy output classes only when the product uses them, then report each class separately.

## Observe four layers without putting request IDs in metrics

At the client and proxy boundary, record arrival, first byte or token, every stream event, final event, disconnect, timeout, and response class. Inside admission and the engine, record queue age, waiting and running sequences, scheduled prefill and decode tokens, batch shape, KV occupancy, cache reuse, preemption, cancellation release time, and speculative acceptance when enabled.

Device telemetry answers a different question. HBM use, compute and memory activity, power, clocks, temperature, throttling, and memory or device errors can explain why an engine phase changed. NVIDIA Data Center GPU Manager (DCGM) Exporter exposes GPU telemetry for Prometheus and can map devices to Kubernetes workloads; metric availability depends on GPU, DCGM build, partitioning mode, and exporter configuration. A utilization gauge alone cannot distinguish useful model work from a stuck or wasteful kernel.

For a distributed group, add per-rank phase arrival, collective duration and bytes, chosen transport, link traffic, communicator errors, and restart events. NCCL RAS can inspect communicator state on supported releases, but it does not replace the service trace that says which requests missed their deadlines.

Keep high-cardinality values such as request ID, prompt digest, adapter ID, and exact sequence length in sampled traces or logs. Prometheus labels should use bounded cohorts such as model bundle, route class, outcome, and length bucket; an unbounded request label can make the metrics system fail during the incident it should explain.

## Measure power, energy, and useful work separately

Power is the rate of energy use. One watt equals one joule per second. Energy accumulates over an interval, so a device drawing 300 W for 2 seconds uses 600 J during that interval. One watt-hour is 3,600 J; one kilowatt-hour is 3.6 million J.

```text
energy in joules = integral of power in watts over time in seconds
for steady power: energy ~= average watts x elapsed seconds
energy per useful request = interval energy / useful completed requests
energy per useful token = interval energy / useful delivered tokens
```

Use an accumulated energy counter when the hardware exposes one, or integrate sampled power with timestamps. NVIDIA DCGM exposes GPU board power in watts and a total-energy counter in millijoules since the driver was loaded on supported devices. Read the counter at both boundaries of the test, subtract, and convert units. A gauge sampled too slowly can miss short changes; adding instantaneous samples without their time intervals is not an energy calculation.

GPU board energy is narrower than service energy. CPU work, host memory, storage, network interfaces, fans, and power-supply losses still exist, as do idle replicas held for burst or failure coverage. For a fleet or procurement comparison, measure the declared system boundary at the power input. MLPerf Power uses an external analyzer at the system under test's AC supply while the benchmark runs. If switches or storage sit outside that meter, name the exclusion.

Report two views when both matter. **Allocated energy** includes idle and supporting-system energy during the measurement window; it reflects what the service actually consumed. An optional **incremental energy** result subtracts a separately measured idle baseline and answers a narrower marginal-work question. Never mix their denominators or present GPU-only energy as whole-service energy.

### Work one energy window

Suppose a ten-minute load test consumes 0.50 kWh at the measured system boundary. It delivers 2,000 successful requests that pass the latency and quality gates and 90,000 output tokens from those requests. Average power is 3 kW. The run uses 900 J per useful request and 20 J per useful output token, equivalent to about 5.56 kWh per million useful output tokens.

```text
elapsed time = 10 minutes = 1/6 hour
average power = 0.50 kWh / (1/6 hour) = 3 kW
energy = 0.50 kWh = 1,800,000 J
energy/request = 1,800,000 J / 2,000 = 900 J
energy/output token = 1,800,000 J / 90,000 = 20 J
energy/million output tokens = 20,000,000 J = 5.56 kWh
```

The numbers are hypothetical; the method is the point. Preserve prompt and output mix, quality checks, latency gates, warm capacity, and system boundary when comparing configurations. A high-power configuration can consume less energy if it finishes much sooner, while a low power cap can save watts yet consume more total energy or miss the token-spacing SLO.

### Utilization and power caps need context

A high activity percentage can represent useful matrix work, memory stalls, rejected work that ran too long, or a kernel stuck making no product progress. Low average activity may be correct for burst headroom while still carrying substantial idle energy. Join activity with scheduled tokens, phase latency, goodput, clocks, and energy instead of ranking deployments by GPU utilization.

NVIDIA hardware and management APIs can expose power limits, temperature, clocks, and clock-event reasons. Reaching a configured power limit or thermal threshold may lower clocks; a single slowed rank can then hold an entire distributed group. Treat a power cap as a versioned performance setting. Benchmark each cap at the same offered workload and report goodput, tails, errors, temperature, average power, and energy per useful unit.

## Size on the constrained phase and leave failure headroom

Convert arrival rate into input and output token demand, then compare both against SLO-compliant measurements per replica. Little's Law gives average concurrency from arrival rate times time in system, but burst shape and percentile targets still require simulation or replay.

Cost per million useful tokens should include reserved or warm replicas, failed work, model downloads, networking, storage, orchestration, and supporting CPU services. Admission limits keep demand inside the region where the measured service envelope remains true.

> **Hypothetical example.** Suppose a document-processing service runs Docling workers before downstream model calls. Page count, file type, optical character recognition (OCR) path, CPU demand, memory demand, and accelerator demand vary by document class. Measure those classes separately and route oversized work instead of multiplying one average file by the daily count.

## Connect arrival rate, residence time, and concurrency

Assume arrivals average 30 requests per second and the mean time from admission to completion is 2.5 seconds. Little's Law gives an average of 75 admitted requests in the system when the system is stable: 30 multiplied by 2.5. If each request averages 1,000 prompt tokens and 250 output tokens, the corresponding mean demand is 30,000 input tokens and 7,500 output tokens per second.

These averages do not set the queue limit or GPU count. A burst may place far more than 75 requests in the system, long prompts may consume prefill capacity unevenly, and output length is unknown at admission. Measure distributions and replay their correlations. Then compare input and output demand with per-replica service envelopes at the required percentiles. If one replica sustains 2,000 compliant output tokens per second for this mix, four replicas cover the mean output rate, but a failure allowance, burst target, and prefill check may require more.

_The four-replica result is only one mean-rate bound under an invented workload._

```text
mean concurrency = 30 requests/s x 2.5 s = 75 requests
input demand = 30 x 1,000 = 30,000 tokens/s
output demand = 30 x 250 = 7,500 tokens/s
mean output replicas = ceil(7,500 / 2,000) = 4
```

## Percentiles require stable boundaries and enough samples

Record timestamps from one clock domain where possible: arrival, admission, queue exit, prefill start and end, first token ready, first token delivered, each later delivery, and completion. If the client and server clocks differ, keep client-observed latency separate from server phase spans. Histograms need bucket boundaries fine enough around the SLO; a final open-ended bucket can tell you requests were slow without telling you how slow.

Report sample count and time window with every percentile. A p99 from 50 requests is not an observed one-in-one-hundred tail. Avoid averaging percentiles from separate workers because the result is not the fleet percentile; combine compatible histograms or events first. Split success, rejection, timeout, and cancellation rather than omitting failed requests from the latency view. During an overload test, compare scheduled arrival time with actual send time so a delayed load generator does not erase the queueing pressure it was meant to create.

> **Delivery boundary.** A server-side TTFT can improve while client-observed TTFT worsens if proxy buffering, network delivery, or a slow stream consumer changed.

## Saturation should produce a controlled response

Queue depth rising together with queue age means admitted demand exceeds completed work. If device batches are full and phase times remain stable, capacity is simply below offered load. If batch size falls while queue age rises, inspect scheduler constraints, memory fragmentation, priority rules, adapter grouping, and blocked workers. If TTFT grows before GPU activity saturates, tokenization, routing, CPU, storage, or network work may be the first limit.

Define a maximum queue age and a bounded amount of admitted work per model or tenant. Reject excess work with a retryable status only when retries have delay and a budget; immediate synchronized retries make overload worse. Reserve capacity for health checks and recovery traffic, and shed lower-priority work before every class misses its deadline. Test the policy by stepping offered load above the measured envelope, removing one replica, and verifying that useful goodput remains observable while queues, rejections, and recovery stay bounded.

- Protect deadlines with admission before the queue becomes a waiting room for doomed work.
- Track rejected demand so a quiet GPU after shedding is not mistaken for low interest.
- Include replica loss and slow clients in the capacity test, not only a steady healthy fleet.

### Connect this to the general SRE model

The same overload rules apply to a database or HTTP service, but token work makes the admission estimate unusual. [Caching and overload control](../03-system-design/08-caching-overload-control.md) explains bounded queues, retry budgets, and load shedding; [reliability and observability](../03-system-design/10-reliability-observability.md) covers SLOs and failure drills without the model-specific phase split.

## Summary

Inference SRE connects output quality, arrival shape, token demand, phase latency, useful throughput, energy, and controlled overload. Raw device activity is not the goal; count acceptable work that reaches the client inside the service contract.

- **Build the quality gate before measuring speed.** Represent product tasks and important slices, use deterministic assertions where possible, apply a written rubric with blinded human checks, and quantify sample uncertainty. A model grader is calibrated automation, not truth.
- **Use open-loop tests for queue behavior.** Closed-loop clients send less traffic as responses slow, which can hide collapse. Open-loop arrivals expose queue age, rejection, and deadline misses; use a production-derived mix of prompt and output lengths.
- **Size prefill and decode separately.** Convert arrival rate into input-token and output-token demand, compare each with SLO-compliant per-replica measurements, then retain capacity for a failed device or node rather than planning at full steady-state occupancy.
- **Apply Little's Law within a stable boundary.** At 30 requests/s and 2.5 s average residence time, average admitted concurrency is 75. With 1,000 prompt and 250 output tokens per request, demand is 30,000 input and 7,500 output tokens/s.
- **Join distributions across four evidence layers.** Client delivery, engine scheduling, device telemetry, and distributed communication answer different questions. Keep request-scale detail in traces, bounded cohorts in metrics, and histogram buckets fine near the SLO.
- **Measure energy at a declared boundary.** Watts are joules per second; energy accumulates across the interval. Separate GPU-board telemetry from wall measurement, include idle capacity where appropriate, and divide energy by requests or tokens that pass the quality and latency gates.
- **Make saturation fail predictably.** Rising queue age with full batches and stable phase time indicates insufficient capacity; falling batch size with growing queues points to scheduler or memory constraints. If TTFT rises before GPU saturation, inspect routing, tokenization, CPU, storage, and network before adding GPUs.

## References

- [vLLM: production metrics](https://docs.vllm.ai/en/stable/usage/metrics/)
- [NVIDIA: GenAI-Perf](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/perf_analyzer/genai-perf/README.html)
- [MLCommons: Inference benchmark](https://docs.mlcommons.org/inference/)
- [OpenTelemetry: metrics](https://opentelemetry.io/docs/concepts/signals/metrics/)
- [Docling project documentation](https://docling-project.github.io/docling/)
- [NVIDIA DCGM: DCGM Exporter](https://docs.nvidia.com/datacenter/dcgm/latest/gpu-telemetry/dcgm-exporter.html)
- [NVIDIA DCGM: power, energy, temperature, and clock fields](https://docs.nvidia.com/datacenter/dcgm/latest/dcgm-api/dcgm-api-field-ids.html)
- [NVIDIA NVML API reference](https://docs.nvidia.com/deploy/pdf/NVML_API_Reference_Guide.pdf)
- [MLPerf Inference: power measurement](https://docs.mlcommons.org/inference/power/)
- [BIPM: International System of Units brochure](https://www.bipm.org/en/publications/si-brochure)
- [NCCL: RAS diagnostics](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting/ras.html)
- [SGLang: serving benchmark metrics and rate control](https://docs.sglang.io/docs/developer_guide/bench_serving)
- [Stanford CRFM: Holistic Evaluation of Language Models](https://crfm.stanford.edu/2022/11/17/helm.html)
- [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://proceedings.neurips.cc/paper_files/paper/2023/hash/91f18a1287b398d378ef22505bf41832-Abstract-Datasets_and_Benchmarks.html)
- [NIST Engineering Statistics Handbook: confidence limits for a proportion](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm)

---
title: Serving engines as moving choices
shortTitle: Serving engines
description: Compare vLLM, TensorRT-LLM, Triton, and SGLang by workload contract, hardware, integration cost, and measured behavior.
collection: ai-inference
slug: serving-engines
order: 4
number: AI4
duration: 150 min
difficulty: Core
tags:
  - vLLM
  - TensorRT-LLM
  - Triton
  - SGLang
---

## Working model

A serving engine is software that loads a model, manages its device memory, groups active sequences, and runs the operations that produce tokens. It is one layer of a service. The surrounding platform still owns the public API, caller identity, routing, rollout, fleet capacity, telemetry, and recovery.

## Questions this note answers

- Separate a model execution engine from an API server and fleet control plane
- Trace normal, streamed, cancelled, queued, and measured requests through a local serving contract
- Compare four serving projects without freezing current feature tables
- Write a reproducible engine evaluation plan
- Identify model, tokenizer, LoRA adapter, streaming, and observability compatibility requirements

## Place the engine inside the service

Running a model in a development script proves that its code can produce an output. A shared service has more work: several callers arrive at once, prompts and outputs vary in length, streams disconnect, GPU memory fills, model revisions roll forward, and unhealthy workers must leave routing. A serving engine handles the model-specific execution and much of the per-device scheduling, but it does not make those service concerns disappear.

Keep these layers separate when reading project documentation:

| Layer               | Main job                                                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Model bundle        | Weights, architecture configuration, tokenizer, prompt template, precision or quantization recipe, and generation defaults         |
| Execution engine    | Load tensors, choose supported kernels, manage KV memory, form device batches, run prefill and decode, and return token results    |
| Protocol server     | Expose HTTP or gRPC, parse requests, stream responses, map errors, and implement health endpoints                                  |
| Service front end   | Authenticate, enforce quotas and deadlines, choose a bundle and worker, normalize API behavior, and record request-level telemetry |
| Fleet control plane | Place replicas, distribute artifacts, scale capacity, roll versions, remove unhealthy workers, and restore known-good service      |

One process may contain several layers. vLLM and SGLang can expose APIs as well as execute models. TensorRT-LLM supplies NVIDIA-focused execution and serving components. Triton is a general model server that delegates execution to a selected backend, including TensorRT-LLM or vLLM. Product names do not replace the layer diagram.

For one request, the front end selects a model bundle and engine worker. The protocol adapter converts the internal request to that engine's supported fields. The engine scheduler admits the sequence into device work, its cache manager owns the KV blocks, and its kernels produce token scores. The response then crosses the adapter and front end again. A failure should be attributed to the layer that owns the broken contract.

“Adapter” has two meanings here. A **model adapter**, commonly LoRA, stores smaller learned updates that modify a named base model without shipping another full set of weights. An **engine adapter** is ordinary service code that translates the product's internal request into one engine API. Keep the names explicit in diagrams and configuration.

## Run one serving contract before loading a model

The first lab is a small local service: [serving-contract-fixture.mjs](examples/serving-contract-fixture.mjs). It uses only Node's built-in modules and an ephemeral loopback port. It needs no model key, GPU, package install, model download, or external network connection.

The fixture is deliberately **not** a language model, tokenizer, inference engine, or performance benchmark. It returns fixed text in fixed-size chunks after small delays. That artificial work makes the service contract visible: HTTP request and response shapes, server-sent events (SSE), client cancellation, an execution limit, a queue, Prometheus text metrics, and a machine-readable evidence record. You will repeat those observations against a real engine later; you must not treat the fixture's character counts or timings as model measurements.

From the repository root, run:

```sh
node notes/04-ai-inference/examples/serving-contract-fixture.mjs demo --requests 8 --concurrency 4
```

The command starts a server on `127.0.0.1` using an operating-system-selected port, performs the exercise, prints one JSON baseline record, and closes the server. Node 22 or newer is sufficient. The focused test runs the same contract as assertions:

```sh
node --test tests/serving-contract-fixture.test.mjs
```

### Follow the exercise in request order

1. A normal `POST /v1/responses` request sends `{"input":"normal request","stream":false}`. The response contains `fixture:normal request`, a request ID, the fixture model name, and character counts. Those counts prove accounting fields were carried through the contract; they are not token counts.
2. A streaming request asks for `stream:true`. Its `text/event-stream` response emits four `response.output_text.delta` events and one `response.completed` event. The client reconstructs `fixture:stream request` and retains the event order and terminal usage object.
3. A second streaming client cancels after its first delta. The server observes that its response closed before completion, stops the simulated work, releases the execution slot, and increments `fixture_requests_cancelled_total`. Client intent alone is not proof of server-side cancellation; the counter supplies the other half of the evidence.
4. Eight normal requests then run with four closed-loop client workers against two execution slots. At most two requests execute at once, so the extra work waits in the bounded queue. This demonstrates admission and queueing; it does not reproduce an open-loop production arrival process.
5. `GET /metrics` returns counters, gauges, and latency count-and-sum samples in the Prometheus text exposition format. The exercise records terminal request counts, final active and queued gauges, peak active and queued work, request-latency observations, and time-to-first-chunk observations.
6. The final JSON joins configuration, runtime, normal response, stream, cancellation, load result, metric snapshot, and interpretation caveats. Keep that record with the code revision when changing the fixture or adapting the exercise to a real engine.

With the default command, verify invariants rather than exact timing numbers:

```text
1 normal + 1 complete stream + 1 cancelled stream + 8 load = 11 requests
10 completed + 1 cancelled = 11 terminal requests
active = 0 and queued = 0 after the exercise
max active = 2 and max queued >= 1
```

The output text, chunk boundaries, event order, and configured limits are deterministic. Elapsed time and latency samples depend on the local runtime and scheduler, so the tests do not assert exact milliseconds. The fixture also omits tokenization, model quality, model artifacts, GPU kernels, KV-cache allocation, dynamic batching, authentication, and real-engine API differences. [The performance note](08-inference-performance-and-sre.md) replaces this bounded closed-loop smoke test with an offered-load experiment before making capacity claims.

### Carry the evidence to a real engine

Do not copy the fixture's settings into production. Preserve each question while replacing its artificial implementation:

| Fixture evidence                              | Real pinned engine and model evidence                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed `deterministic-serving-fixture-v1` name | Engine release and container digest; model and tokenizer revisions; prompt template; precision or quantization; generation defaults         |
| One small JSON request shape                  | The exact endpoint, accepted fields, unsupported-field errors, stop reasons, and usage semantics the product needs                          |
| Named SSE delta and terminal events           | The candidate release's actual event names, ordering, finish signal, error behavior, disconnect behavior, and usage fields                  |
| Cancellation counter after a closed stream    | Proof that a disconnect or explicit cancellation reaches the engine, releases sequence and KV state, and reduces running or queued work     |
| Two execution slots and a visible queue       | Measured scheduler, KV-memory, admission, and concurrency limits for the pinned bundle and hardware; never the fixture's value of two       |
| Small Prometheus text endpoint                | Versioned metric names, labels, histogram buckets, scrape behavior, and the distinction between front-end and worker observations           |
| Four closed-loop clients                      | A compatibility and saturation smoke test, followed by an open-loop workload with production arrival and length distributions               |
| JSON baseline record                          | Driver, CUDA stack, accelerator, replica and parallel plan, artifact digest, warm state, full configuration, raw outputs, and workload seed |

Use this sequence for a real candidate:

1. Pin the engine build or container digest, model and tokenizer revisions, serving configuration, driver stack, and hardware.
2. Replace only the thin endpoint, request-payload, and stream-parser adapter needed for that engine. Keep the normal, stream, cancel, metrics, and bounded-load checks recognizable.
3. Warm the model, record the load and readiness boundary, and state whether caches are cold or warm.
4. Run the sequence and retain raw responses, stream frames, cancellation evidence, metric snapshots, logs, and the effective configuration.
5. Add token counts, time to first token, inter-token latency, queue time, KV-cache use, and GPU memory. Then run the open-loop method in AI8 before describing capacity or comparing engines.

The fixture's `/v1/responses` path and event names make the example easy to read; they are not a claim of OpenAI API compatibility. For example, current vLLM documentation exposes `/v1/responses`, `/health`, and `/metrics`, but its Responses API is explicitly a supported subset and its fields and metrics belong to the pinned release. Test the behavior your service uses instead of relying on a shared path name.

## Start with the request and model, not a benchmark winner

Write down model architecture, precision, adapters, context and output distributions, streaming semantics, structured-output needs, hardware, required parallelism, and latency targets. An engine that cannot express one required model feature is out before performance testing.

Pin the engine commit or release, container digest, driver, CUDA stack, kernel choices, model artifact, tokenizer, and sampling parameters. Engine internals and flags move quickly; a result without those details expires almost immediately.

> **Feature status changes.** Link live project documentation for current model and hardware support. Keep these notes focused on evaluation method rather than a static winner table.

## The four projects expose different product boundaries

The names are easy to compare incorrectly. vLLM, SGLang, and TensorRT-LLM can execute and schedule autoregressive model work. Triton is a general inference server whose backend performs the model execution; Triton can host a TensorRT-LLM or vLLM backend, so “Triton versus TensorRT-LLM” may describe packaging choices rather than competing kernels.

This snapshot was checked on 18 July 2026. It is a map for deciding what to test, not a support promise.

| Project                 | Boundary to remember                                                    | Current areas worth testing                                                                                                                                                              |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vLLM                    | Language-model runtime and API server                                   | Paged KV management, continuous batching, chunked prefill, prefix caching, speculative decoding, structured output, and several distributed strategies across multiple hardware backends |
| SGLang                  | Language and multimodal serving runtime plus program-facing interfaces  | RadixAttention prefix reuse, continuous batching, chunked prefill, structured output, speculative decoding, and prefill/decode disaggregation                                            |
| TensorRT-LLM            | NVIDIA-focused model runtime, build path, and serving APIs              | In-flight batching, paged KV cache, many hardware-specific quantization recipes, speculative decoding, parallel execution, and disaggregated serving                                     |
| Triton Inference Server | Multi-backend server around model repositories and per-model schedulers | HTTP/gRPC, model lifecycle, ensembles, metrics, and backends such as TensorRT-LLM or vLLM                                                                                                |

Do not infer model, quantization, adapter, or GPU support from this table. vLLM and SGLang move features between experimental and supported paths; TensorRT-LLM publishes model, hardware, and feature-combination matrices; Triton and a chosen backend must use compatible versions. Check the exact release documentation and run the fixture described below.

## Operational friction can erase kernel wins

Measure cold model load, warm-up, cancellation, backpressure, graceful drain, metrics, tracing, health behavior, artifact caching, and failure under a dead GPU or worker. A few percent more steady-state tokens per second does not pay for broken rollout or unusable traces.

Keep the external API contract thin enough to swap engines. Normalize request identifiers, model versions, error classes, streaming termination, usage accounting, and telemetry outside engine-specific code where practical.

### Treat compatibility APIs carefully

An endpoint labeled OpenAI-compatible may support only a subset or may differ in streaming events, tool calls, log probabilities, usage fields, and error semantics. Test the calls the product actually makes.

## Adapters and output constraints change the serving contract

A LoRA request is not merely the base model plus a small file. The server must identify the adapter revision, decide where it resides, account for its memory, and keep incompatible adapter work from producing the wrong batch or cache hit. Dynamic adapter-loading endpoints expand the administrative attack surface; vLLM's security guidance, for example, says not to expose runtime LoRA update endpoints to untrusted users. Production systems should stage reviewed adapter artifacts through a controlled deployment path.

Structured output constrains token selection to a grammar, schema, or choice set. It can make a response parseable, but it does not authorize a tool call or validate the meaning of a field. Backends, supported schema features, compilation or preprocessing cost, and interaction with speculation vary by engine release, so include representative schemas in the compatibility fixture.

Multimodal requests add another input accounting problem. The adapter must preserve media limits and preprocessing behavior, while the worker may spend time in an image or audio encoder before language-model prefill. Record original media dimensions, derived model inputs, preprocessing latency, and device memory rather than treating the request as its text-token count alone.

## Separate the public service from the execution adapter

A stable front-end can authenticate callers, enforce quotas, validate request size, select a model bundle, assign a request ID, and normalize streaming events. An engine adapter translates that internal request into the selected engine's API and maps engine errors back into the service's error classes. The engine worker then owns weight loading, device execution, sequence scheduling, and its local cache manager.

This split does not require a large abstraction framework. Define only behavior the product uses: message or prompt input, sampling fields, tool or schema constraints, cancellation, stream termination, usage counts, and errors. Keep engine-specific controls available through a reviewed configuration path rather than pretending every engine has identical knobs. A thin boundary makes a side-by-side canary possible, meaning a small bounded traffic cohort can run the candidate while the rest stays on the known version.

- Front-end evidence: admission decision, route, bundle ID, client deadline, and response status.
- Adapter evidence: translated fields, unsupported options, cancellation result, and engine error mapping.
- Worker evidence: queue phase, batch, cache allocation, model timing, and device faults.

## Remove incompatible choices before timing survivors

Assume a service needs one named model architecture, one of two named tenant-selected LoRA adapters for each request, server-sent token streaming, JSON-schema-constrained output, four-GPU tensor parallelism, and request cancellation. First build a compatibility fixture for each requirement on the exact candidate release. If an engine cannot load the artifact or silently ignores a required request field, it is not a slower option; it is incompatible for this service.

This requirement selects exactly one adapter revision for a request; composing two LoRA adapters in the same forward pass is unsupported in this fixture. Adapter composition would be a separate feature with its own model-correctness, memory, batching, cache-key, and release-support contract. Do not infer it from an engine's ability to keep several independently selectable adapters resident.

For the remaining engines, replay the same 70 percent short-prompt, 25 percent medium-prompt, and 5 percent long-prompt mix at several arrival rates. Hold the model digest, tokenizer, output limits, sampling, hardware, driver, warm-up, and client implementation fixed. Compare goodput that meets the stated latency and quality targets, phase percentiles, peak memory, cold load, cancellation release time, and output checks. Then add operational tests: drain a worker, kill one rank, fill the queue, corrupt a staged artifact, and restore the previous bundle. The record should state which measured constraint decided the choice.

> **No universal winner.** A result belongs to the tested engine release, model bundle, hardware, request mix, configuration, and service limits. Re-run it when one of those inputs changes.

### Ask engine questions in the right order

During an infrastructure interview, start with fit and semantics: Does the engine load the model and tokenizer revision, expose the required API fields, and run on the available accelerators? Then ask about memory and scheduling: Which weight and KV formats work on that hardware, how are prefixes reused, and how are long prefills kept from stalling decode? Distributed and operational questions come last: Which parallel groups cross a node boundary, how does a rank failure surface, and can the fleet drain, cancel, observe, and roll back the exact build?

That order keeps the discussion tied to the service. Naming PagedAttention, RadixAttention, or in-flight batching without connecting it to prompt reuse, queue behavior, memory pressure, or a stated service target does not answer the design question.

## Treat an engine update as a behavior change

A minor-looking update can change default scheduler limits, attention backends, graph capture, tokenizer integration, memory reservation, API fields, or metric names. Pinning the container digest makes the running version identifiable, but it does not prove equivalent behavior. Read migration notes and diff effective configuration, including defaults that are absent from the deployment file.

Use a fixed conformance suite before performance tests. Check deterministic output fixtures, token counts, stop reasons, streaming event order, usage fields, unsupported-parameter errors, cancellation, and readiness during model load. Next compare phase traces and memory under the reference workload. If TTFT changes, isolate queue and prefill time; if token spacing changes, inspect decode batch shape and kernels; if memory changes, split weights, KV allocation, workspaces, and graph pools. Keep the prior engine bundle warm enough to roll back without exceeding the service's cold-start allowance.

### Metric continuity

Do not silently join old and new histogram names or buckets. Record the engine build as a label and update dashboards before the canary so an apparent improvement is not a missing series.

## Summary

Serving-engine selection is a compatibility and operations decision before it is a throughput contest. Define the exact model bundle, request semantics, hardware, distributed plan, observability, and rollout needs; reject candidates that cannot express the contract, then benchmark the survivors under the same workload.

- **Start with an observable local contract.** The dependency-free fixture makes normal responses, SSE event order, server-observed cancellation, bounded queueing, metrics, and an evidence record concrete. Its fixed character work is not inference and its timing is not a benchmark.
- **Write the compatibility fixture first.** Test architecture, precision, tokenizer, adapters, context range, streaming, cancellation, structured output, parallelism, and artifact format on the exact release. Silent field omission is incompatibility, not a performance result.
- **Know the five layers and each product boundary.** Bundle, engine, protocol server, service front end, and fleet control plane have different jobs. vLLM and SGLang span runtime and APIs; TensorRT-LLM supplies NVIDIA-focused execution; Triton wraps selected backends in a broader model server.
- **Include adapters, constraints, and media in compatibility tests.** Adapter identity affects residency, batching, and cache keys; structured output affects token selection but not authorization; multimodal preprocessing adds work that text-token counts omit.
- **Keep the public API separate from the engine adapter.** A stable front end owns auth, quotas, validation, routing, IDs, and stream semantics. The adapter translates to engine-specific calls and error classes, limiting migration scope.
- **Benchmark the actual service contract.** Record model digest, engine release, driver, GPU, request length distributions, offered load, batch limits, quality gates, and latency targets. Compare compliant goodput, not a vendor throughput number from another shape.
- **Include operational behavior.** Cold load, warm-up, artifact caching, health, draining, backpressure, cancellation, metrics, tracing, and dead-worker or dead-GPU behavior can outweigh a small kernel gain.
- **Treat upgrades as behavior changes.** Defaults for scheduling, attention backends, graph capture, memory reservation, API fields, and metric names can move between releases. Pin digests, diff effective configuration, and repeat compatibility and rollout tests.

## References

- [Node.js HTTP documentation](https://nodejs.org/api/http.html)
- [WHATWG: Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [Prometheus text exposition formats](https://prometheus.io/docs/instrumenting/exposition_formats/)
- [vLLM documentation](https://docs.vllm.ai/en/stable/)
- [vLLM: OpenAI-compatible server](https://docs.vllm.ai/en/stable/serving/openai_compatible_server/)
- [vLLM: metrics design](https://docs.vllm.ai/en/latest/design/metrics/)
- [vLLM: production metrics](https://docs.vllm.ai/en/latest/usage/metrics/)
- [vLLM: serving benchmark](https://docs.vllm.ai/en/latest/api/vllm/benchmarks/serve/)
- [vLLM: parallelism and scaling](https://docs.vllm.ai/en/stable/serving/parallelism_scaling/)
- [vLLM: LoRA adapters](https://docs.vllm.ai/en/stable/features/lora/)
- [vLLM: security guidance](https://docs.vllm.ai/en/latest/usage/security/)
- [vLLM: structured outputs](https://docs.vllm.ai/en/stable/features/structured_outputs/)
- [TensorRT-LLM documentation](https://nvidia.github.io/TensorRT-LLM/)
- [TensorRT-LLM: quantization and hardware support](https://nvidia.github.io/TensorRT-LLM/latest/features/quantization.html)
- [NVIDIA Triton Inference Server](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/)
- [Triton architecture and backend boundary](https://docs.nvidia.com/deeplearning/triton-inference-server/user-guide/docs/user_guide/architecture.html)
- [SGLang documentation](https://docs.sglang.io/)
- [SGLang: Efficient Execution of Structured Language Model Programs](https://papers.nips.cc/paper_files/paper/2024/hash/724be4472168f31ba1c9ac630f15dec8-Abstract-Conference.html)

---
title: Single-node inference optimization
shortTitle: Node optimization
description: Tune request scheduling, KV allocation, attention kernels, graph replay, precision, and speculative work against a stated latency target.
collection: ai-inference
slug: single-node-optimization
order: 5
number: AI5
duration: 140 min
difficulty: Advanced
tags:
  - continuous batching
  - PagedAttention
  - FlashAttention
  - quantization
---

## Working model

A node is one server with CPUs, memory, network interfaces, and one or more GPUs. Tuning that node is a packing problem under deadlines: the scheduler groups request phases, the cache manager places KV blocks, and kernels group useful arithmetic into each device pass. A change that helps one layer can hurt another.

## Questions this note answers

- Compare static, continuous, and chunked-prefill scheduling
- Explain block-based KV allocation and prefix-cache correctness
- State what FlashAttention and CUDA graphs reduce
- Evaluate quantization through speed, memory, kernel support, and quality
- Explain speculative decoding's acceptance-dependent trade

## Optimize a measured service, not a list of features

Write the failing objective first. It might be p95 time to first token, token cadence, maximum safe concurrency, energy per useful token, or the ability to fit one model. Those goals can disagree: a larger batch may raise total tokens per second while delaying an individual request, and lower-precision weights may free memory while failing a quality check.

Build a plain baseline with the exact model bundle, hardware, request distribution, offered load, and latency limits. Split its trace into queue, prefill, decode, delivery, CPU, device, and communication time. Only then choose a mechanism aimed at the measured limit:

| Observed limit                                    | First mechanism to test             | Evidence that would support it                                              |
| ------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Device idle between uneven sequence completions   | Continuous batching                 | More useful batch slots without worse queue or token latency                |
| KV capacity stranded by variable sequence lengths | Block-based KV allocation           | More admitted cached tokens at the same device-memory bound                 |
| Attention spends excessive time moving score data | A supported FlashAttention path     | Lower attention time and HBM traffic for the same output                    |
| Repeated small CPU launch gaps                    | CUDA graph replay for stable shapes | Fewer launch gaps without incorrect capture or excessive graph pools        |
| Weight or KV bandwidth and capacity               | A supported quantization recipe     | Lower residency or phase time while quality and latency gates still pass    |
| Too many serial target-model decode steps         | Speculative decoding                | Accepted proposals save more target work than drafting and verification add |

Change one mechanism at a time against the same replay. Keep counters showing whether the new path actually ran; a configured feature that fell back to its plain kernel explains nothing.

## Continuous batching replaces requests as they finish

Static batching waits for a fixed group and often wastes slots when sequences finish at different lengths. Iteration-level continuous batching removes completed sequences and admits new work between decode iterations, keeping more of the device occupied.

Long prefills can still block decode-sensitive traffic. Chunked prefill splits prompt work so the scheduler can interleave it with decode, trading more scheduling and kernel overhead for tighter latency control. Measure the actual prompt and output distributions.

## PagedAttention makes sequence memory non-contiguous

Block-based KV managers assign fixed-size physical blocks to logical sequence positions. They reduce the external fragmentation and large contiguous reservations that strand memory when sequence lengths vary.

A prefix cache can reuse KV blocks when requests share an identical model-relevant prefix. The cache identity must include every input that changes the computed state, such as model or adapter version and token IDs. Reuse also needs tenant and privacy rules; a cache hit cannot become a cross-tenant data channel.

> **Cache invalidation is part of correctness.** Hashing only rendered text is not enough if tokenizer, model, adapter, position scheme, or other inputs differ.

## FlashAttention and CUDA graphs remove different waste

FlashAttention reorganizes exact attention computation to reduce transfers between HBM and on-chip storage. It does not change attention into an approximate algorithm, although supported shapes, dtypes, masks, and implementations vary.

CUDA graphs capture a repeatable launch graph so later replays pay less CPU launch overhead. Dynamic shapes, memory addresses, conditional paths, and scheduler behavior determine how much of a serving step can usefully fit a graph.

Quantization cuts stored precision for weights, activations, or KV data according to a scheme. Smaller tensors can relieve memory and bandwidth pressure, but conversion work, unsupported kernels, calibration error, and quality loss can erase the benefit.

## Quantization has more than one axis

“The model is 4-bit” leaves out most of the execution contract. Weight-only W4A16 stores weights near 4 bits while keeping activations around 16 bits. W8A8 quantizes weights and activations to 8-bit formats. FP8 and FP4 recipes use floating-point formats with hardware-specific scaling rules, while KV-cache quantization changes persistent sequence state independently of weight precision.

Every scheme also chooses granularity (tensor, channel, row, or group), scale representation, zero points where applicable, calibration method, and kernels. Packed weights need scale and metadata bytes, so a 4-bit checkpoint occupies more than the raw half-byte-per-parameter floor. A scheme that saves HBM capacity but dequantizes into a slow path may fit more requests and still increase token latency.

Take a hypothetical 70-billion-parameter dense model. BF16 weights have a 140 GB decimal lower bound. Packed 4-bit weights have a 35 GB raw lower bound, before scales, padding, embeddings kept at higher precision, runtime workspaces, and KV cache. That arithmetic can eliminate impossible placements, but it cannot prove that one 80 GB device serves the model with enough cache or that the available GPU has a fast kernel for the chosen format.

```text
BF16 raw weights = 70 billion x 2 bytes = 140 GB
packed INT4 floor = 70 billion x 0.5 byte = 35 GB
actual residency = packed weights + quantization metadata + unquantized tensors
                 + allocator/workspaces + graph pools + KV cache
```

Compare the quantized bundle with the baseline on task evaluations, deterministic fixtures, long-context retrieval, structured output, rare languages or code if they matter, and the exact sampling settings used by the product. Perplexity alone does not cover every downstream failure.

## Speculation wins only when proposed tokens survive

Speculative decoding uses a cheaper draft process to propose several tokens, then lets the target model verify them in parallel while preserving the target distribution under the method's assumptions. Accepted runs reduce serial target-model steps.

Low acceptance, draft-model cost, extra KV state, or scheduler interference can make speculation slower. Track acceptance length and end-to-end latency by prompt class rather than enabling it globally from one throughput chart.

The original rejection-sampling method preserves the target model's output distribution when its verification and correction rules apply. Greedy verification and newer draft methods have different guarantees. Constrained decoding, penalties, adapters, and distributed scheduling can also change support, so “lossless speculation” is a property of a specific algorithm and configuration rather than every feature grouped under the name.

## Judge a faster variant inside the latency limit

Suppose a baseline completes 2,400 output tokens per second at an offered load of 20 requests per second. Ninety-eight percent of requests meet the TTFT and token-spacing limits, so its **goodput**, the throughput that meets the stated service rules, is roughly 2,352 output tokens per second if token volume is distributed evenly. A quantized variant completes 2,900 tokens per second, but only 75 percent of requests meet both limits. Its comparable goodput is about 2,175 tokens per second before any quality failures are removed.

The larger raw throughput number is not the better service result. Repeat the comparison across the same arrival process, prompt and output distributions, sampling settings, and warm state. Report p50, p95, and p99 phase latency: p95 is the value at or below which 95 percent of observations fall, and p50 is the median. Include queue behavior, cache occupancy, peak memory, energy per useful token when cost or power matters, and task-quality checks. If the freed memory allows another sequence but pushes many short requests past their deadlines, the scheduler policy may need adjustment before the quantization scheme can help.

_This shortcut assumes missed and successful requests carry similar token volumes; real tests should count compliant tokens directly._

```text
baseline goodput ~= 2,400 x 0.98 = 2,352 output tokens/s
variant goodput ~= 2,900 x 0.75 = 2,175 output tokens/s
```

## Optimization failures often cross component boundaries

A prefix-cache hit can return incorrect state if its key omits a tokenizer revision, adapter, multimodal input, position rule, or tenant boundary. Quantization can pass a small text sample yet fail a task class, rare activation range, or unsupported kernel shape. A captured CUDA graph can replay stale addresses if the runtime violates capture assumptions. Speculation can preserve target-model sampling correctness while still losing latency through poor acceptance and extra scheduling work.

Test each feature with a disable switch and counters that show when it was used. For prefix caching, record hit rate, reused token count, key namespace, and correctness fixtures. For quantization, compare task scores and output distributions along with memory and latency. For graphs, track capture coverage and fallbacks by shape. For speculation, record proposed, accepted, and rejected tokens plus draft time. When a mixed feature set regresses, turn off one feature at a time against an identical replay rather than guessing from aggregate throughput.

> **Keep a plain baseline.** Retain one supported configuration without optional caching, speculation, or graph paths. It gives incident responders a known comparison and a possible rollback target.

## Summary

Single-node optimization is useful only when it removes the measured bottleneck while preserving output quality and latency targets. Batching, KV paging, attention kernels, graph replay, prefix caching, quantization, and speculative decoding attack different costs and introduce different correctness or compatibility risks.

- **Use continuous batching to refill decode slots.** Removing finished sequences and admitting new ones between iterations reduces idle capacity caused by uneven output lengths, but scheduler limits and latency classes still constrain mixing.
- **Page KV state to reduce stranded memory.** Fixed-size physical blocks map to logical sequence positions, avoiding large contiguous reservations. Block size, free-list behavior, and fragmentation still affect usable capacity.
- **Do not conflate kernel and launch optimizations.** FlashAttention reduces movement between HBM and on-chip storage for exact attention; CUDA graphs reduce repeated CPU launch work for stable execution shapes. Each has separate dtype, mask, shape, and capture requirements.
- **Speculation depends on acceptance.** A cheaper draft proposes tokens and the target verifies them; speedup requires enough accepted tokens to offset draft, verification, and scheduling work while preserving the target distribution under the method's assumptions.
- **Describe quantization as a full recipe.** Weight-only W4A16, W8A8, FP8/FP4, and quantized KV cache change different tensors. Record granularity, scales, calibration, retained higher-precision tensors, kernel, and hardware instead of using one bit count as the configuration.
- **Compare compliant goodput.** A 2,400 token/s baseline with 98% of requests meeting limits yields about 2,352 compliant token/s. A 2,900 token/s variant at 75% compliance yields about 2,175 before quality failures, so higher raw throughput loses.
- **Keep a measured plain baseline for diagnosis and rollback.** State the failing objective, preserve the workload and hardware, and change one mechanism at a time. Cache keys need full model identity, quantization needs task checks, and captured graphs need stable addresses.

## References

- [Orca: iteration-level scheduling](https://www.usenix.org/conference/osdi22/presentation/yu)
- [PagedAttention paper](https://arxiv.org/abs/2309.06180)
- [FlashAttention paper](https://arxiv.org/abs/2205.14135)
- [NVIDIA: CUDA graphs](https://docs.nvidia.com/cuda/cuda-programming-guide/index.html#cuda-graphs)
- [Fast inference through speculative execution](https://research.google/pubs/fast-inference-from-transformers-via-speculative-execution/)
- [vLLM documentation](https://docs.vllm.ai/en/stable/)
- [GPTQ: Accurate Post-Training Quantization for Generative Pre-trained Transformers](https://arxiv.org/abs/2210.17323)
- [AWQ: Activation-aware Weight Quantization for On-Device LLM Compression and Acceleration](https://proceedings.mlsys.org/paper_files/paper/2024/hash/42a452cbafa9dd64e9ba4aa95cc1ef21-Abstract-Conference.html)
- [SmoothQuant: Accurate and Efficient Post-Training Quantization for Large Language Models](https://proceedings.mlr.press/v202/xiao23c.html)
- [TensorRT-LLM: quantization support matrix](https://nvidia.github.io/TensorRT-LLM/latest/features/quantization.html)

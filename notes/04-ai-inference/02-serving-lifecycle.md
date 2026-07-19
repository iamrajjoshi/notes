---
title: The inference request lifecycle
description: Break one streamed completion into admission, tokenization, prefill, decode, KV-cache growth, and delivery to the client.
slug: serving-lifecycle
order: 2
identifier: AI2
duration: 120 min
difficulty: Core
tags:
  - prefill
  - decode
  - KV cache
  - streaming
---

## Working model

A text-generation request does not go straight from HTTP to a GPU. CPU-side code validates and tokenizes it, a scheduler waits for safe capacity, the GPU processes the prompt and generates tokens, and the delivery path streams them while every stage tracks cancellation and memory ownership.

## Trace the whole path before studying a phase

One request crosses these boundaries:

| Stage               | Work and state                                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receive             | A gateway authenticates the caller, parses the request, assigns a deadline and request ID, and rejects malformed or oversized input.                                                                       |
| Tokenize and admit  | CPU code renders the prompt template, converts text to token IDs, calculates limits, and decides whether the service can accept the work. **Admission control** is this accept, delay, or reject decision. |
| Queue and schedule  | The accepted request waits in a bounded queue. A scheduler groups compatible work into a **batch**, meaning several sequences processed in one device iteration.                                           |
| Prefill             | The GPU processes the known prompt positions, writes their KV cache, and produces scores for the first output token.                                                                                       |
| Decode              | Repeated GPU iterations read weights and prior KV state, choose one next token per active sequence, and append new KV entries while generation continues.                                                  |
| Deliver and release | The server sends token events to the client, honors stop conditions or cancellation, records usage, and frees queue, batch, stream, and KV state.                                                          |

**Streaming** means sending partial output before the full response finishes. It improves perceived responsiveness but creates **backpressure** when a client or proxy consumes bytes more slowly than the server produces them. The server must bound that buffer; otherwise slow or disconnected clients can retain memory and GPU work indefinitely.

A scheduler may use **continuous batching**: after each model iteration, it removes finished sequences and admits compatible waiting work. This differs from a fixed batch that waits for every member to finish. The batch shape therefore changes while requests are active.

## Admission owns work before the GPU sees it

Authentication, request limits, tokenizer work, model selection, adapter selection, and queue placement happen before a model kernel runs. A server that accepts unlimited work has already lost control: queued requests retain memory, exceed client deadlines, and make cancellation cleanup harder.

Admission should know the model, prompt length, requested output bound, priority, current queue, and caller policy. A **tenant** is the account, organization, or other isolation unit to which quota and data rules apply. Rejecting or delaying excess work protects completed work that still meets its deadline better than letting every request time out after consuming GPU cycles.

## Prefill processes the known tokens in parallel

Prefill runs the prompt through the model and produces the first set of key/value tensors. Matrix dimensions grow with the number of prompt tokens, giving the GPU more parallel work; long prompts can dominate compute and delay short requests when the scheduler admits them carelessly.

Time to first token (TTFT) includes queueing, tokenization, prefill, sampling, and delivery. A high TTFT does not identify which of those components caused it, so trace the phase boundaries.

## Decode trades wide parallel work for repeated memory reads

After prefill, each decode iteration consumes the latest token and cached keys and values, then produces logits for one next token per active sequence. Weight and KV reads can dominate; the continuous-batching scheduler tries to keep the device full by mixing sequences at different decode positions.

Streaming returns tokens as they become available, but the server still needs bounded buffers and cancellation propagation. A disconnected client should release queue entries, sequence slots, and KV blocks promptly.

> **Do not collapse the metrics.** TTFT describes the wait for the first token. Time between tokens describes decode cadence. A single end-to-end average hides both.

## KV cache grows with the sum of cached tokens

Multi-head attention (MHA) normally gives every query head its own key and value head. Multi-query attention uses one key/value head for all query heads, while grouped-query attention (GQA) uses an intermediate number. Fewer KV heads reduce cache storage and KV bandwidth; they do not reduce the number of query heads in the same proportion.

First calculate bytes per cached token, then multiply by the sum of cached token counts across active sequences. Do not multiply by batch size again if the token count already includes the full batch.

```text
KV bytes per cached token
  ~= 2 x layers x KV heads x head dimension x bytes per element

total logical KV bytes
  ~= KV bytes per token x sum(cached tokens for each active sequence)
```

The leading 2 represents keys and values. Sliding-window attention, latent-attention designs, cache quantization, cross-attention, speculative branches, and non-Transformer state need different formulas. Tensor parallelism may shard or replicate parts of the cache depending on model head counts and engine layout. Block allocation, prefix sharing, alignment, temporary buffers, and engine metadata then move physical residency away from the logical estimate.

### Work the GQA number before choosing concurrency

Take a hypothetical decoder with 32 layers, 32 query heads, 8 KV heads, head dimension 128, and BF16 cache elements. Each cached token needs 131,072 bytes, or 128 KiB. A 4,096-token sequence therefore holds 512 MiB of logical KV state. Twenty such sequences hold 10 GiB before allocator overhead and temporary state.

If the same architecture used 32 KV heads, the cache would be four times larger: 512 KiB per token, 2 GiB for one 4,096-token sequence, and 40 GiB for twenty. This is why parameter count alone cannot set serving concurrency.

```text
GQA per token = 2 x 32 x 8 x 128 x 2 bytes = 131,072 bytes = 128 KiB
one sequence = 128 KiB x 4,096 = 512 MiB
20 sequences = 10 GiB

MHA comparison = GQA result x (32 KV heads / 8 KV heads) = 4x
```

## Map latency to a concrete request

Consider a 2,048-token prompt that waits 40 ms for admission, spends 8 ms in tokenization, 160 ms in prefill, and 12 ms sampling and delivering the first token. Its measured TTFT at the service boundary is 220 ms. If it then generates 128 additional tokens with a mean 25 ms between delivered tokens, the decode-and-delivery portion takes about 3.2 seconds before final response overhead.

The example separates two user experiences. The first visible output arrives after 220 ms, while reading cadence is about 40 tokens per second after that. Cutting prefill time in half lowers TTFT by 80 ms but barely changes the remaining stream. Cutting mean token spacing from 25 to 20 ms saves about 640 ms over 128 intervals. Which change matters depends on the product's prompt sizes, output lengths, and stated latency limits.

_Teams must state whether the first emitted token is included in the interval count and where the timing boundary sits._

```text
TTFT = 40 ms queue + 8 ms tokenize + 160 ms prefill + 12 ms sample/deliver
     = 220 ms
stream time ~= 128 intervals x 25 ms = 3,200 ms
```

## Every transition needs an owner and a release rule

Represent a request as a state machine: received, validated, tokenized, queued, prefilling, decoding, draining, then completed, rejected, timed out, or cancelled. Each state owns specific memory and scheduler records. A timeout flag at the HTTP layer is incomplete if a queued item or active sequence can continue consuming capacity after the client is gone.

Measure counts and residence time at each transition. If queue time rises while GPU batch size remains small, inspect admission limits, scheduling policy, tokenizer workers, model routing, and unavailable sequence slots. If KV occupancy stays high after cancellation, inspect asynchronous cleanup and references retained by streaming buffers. If TTFT rises only for short prompts when long prompts arrive, compare prefill chunking and priority policy rather than adding replicas without evidence.

- Admission metric: accepted, delayed, and rejected work by reason.
- Scheduler metric: waiting and running sequences by phase and priority.
- Memory metric: allocated KV blocks, free blocks, and release delay after completion.
- Delivery metric: buffered bytes, slow clients, disconnects, and cancelled work still running.

## Summary

A serving request changes ownership and resource state from admission through tokenization, queueing, prefill, decode, streaming, and cleanup. Capacity and latency are understandable only when every transition has a timestamp, an owner, and a release rule for completion, rejection, timeout, and cancellation.

- **Follow all six stages and control admission.** Receive, tokenize and admit, queue and schedule, prefill, decode, then deliver and release. Authenticate, enforce token limits, and reject excess load before it occupies an unbounded queue.
- **Separate prefill and decode.** Prefill processes the known prompt with broad token parallelism and produces the first KV state. Decode produces one next-token step per active sequence and often pays repeated weight and KV reads.
- **Estimate KV cache from cached tokens, not request count.** Per-token bytes are approximately 2 × layers × KV heads × head dimension × bytes per element. Multiply by the sum of cached tokens across active sequences, then account for sharding, blocks, sharing, and temporary state.
- **Check GQA against MHA.** A 32-layer BF16 example with 8 KV heads and 128-wide heads needs 128 KiB per token, or 512 MiB at 4,096 tokens. Using 32 KV heads makes the same logical cache four times larger.
- **Keep latency clocks distinct.** TTFT includes admission, queueing, tokenization, prefill, sampling, and first delivery at the chosen boundary. Inter-token time describes streaming cadence; one end-to-end average hides which phase changed.
- **Check the worked timeline.** A 2,048-token prompt with 40 ms admission, 8 ms tokenization, 160 ms prefill, and 12 ms first-token work has 220 ms TTFT. Another 128 tokens at 25 ms spacing add about 3.2 seconds before final overhead.
- **Model streaming and cleanup as state-machine behavior.** Bound buffers when clients read slowly. Queued entries, active sequences, cache blocks, scheduler records, and stream handles must be released exactly once; an HTTP-only cancellation can leave orphaned GPU work.

## References

- [Attention Is All You Need](https://proceedings.neurips.cc/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html)
- [Hugging Face: Tokenizers](https://huggingface.co/docs/tokenizers/main/en/index)
- [TensorRT-LLM: GPT attention](https://nvidia.github.io/TensorRT-LLM/advanced/gpt-attention.html)
- [vLLM: production metrics](https://docs.vllm.ai/en/stable/usage/metrics/)
- [GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints](https://arxiv.org/abs/2305.13245)
- [Efficient Memory Management for Large Language Model Serving with PagedAttention](https://arxiv.org/abs/2309.06180)

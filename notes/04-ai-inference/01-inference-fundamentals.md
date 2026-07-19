---
title: Inference fundamentals
description: Trace tensors through a model, then compare how generation, embedding, speech, vision, diffusion, and batch workloads change serving state and latency.
slug: inference-fundamentals
order: 1
identifier: AI1
duration: 150 min
difficulty: Foundation
tags:
  - Transformers
  - tokens
  - tensors
  - dtypes
  - workload classes
---

## Working model

Inference means running an already-trained model to produce an answer. For a text model, the service turns text into numbered pieces called tokens, runs them through fixed learned numbers called weights, and chooses output tokens. Other models may consume images, audio frames, document pairs, or latent tensors instead. Most serving cost comes from moving and multiplying arrays and retaining the state required by active work.

## Scope: shared method, one deepest worked path

This collection is broad in the infrastructure method it teaches, but its deepest worked path is **online autoregressive language-model serving**. Later notes spend the most time on token admission, prefill, KV cache, repeated decode, continuous batching, tensor parallelism, and streaming because that lifecycle exposes many infrastructure constraints at once. Reading those notes does not by itself make someone a specialist in speech, computer vision, or diffusion systems.

The method does generalize. Every production inference service must version its model and preprocessing contract, calculate static and per-request state, choose a batching axis, measure useful work at a quality and latency boundary, control admission, isolate tenants, attribute latency to phases, release state after cancellation, and roll back a bad bundle. The nouns do not always generalize: an image classifier has no language-model KV cache, a diffusion job has denoising steps rather than decode tokens, and an asynchronous batch job may optimize a completion deadline rather than time to first token.

## Start at the service boundary

Suppose a client sends `{"prompt":"The database is slow because"}` and asks for at most 20 new tokens. The HTTP server authenticates the caller and checks the request; the model runtime performs inference; the server streams or returns the generated text. The model is the learned function. The model server is the software around that function: it loads artifacts, schedules requests, allocates memory, runs hardware operations, and returns results.

Training and inference solve different jobs. Training adjusts model weights by comparing predictions with examples and calculating gradients. Inference normally leaves those weights fixed and applies them to new input. This module concerns inference infrastructure, not how to collect training data or optimize a training run.

## Learn the vocabulary once

| Term                     | Meaning in these notes                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                    | A parameterized function that maps input numbers to output numbers. A language model assigns scores to possible next tokens.                                                                          |
| Parameter or weight      | A learned numeric value. A checkpoint stores weight tensors plus enough configuration to reconstruct the model.                                                                                       |
| Tensor                   | An array of numbers. A scalar has no axes, a vector has one, and a matrix has two; larger tensors add axes such as batch, token position, or attention head.                                          |
| Shape, dtype, device     | Shape gives the length of each tensor axis; dtype gives the numeric representation, such as the 16-bit bfloat16 format (BF16); device says where the storage and operations live, such as CPU or GPU. |
| Token and tokenizer      | A token is an ID from a fixed vocabulary. The tokenizer converts text to IDs and back; a token may be a word, part of a word, punctuation, whitespace, or bytes.                                      |
| Embedding and activation | An embedding maps a token ID to a vector. Activations are the temporary tensors produced while a request moves through the model.                                                                     |
| Layer and Transformer    | A layer is a repeated stage of computation. A Transformer combines attention with feed-forward computation and normalization; a decoder-only Transformer generates text left to right.                |
| Logit and decoding rule  | A logit is an unnormalized score for one vocabulary item. A decoding rule converts the scores into a chosen token, either deterministically or by sampling.                                           |

An LLM is a language model with a large number of parameters. “Large” has no precise engineering threshold, so capacity plans should name the architecture, parameter count, tensor shapes, and formats instead of relying on the label.

## Follow a tiny request before calculating it

Imagine a toy tokenizer turns `cats sleep` into IDs `[41, 92]`. An embedding table maps each ID to a vector. The model passes those vectors through its layers; attention lets the representation at the second position incorporate permitted earlier positions. The final layer produces one logit for every vocabulary item. If the end token has the highest selected score, generation stops; otherwise the chosen token is appended and the model runs another step.

Real models use much wider vectors, many layers, and large vocabularies, but the data path stays recognizable:

```text
text -> token IDs -> embeddings -> repeated model layers -> logits
     -> choose one token -> append it -> repeat until a stop condition
```

A **context window** is the maximum sequence length a particular model and runtime configuration accepts. The input prompt and generated continuation both occupy it. A public request limit may be smaller to preserve memory, latency, or fairness.

## Trace one toy tensor shape into a token

Use a deliberately tiny decoder with a 12-item vocabulary, hidden width 8, and one attention layer with 2 heads of width 4. A tokenizer produces three IDs, `[2, 5, 9]`, for one request. The leading axis below is the batch, so the ID tensor has shape `[1, 3]`: one sequence containing three positions.

The embedding table `E` has shape `[12, 8]`. Selecting rows 2, 5, and 9 produces `X` with shape `[1, 3, 8]`. Position information is incorporated without changing that outer shape. Three learned projection matrices, each with shape `[8, 8]`, produce `Q`, `K`, and `V`, each shaped `[1, 3, 8]`. Splitting the hidden axis into two heads and transposing for attention gives `[1, 2, 3, 4]`: batch, head, token position, and head width.

```text
token IDs                         [1, 3]
embedding table E                [12, 8]
X = E[token IDs]                  [1, 3, 8]

Wq, Wk, Wv                       [8, 8] each
Q = X @ Wq                        [1, 3, 8] -> [1, 2, 3, 4]
K = X @ Wk                        [1, 3, 8] -> [1, 2, 3, 4]
V = X @ Wv                        [1, 3, 8] -> [1, 2, 3, 4]

Q @ K^T per head                  [1, 2, 3, 3]
softmax(mask(scores)) @ V         [1, 2, 3, 4]
concatenate the two heads         [1, 3, 8]

final hidden state at position 3  [1, 8]
vocabulary projection            [8, 12]
final-position logits             [1, 12]
selected token ID                 one integer, for example 7
```

There are 18 raw attention scores in this toy layer: `1 x 2 x 3 x 3`. The causal mask permits only 1 + 2 + 3 = 6 position pairs per head, or 12 across both heads. After the remaining layer operations, the final position's 8 values are multiplied by an `[8, 12]` vocabulary matrix to obtain 12 logits. Greedy decoding selects the largest; sampling instead converts those same logits into a distribution and draws one ID. Appending ID 7 makes the sequence length four, and cached decode can calculate a one-position query while retaining earlier keys and values.

Real models fuse operations, use many layers and heads, may have fewer key/value heads than query heads, and often tie the embedding and vocabulary-projection weights. The small trace is a shape ledger, not an implementation promise.

## Shape and dtype decide the first memory bill

A tensor is an n-dimensional array with a shape, dtype, device, and memory layout. Matrix multiplication combines rows from one matrix with columns from another through multiply-and-add operations. It may be mathematically valid while still running poorly because its dimensions, layout, or dtype do not fit efficient device kernels, which are compiled functions that perform operations such as multiplication or normalization.

FP32, FP16, and BF16 are floating-point formats using 32 or 16 bits per stored value; they trade range, precision, storage, and hardware support differently. INT8 stores 8-bit integers together with scaling rules in a quantized model. “4-bit” usually means values packed more densely plus scale metadata, not that every runtime tensor occupies exactly half a byte. Later notes separate storage format from the format used for multiplication and accumulation.

Weight memory starts with parameter count multiplied by bytes per stored weight. A nominal 7-billion-parameter model needs about 14 billion bytes in FP16 before memory-manager padding, runtime workspaces, activations, and the request cache introduced below. INT8 halves the raw weight bytes; packed 4-bit weights halve them again, but only a compatible device kernel can turn smaller storage into lower latency.

_This estimate covers stored weights only. Runtime memory comes later._

```text
weight bytes ~= parameter count x bytes per stored weight

FP32: 4 bytes   FP16/BF16: 2 bytes   INT8: 1 byte   packed INT4: 0.5 byte
```

## The tokenizer defines the model's units of work

A tokenizer maps text into integer token IDs according to a fixed vocabulary and algorithm. Token count is not character count or word count; code, whitespace, writing systems, and uncommon text can change the ratio sharply.

The model maps token IDs to vectors, adds position information, and runs them through repeated Transformer layers. In a causal decoder, self-attention lets each position combine information from allowed earlier positions. An output projection produces logits over the vocabulary, after which a decoding policy selects the next token.

> **Capacity implication.** Rate limits and cost estimates based only on request count hide the work. Record input and output token distributions separately.

## Position is part of the model contract

Attention needs some representation of order; otherwise the same tokens in a different order do not carry enough information about which position is which. Transformer families encode position in different ways. Some add a learned or fixed position vector to each token representation. Models using **rotary position embeddings**, usually called RoPE, rotate components of each query and key according to its position before the query-key comparison. At this level, the important point is that position changes attention behavior even though it does not add another public request field.

The position scheme is part of context compatibility. A checkpoint was trained with particular position behavior, and runtimes may expose scaling or other long-context options. Raising a configured context limit does not prove that output quality, memory use, or kernels remain acceptable at the new length; validate the exact model and setting.

A **prefix cache** retains KV state for a previously processed prefix so a compatible later request can reuse that work. Its identity must include the same model-relevant prefix: token IDs, model and adapter revision, attention configuration, RoPE or other position parameters, and the position IDs assigned to those tokens. Keys computed with one RoPE scaling rule or starting position are not interchangeable with keys computed under another. A cache key that includes only the prompt text can therefore return numerically incompatible state even when the text looks identical. [Single-node optimization](05-single-node-optimization.md#pagedattention-makes-sequence-memory-non-contiguous) returns to allocation, sharing, and tenant boundaries.

## Inference reuses weights but still grows state

Training computes gradients and stores optimizer state plus activations needed for backpropagation, the calculation that determines how weights should change. Inference normally skips those structures. Autoregressive serving still retains the attention key and value tensors calculated for prior tokens so the next step does not recompute the entire prefix. This retained state is the **KV cache**.

The first model pass over all known prompt tokens is **prefill**. It creates their KV entries and produces the scores used for the first generated token. Each later model pass is a **decode step**: it processes the latest chosen token, reads prior KV entries, and produces scores for one more token.

One request can therefore be cheap in weight memory and expensive in sequence state. Prompt length drives the initial pass; output length drives the number of serial decode steps, which is why two requests with the same total tokens can produce different user-visible latency.

## Attention changes cost with sequence length

A Transformer layer normally computes several sets of query, key, and value projections in parallel; each set is an **attention head**. The model combines the head outputs afterward. A query is matched numerically against the keys of allowed positions, and the corresponding values supply the information mixed into the result. These labels describe the calculation, not a database lookup.

The query-key dot products become attention scores. A causal mask blocks future positions, and softmax converts the remaining scores into non-negative weights that sum to one. Multiplying those weights by the value vectors produces the head output. The scale factor is the square root of the head dimension; without it, dot products grow with dimension and can push softmax into ranges with tiny gradients and poor numeric behavior.

```text
scores = (Q x K^T) / sqrt(head dimension)
weights = softmax(mask(scores))
attention output = weights x V
```

Attention is only part of a Transformer layer. A feed-forward sublayer applies learned transformations independently to each token position, normalization controls numeric scale, and residual connections add a sublayer's input back to its output. During serving, all of those operations consume compute and memory even when an attention-only complexity statement sounds favorable.

For a four-token causal prompt, the four positions can inspect 1, 2, 3, and 4 positions respectively, for 10 permitted query-key pairs. A dense prefill still has quadratic attention arithmetic in prompt length even when a tiled kernel avoids materializing the full score matrix in high-bandwidth memory (HBM), the GPU's main device-memory pool. When the fifth position is processed during cached decode, its new query attends to four stored keys plus the key computed for the current token: five scores in that row. The server reuses prior KV state instead of recomputing the old 10 pairs.

This distinction matters in an interview. Prefill attention grows roughly with the square of prompt length, while the attention part of one cached decode step grows linearly with the context already stored. Projection layers and the feed-forward network still run too, so those complexity statements do not predict wall-clock latency by themselves. [The request-lifecycle note](02-serving-lifecycle.md#kv-cache-grows-with-the-sum-of-cached-tokens) turns the retained keys and values into a memory estimate.

## Not every inference workload is autoregressive text generation

Before choosing a server or accelerator, write one workload record: request shape, state retained while it runs, safe batching axis, useful throughput unit, user-visible latency phases, model-and-hardware fit, and overload behavior. “Inference” alone supplies none of those answers. The six classes below are starting models; an actual architecture can combine them.

### Online autoregressive generation

This is the deepest worked path in the later notes. A caller waits while a causal language model or another autoregressive decoder chooses one new symbol after another.

- **Request shape:** Tokenized prompt or messages, maximum output, decoding settings, and possibly media-derived embeddings, tool schemas, or a selected adapter. Prompt and output lengths vary independently.
- **Retained per-request state:** KV cache for accepted positions, scheduler and sampler state, output buffers, and stream or cancellation state. An encoder-decoder model also retains encoder output while its decoder generates.
- **Batching axis:** Prompt tokens during prefill and active sequences during repeated decode. Continuous batching can add and remove sequences between steps; length, adapter, and cache availability constrain which work combines well.
- **Useful throughput unit:** Input tokens per second and output tokens per second that both meet quality, TTFT, and delivered token-spacing targets. Requests per second alone hides token shape.
- **Latency phases:** Validate and tokenize, wait, prefill to the first token, repeat decode and delivery, then release state. A slow client can make delivery outlive device work.
- **Accelerator fit:** Weights, KV blocks, workspaces, and temporary activations must fit. Memory bandwidth, attention and matrix kernels, inter-device collectives, and cache capacity can each become the limit.
- **Characteristic failure or overload:** Long prompts exhaust KV memory or delay short work; too many active sequences stretch decode cadence; a dead rank stalls a tensor-parallel group; disconnects can leave orphaned work; unbounded queues turn an overload into expired requests.

### Embeddings and reranking

An embedding model maps one input into a fixed-width vector. A reranker scores a query-document pair or a group of candidates. Both usually finish after one forward pass instead of generating a long continuation.

- **Request shape:** One or more token sequences for embeddings, or query-document pairs for reranking. Candidate count and sequence length can vary widely even when the response contains only small vectors or scores.
- **Retained per-request state:** Temporary layer activations until the forward pass completes, plus pooled vectors or scores until delivery. There is normally no autoregressive KV cache retained across output steps.
- **Batching axis:** Sequences, pairs, and total padded tokens. Bucketing similar lengths reduces padding; a large candidate list may be split into bounded pair batches.
- **Useful throughput unit:** Input tokens, sequences, or query-document pairs per second at the required embedding or ranking quality and latency. If vectors are persisted, successful vector writes belong in the completed-work boundary.
- **Latency phases:** Tokenize, queue and form a batch, run one forward pass, pool or score, normalize or serialize, then optionally write to a vector store. Preprocessing or the downstream store can dominate the model.
- **Accelerator fit:** Weights and peak batch activations matter more than long-lived request state. Matrix kernels favor dense batches, while CPU tokenization, host-to-device copies, and result storage can leave an accelerator waiting.
- **Characteristic failure or overload:** One huge candidate set or padded batch causes OOM; length skew wastes compute; queueing for a large batch violates interactive latency; preprocessing drift changes vectors; vector-store backpressure accumulates outputs after the accelerator has finished.

### Streaming speech

For streaming speech recognition, audio arrives over time and the service returns partial and final hypotheses. Other speech models differ, so name whether the model is truly streaming, operates on overlapping chunks, or reruns an offline encoder over an expanding window.

- **Request shape:** An ordered stream of audio chunks with sample rate, channel format, language or task options, and an end-of-stream signal. Duration is unknown when the stream begins.
- **Retained per-request state:** Jitter and feature buffers, model-specific encoder or decoder state, partial hypotheses, timestamps, and stream-order metadata. A chunked offline model may retain overlap and reprocess it rather than carrying recurrent state.
- **Batching axis:** Audio frames or chunks from concurrent streams, usually under a small microbatch deadline. Chunk cadence, duration, and model state limit how long the server can wait for a larger batch.
- **Useful throughput unit:** Audio seconds processed per wall-clock second, concurrent real-time streams, or real-time factor, all at a stated word-error and partial/final latency boundary.
- **Latency phases:** Receive and jitter-buffer audio, decode bytes and extract features, run encoder and decoder work, revise partial text, then finalize. End-of-utterance detection is a separate user-visible clock.
- **Accelerator fit:** Feature extraction may run on CPU while encoder or decoder tensors run on an accelerator. Tight chunk deadlines can keep batches small, so a theoretically fast GPU may have poor utilization unless enough synchronized streams exist.
- **Characteristic failure or overload:** Missing or reordered chunks corrupt state; slow ingestion grows buffers; a large microbatch delays every partial result; one long stream monopolizes state; partial-result revisions violate an assumed append-only API; overload pushes processing behind real time until latency grows without bound.

### Vision and image classification

A classifier commonly receives a decoded image tensor and returns class scores. Detection, segmentation, and video models add different output and temporal state, so pixels, frames, and preprocessing belong in the workload description.

- **Request shape:** Compressed bytes or an image tensor with height, width, channels, and normalization rules. Video adds frame count or cadence; detection adds variable-size result sets.
- **Retained per-request state:** Decoded pixels and temporary activations during the forward pass, followed by labels, embeddings, boxes, or masks. A single-image classifier normally releases model state after that pass; a temporal video model may retain frame history.
- **Batching axis:** Images, pixels, or frames, often bucketed by resolution. Resizing everything to one shape simplifies batching but changes accuracy and may waste work.
- **Useful throughput unit:** Images, frames, or megapixels per second that meet accuracy and latency requirements. Count successfully decoded and postprocessed outputs, not only device forwards.
- **Latency phases:** Validate and decode, resize or crop, normalize, copy to the device, run the model, postprocess, and serialize. Image decoding and transfer can be the critical path.
- **Accelerator fit:** Weight and activation memory grow with architecture, batch, resolution, and frame count. Convolution or attention kernel support matters, but CPU codec capacity and device-copy bandwidth may set fleet size first.
- **Characteristic failure or overload:** Malformed or decompression-bomb inputs consume CPU or memory; an unexpected resolution causes OOM; padding wastes most of a batch; preprocessing mismatches training and silently reduces accuracy; batch formation delays small interactive images behind large ones.

### Diffusion image and video generation

A diffusion pipeline starts from a latent representation and updates it repeatedly according to a denoising schedule. It does not produce one vocabulary token per model pass, even when text conditions the output.

- **Request shape:** Prompt and negative prompt, output dimensions, denoising-step count, seed, guidance and scheduler settings, plus optional source images, masks, or video duration.
- **Retained per-request state:** Latent tensors, text conditioning, scheduler position, temporary activations, and optional image or video conditioning. Resolution and frame count can dominate this state.
- **Batching axis:** Latents with compatible model, dimensions, step schedule, and conditioning shape. Requests at different denoising steps do not automatically form an efficient batch.
- **Useful throughput unit:** Accepted images, megapixels, frames, or video-seconds per second at a declared quality, latency, cost, and energy boundary. A raw denoising-step rate is an internal metric.
- **Latency phases:** Validate and encode conditions, initialize the latent, repeat denoising steps, decode through an image or video decoder, apply required checks, encode media bytes, and store or deliver them.
- **Accelerator fit:** Model weights, latent and activation sizes, attention at the chosen resolution, and sometimes several pipeline components must coexist or be staged. Video raises both temporal compute and retained-state pressure.
- **Characteristic failure or overload:** Large dimensions or step counts monopolize the worker; incompatible shapes fragment batches; cancellation discards many completed steps; latent or activation growth causes OOM; media encoding or object storage backs up after device work; retrying with the same seed may still be non-identical if the execution path is not deterministic.

### Asynchronous batch inference

Batch inference is an execution contract rather than a model family: embeddings, generation, vision, speech, or diffusion can all run as jobs whose caller does not wait on one connection. It changes scheduling and recovery even when the inner model calculation is unchanged.

- **Request shape:** A versioned manifest or object-store prefix, model bundle, per-record options, job deadline, output destination, and idempotency identity. Jobs may contain millions of uneven records.
- **Retained per-request state:** Durable job and shard progress, input and output lineage, retry attempts, checkpoints, and completion markers. Each running record also has the model-family state described above.
- **Batching axis:** Records can be globally bucketed by model, length, resolution, or other shape because the scheduler has more time to form efficient batches. Shards must remain bounded and independently retryable.
- **Useful throughput unit:** Accepted records, tokens, audio-hours, images, or another product unit per hour, plus completion before the deadline and cost or energy per accepted result. Device utilization alone does not show that the job finished correctly.
- **Latency phases:** Discover and validate inputs, partition and stage data, queue shards, execute, checkpoint, write results, verify completeness, and publish the final manifest. Job makespan includes the slowest and retried shards.
- **Accelerator fit:** The scheduler can favor high utilization, cheaper capacity, or preemptible workers when the deadline allows. Model loading and input locality determine whether short shards spend more time staging than computing.
- **Characteristic failure or overload:** Poison records crash every retry; a few stragglers control makespan; unbounded jobs starve urgent work; worker loss creates duplicate effects; partial outputs look complete; retry storms overload storage; changing an alias halfway through a job mixes model versions.

The comparison changes how later notes should be read. Artifact identity, shape and dtype accounting, measured batching, deadline-aware admission, phase telemetry, cancellation cleanup, quality gates, and rollback apply to all six. Token counts, KV blocks, prefill/decode split, TTFT, and token spacing belong specifically to autoregressive generation. Translate those concepts into pixels, audio time, latent steps, forward-pass batches, or durable job shards before carrying an LLM design into another workload.

## The checkpoint and tokenizer form one executable contract

A checkpoint is not a self-contained text service. The server also needs the architecture configuration, tokenizer vocabulary and rules, special-token IDs, prompt template, numeric precision, and decoding settings. Changing any one of these inputs can change token counts or output even when the stored model weights stay fixed.

Causal language models return a score, called a logit, for every vocabulary item at each output position. A decoding rule converts the final-position logits into a token choice. Greedy decoding selects the highest score. Temperature rescales logits before sampling, and top-k or top-p rules restrict the candidate set. These rules change output behavior, not the matrix dimensions of the model itself.

- Input contract: normalized text or messages, template, tokenizer, and special tokens.
- Execution contract: architecture, weight tensors, dtype, device placement, and attention rules.
- Output contract: sampling parameters, stop conditions, token limits, and streaming format.

## Count prompt work and decode work separately

Suppose tokenization produces 1,500 prompt tokens and the service generates 300 more. The prefill phase processes the known 1,500-token prefix, creates KV state for those positions, and yields logits used to choose the first output token. Producing the other 299 tokens then requires up to 299 dependent decode model passes. Batching can process several sequences together, but it does not remove that dependency inside one sequence.

At completion, the logical sequence can contain 1,800 tokens. The allocator may reserve cache space for that length, although the final chosen token does not need its own KV tensors if generation stops before another model pass. A second request with 300 prompt tokens and 1,500 output tokens reaches the same logical length but needs far more serial decode passes. Equal total-token count therefore does not imply equal latency, batch behavior, or scheduler cost.

_The upper bounds assume the request reaches its output limit and is not cancelled or stopped early._

```text
prompt = 1,500 tokens
maximum output = 300 tokens
prefill positions = 1,500
additional decode model passes <= 299
logical final length <= 1,800 tokens
```

## A plausible response can hide a broken serving path

Tokenizer drift is a direct correctness fault. If the server loads a vocabulary or prompt template that differs from the one used for the checkpoint, the request may still produce grammatical text while token IDs, special markers, and stop behavior are wrong. A missing end token can also consume the full output allowance and make an otherwise healthy GPU look slow.

Check correctness before speed. Keep fixed prompt fixtures with expected token IDs, verify the loaded artifact digests, and compare logits or deterministic outputs for a small reference set after every runtime change. Then record input tokens, generated tokens, stop reason, time to first token, time between tokens, cache use, and peak device memory. These measurements tell you whether a regression began in tokenization, prefill, decode, or allocation rather than treating total request time as one unexplained number.

### A useful first diagnosis

If token counts changed while the text fixture did not, inspect tokenizer and template identity. If counts match but outputs differ under deterministic decoding, inspect weights, precision, kernels, and runtime configuration.

## Summary

Inference capacity begins with tensor shape, dtype, tokenization, and model state rather than request count. A serving bundle is only reproducible when weights, architecture, tokenizer, prompt format, precision, and decoding settings are treated as one versioned contract.

- **Separate the model from the service.** The trained model maps numbers to numbers. The service authenticates, validates, schedules, allocates, executes, streams, measures, and cleans up one request around it.
- **Trace and count the token path.** Text becomes IDs, IDs become embeddings, layers produce logits, and a decoding rule selects one next token. The tokenizer controls context use, cost, stop behavior, and rate limits, so record input and output distributions.
- **Keep a tensor-shape ledger.** In the toy trace, `[1, 3]` token IDs become `[1, 3, 8]` embeddings, two `[1, 2, 3, 4]` attention-head tensors, and `[1, 12]` final logits. Real dimensions are larger, but every axis still needs a meaning and a memory owner.
- **Calculate static and request memory separately.** Tensor bytes equal element count times bytes per dtype. Weights stay mostly fixed, while KV state grows with active sequence length and concurrency.
- **Separate prefill from cached decode.** A four-token causal prompt contains 10 permitted attention pairs. Processing the fifth position adds one row over four prior keys plus its current key; cached decode does not recompute the old prompt pairs.
- **Include position in compatibility and cache identity.** Position encodings, RoPE configuration, scaling rules, and assigned position IDs affect attention. A prefix cache cannot safely reuse keys and values across incompatible position settings merely because the text matches.
- **Name the workload before applying its lifecycle.** Online generation, embeddings and reranking, streaming speech, vision, diffusion, and asynchronous batch work have different request state, batching axes, useful throughput units, latency phases, and overload failures. The later notes use LLM serving as the deepest worked example, not as a universal lifecycle.
- **Version and test the executable bundle.** Weights, architecture, tokenizer, template, special tokens, precision, and generation settings jointly determine behavior. Compare token IDs and deterministic fixtures before blaming model quality.
- **Count serial work as well as total tokens.** A 1,500-token prompt is processed in prefill; after the first output token, producing 299 more can require up to 299 dependent decode passes. Batching does not remove that dependency inside one sequence.

## References

- [PyTorch: tensor attributes](https://docs.pytorch.org/docs/stable/tensor_attributes.html)
- [Hugging Face: Tokenizers](https://huggingface.co/docs/tokenizers/main/en/index)
- [Attention Is All You Need](https://proceedings.neurips.cc/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html)
- [RoFormer: Enhanced Transformer with Rotary Position Embedding](https://arxiv.org/abs/2104.09864)
- [FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness](https://arxiv.org/abs/2205.14135)
- [Hugging Face Transformers: Encoder Decoder Models](https://huggingface.co/docs/transformers/model_doc/encoder-decoder)
- [vLLM: pooling models and token embeddings](https://docs.vllm.ai/en/stable/models/pooling_models/token_embed/)
- [Sequence Transduction with Recurrent Neural Networks](https://arxiv.org/abs/1211.3711)
- [An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale](https://arxiv.org/abs/2010.11929)
- [High-Resolution Image Synthesis with Latent Diffusion Models](https://arxiv.org/abs/2112.10752)
- [Hugging Face Diffusers: the denoising loop](https://huggingface.co/docs/diffusers/using-diffusers/write_own_pipeline)

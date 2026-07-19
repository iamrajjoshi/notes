---
title: AI inference infrastructure
description: Build an inference service from the first token and tensor through GPU execution, distributed serving, measurement, and safe rollout.
slug: ai-inference
order: 5
duration: 15 to 18 hours
---

## Scope

These notes assume you understand an HTTP request and a container, but they assume no machine-learning, CUDA, or distributed-inference knowledge. Start with AI1 and read in number order. AI2 follows one complete request before AI3 opens the GPU, so the hardware vocabulary always has a service-stage to attach to. Each later note uses that request path.

The goal is operational competence. By AI9, you should be able to trace one request through a model server, estimate its memory and token demand, choose a single- or multi-GPU layout, place it on Kubernetes, measure latency and energy, and explain rollout and failure behavior. Reading supplies the model; production work still requires hands-on profiling, incidents, and hardware access.

AI1 compares generation, embeddings and reranking, streaming speech, vision, diffusion, and asynchronous batch inference by request state, batching, latency, throughput unit, and failure mode. The remaining notes take autoregressive language-model serving as the deepest end-to-end case; they teach a reusable measurement and operating method, not a complete production curriculum for every model family.

Engine features, Kubernetes maturity labels, accelerator support, and command-line flags change by release. Check the linked project documentation before choosing a production configuration.

## Useful background

- No model-training experience
- No prior knowledge of tensors, Transformers, GPUs, CUDA, or collective communication
- No GPU for the calculations and architecture reviews; profiling exercises do require one

The Kubernetes chapter includes the small amount of cluster vocabulary it needs and links back to the cloud notes for the full control-plane path. Arithmetic uses bytes, seconds, requests, tokens, and rates, with the units shown in each worked case.

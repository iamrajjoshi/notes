---
title: Raj's Notes
description: Notes Raj is collecting, mostly about software systems, infrastructure, databases, AI inference, and agent engineering.
---

## Reading path

The collection order is intentional. [Cloud infrastructure](01-cloud-infrastructure/INDEX.md) starts with the boundaries around a production application; [low-level infrastructure](02-low-level-infrastructure/INDEX.md) then opens the Linux, hardware, container, and virtual-machine layers hidden beneath those services. [Distributed systems](06-distributed-systems/INDEX.md) adds independent clocks, partial failure, replication, and coordination, and [data systems](07-data-systems/INDEX.md) applies those mechanisms to storage engines and databases.

[System design](03-system-design/INDEX.md) combines the earlier mechanisms into an interview and production-design method. [AI inference infrastructure](04-ai-inference/INDEX.md) specializes that method for model serving and GPUs, while [harness engineering](05-harness-engineering/INDEX.md) starts at the model boundary and builds the runtime that gives an agent context, tools, durable state, verification, and operating controls. A reader can start with one specialty; each collection index names the background needed and points to slower explanations when a lower layer matters.

---
title: Cloud infrastructure
description: AWS compute and storage, Kubernetes control systems, networking, queues, deployments, reliability, and observability.
slug: cloud-infrastructure
order: 1
duration: 19–21 hours
---

## Scope

How an application becomes a production service: first the internet and AWS boundaries around it, then containers and Kubernetes, scheduling, managed container platforms, asynchronous work, and day-two operation. The notes are sequential. Each product is introduced before its failure modes or operating details. Worked cases use a fictional bookshop whose names, values, and repository layouts exist only in these notes. The final sequence is [infrastructure as code and GitOps](09-infrastructure-as-code-and-gitops.md), [production reliability and capacity](10-production-operation.md), then [shared production services](11-shared-production-services.md).

## Useful background

- Comfort reading TypeScript, Python, and YAML
- Basic command-line and Git experience
- Experience building an ordinary web application
- No AWS, Kubernetes, Kafka, Celery, or Linux-operations experience required

## Choose the asynchronous shape before the product

An HTTP request keeps the caller waiting for one response. Asynchronous work breaks that timing dependency, but the replacement contract must say whether one worker or many subscribers need each item, how long the system retains it, who acknowledges progress, and whether old work can be replayed.

| Needed shape                                                                                      | Mechanism                                                                                       | Concrete examples                                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| One job should be claimed by one worker and redelivered after an incomplete attempt               | Competing-consumer queue with a lease or visibility timeout and explicit acknowledgement        | [Amazon SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html); RabbitMQ queues |
| One publication should be pushed independently to several subscribers                             | Publish/subscribe topic; put a durable queue behind each subscriber that needs isolated retries | [Amazon SNS](https://docs.aws.amazon.com/sns/latest/dg/welcome.html), often fan-out to SQS                                            |
| Events should be matched by content and routed to service targets                                 | Event bus plus rules, target permissions, retries, and a dead-letter owner                      | [Amazon EventBridge](https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-rules.html)                                          |
| Consumers need a retained ordered history that they can reread at their own positions             | Partitioned event log                                                                           | Kafka; CI7 derives its brokers, topics, partitions, offsets, and consumer groups                                                      |
| Application code needs task declaration, worker pools, retries, and result handling over a broker | Task framework                                                                                  | Celery; CI8 separates the framework from Redis, RabbitMQ, SQS, or another broker                                                      |
| A multi-step operation must resume from persisted boundaries after a process restart              | Durable workflow                                                                                | CI11 separates workflow history from worker lifetime, external-effect idempotency, stuck-work repair, and retention                   |

These categories can be composed. An SNS topic can fan out into several SQS queues; a worker framework can consume a queue; a database outbox can feed a log. None removes duplicate-delivery or ambiguous-outcome handling. The owner still needs a stable operation ID, an idempotent effect or reconciliation path, bounded retries, dead-letter policy, and queue-age alarms.

## Optional practice ladder

Reading can supply a model of the system, but operating skill requires evidence from a running one. Complete each milestone only after reading the linked notes; the artifact in the last column is the proof to keep.

| Milestone                   | Exercise                                                                                                                                                                                                                                                                 | Evidence                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| 1. Trace one service        | Run a small HTTP service and follow one request from name resolution and connection setup to a dependency call. Use [cloud foundations](01-cloud-foundations.md) and [the kernel boundary](../02-low-level-infrastructure/01-kernel-boundary.md) to label each boundary. | A request-path diagram plus one trace or log that ties the layers together                   |
| 2. Package and schedule it  | Build a container image, deploy it to a disposable local Kubernetes cluster, and explain the Pod, Deployment, Service, node, and control-plane objects involved.                                                                                                         | Manifests in version control and a short object-to-process map                               |
| 3. Observe overload         | Use [production operation](10-production-operation.md) to define one latency or availability SLO, generate increasing offered load, and record throughput, latency, errors, queueing, and the first saturated resource.                                                  | A load-test graph and a written capacity limit with units                                    |
| 4. Break a boundary         | Introduce one network, scheduling, resource, or readiness failure. Diagnose it from the user symptom toward the failing layer before reverting it.                                                                                                                       | An incident timeline containing hypothesis, evidence, repair, and a prevention check         |
| 5. Prove state recovery     | Write data to a disposable database, create a backup, delete or corrupt the working copy, restore it elsewhere, and verify application-level invariants rather than only file existence.                                                                                 | Restore commands, elapsed recovery time, and a validation query or test                      |
| 6. Reconcile infrastructure | Use [infrastructure as code and GitOps](09-infrastructure-as-code-and-gitops.md) to provision a disposable resource from code, review the plan, apply it, create controlled drift, reconcile or import it, and practice recovering the state metadata.                   | A saved plan summary and a state-recovery note with secret values removed                    |
| 7. Defend a design          | Work through an unfamiliar prompt using the ordered artifacts in [frame the problem](../03-system-design/01-frame-the-problem.md), then repeat under the interview timing in [interview studios](../03-system-design/11-interview-studios.md).                           | A diagram, capacity sheet, failure trace, and scored rubric                                  |
| 8. Profile inference        | Serve one fixed model bundle, establish an output-quality fixture, replay a stated workload, find the first limit, and test one rollout or device-loss response using the [AI inference notes](../04-ai-inference/INDEX.md).                                             | Quality and performance results tied to the exact model, engine, hardware, and configuration |

Use disposable environments and non-sensitive data. A successful run is not enough: retain the commands, measurements, assumptions, and recovery evidence needed for another person to reproduce the conclusion.

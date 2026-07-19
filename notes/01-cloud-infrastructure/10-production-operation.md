---
title: "Production operation: reliability, observability, and capacity"
description: Define service evidence, tune autoscaling, plan capacity and recovery, and review a production system in a fixed order.
slug: production-operation
order: 10
identifier: CI10
duration: 80 min
difficulty: Advanced
tags:
  - autoscaling
  - SLO
  - observability
  - disaster recovery
  - capacity
  - efficiency
---

## Working model

Production is a set of nested feedback loops. Work creates demand, controllers adjust supply, telemetry reports service behavior, and operators decide when to continue, halt, degrade, recover, or change the design.

## Define “good” before choosing dashboards

A service-level indicator (SLI) is a measured property of service behavior, such as the fraction of eligible requests that succeed or the fraction that finish within a latency threshold. A service-level objective (SLO) sets the target over a window. An error budget is the allowed miss: a 99.9 percent success objective over 30 days permits 0.1 percent of eligible requests to fail under that definition. The exact numerator, denominator, exclusions, and measurement point belong in the contract.

Use more than an average. Request rate, error rate, latency distributions, and saturation show different failure shapes. A p99 latency of 400 ms means 99 percent of measured requests completed at or below 400 ms under that sample definition; it does not describe the slowest request or explain why the tail grew. Queue age, database wait, memory pressure, and dependency budgets often expose saturation earlier than host CPU.

Tests answer narrower questions:

- A load test checks a stated traffic and data shape against latency and error objectives.
- A stress test keeps increasing pressure to find the first exhausted boundary and the degraded behavior after it.
- A soak test holds realistic work long enough to expose leaks, compaction, queue growth, or slow resource exhaustion.
- A failure exercise removes a dependency, node, zone path, credential, or recovery component to test detection and repair. A disaster-recovery exercise must also prove restored data meets RPO and service returns within RTO.

Keep versions, topology, dataset, request mix, cache state, duration, and client behavior with the result. One clean synthetic run does not establish production readiness for a different load shape.

## Autoscaling is a delayed control loop

A Horizontal Pod Autoscaler (HPA) samples resource, custom, or external metrics and changes desired replicas. A worker backlog metric often matches demand better than CPU, but only if its aggregation and target describe sustained pressure. Startup time, metric delay, stabilization windows, and scaling policies determine whether the loop catches up or oscillates.

Node autoscaling is another loop underneath it. Pending Pods trigger supply, node startup takes time, and scale-down disrupts work. Reserve warm headroom when cold-start cost is user-visible; otherwise make the economic trade explicit. A Pod target also needs a downstream budget. Creating more replicas cannot increase database connections, Kafka partitions, external-provider quota, or address space that does not exist.

Write the loop before choosing its metric:

```text
observed demand → desired replicas → pending and starting Pods → ready capacity
       ↑                                                   ↓
       └──────────── latency, errors, queue age, saturation ┘

total response delay = metric delay + scaling decision + Pod start + node supply
```

A safe test changes one input at a time. Increase offered work, record the demand metric and desired replicas, then measure when new capacity becomes ready and when user latency recovers. Repeat during a rollout and a node loss; the steady-state graph does not expose those overlapping demands.

## Metrics find the shape; traces and logs find the instance

Metrics answer how much and how often across a population. Traces follow one causal path through services. Logs record discrete context and decisions. Propagate request, trace, message, and workflow identifiers so an engineer can cross those signals without putting user IDs or raw paths into metric labels.

Cardinality has a real memory and billing cost. Keep metric dimensions bounded, use traces or logs for high-cardinality detail, and attach service, environment, cell, and version consistently. An alert needs an owner, a user-impact statement, and an action; a graph alone isn't an incident response.

_A correlation plan for both synchronous and asynchronous work._

```text
request ID → edge log → load-balancer target → proxy access → application trace
application span → queue or log handoff ID → worker trace → durable effect
metric dimensions: service, environment, cell, version (never raw user ID)
```

The handoff deserves its own span or linked trace context because a background worker may start long after the request finishes. Keep the stable business operation ID beside the trace ID. A retry may create a new trace, while the operation ID still joins every attempt and the final effect.

## Compare cells before changing the whole system

A cell is a repeatable slice of routing, compute, and state with a bounded set of tenants or traffic. It limits impact only when those boundaries remain intact. Two nominal cells backed by one unpartitioned database or one shared deployment cohort can still fail together.

During an incident, compare the affected cell with an unaffected peer: recent version, dependency health, queue age, saturation, request mix, and error shape. Roll back a suspect change when evidence supports it; don't wait for a perfect root-cause story while impact grows. Fleet-wide mitigation makes sense when the same failure appears across cells, but a cell-local symptom should first preserve the healthy comparison group.

Cell routing also needs an explicit failure policy. Decide whether traffic stays pinned, moves to a spare cell, or returns an error when the assigned cell is unhealthy. Moving traffic can overload the survivor or cross a data boundary, so the route change needs capacity, state, and authorization evidence.

## High availability and disaster recovery answer different questions

High availability keeps a workload serving through expected component or zone failures. Disaster recovery restores it after an event that defeats the primary deployment, including regional loss or destructive data corruption. Recovery time objective (RTO) is the maximum intended recovery duration; recovery point objective (RPO) is the maximum intended data loss measured in time. Neither is proved by writing “multi-region” on a diagram.

Multi-AZ compute and database failover usually address a zonal event within one Region. Regional recovery may use backup and restore, pilot light, warm standby, or active deployment in more than one Region. Each step toward a shorter RTO usually adds standing cost, data-replication work, traffic-control complexity, and new split-brain risks. A replicated corrupt write can reach the recovery Region too, so versioned or point-in-time backups remain necessary.

Write the failure action before choosing the service. Record who declares disaster, which health signal triggers traffic movement, how credentials and configuration reach the recovery environment, whether the surviving data meets RPO, and how failback works. Test the procedure. AWS also recommends relying on data-plane operations during recovery where possible, because creating or reconfiguring resources adds a control-plane dependency at the worst time.

## Capacity includes quotas and downstream budgets

Start with units. Suppose a service receives 10,000 requests per second and mean service time is 150 ms. Under a stable average, roughly 1,500 requests are in flight before retries, queueing, or fan-out. That estimate sizes concurrency, not CPU; load tests still determine how many tasks or Pods meet the latency target. If a retry policy can make three attempts, the dependency must survive the retry budget or the caller needs backoff, jitter, a timeout, and a circuit breaker.

Follow the same arithmetic through database connections, cache operations, queue production and drain rate, network bytes, storage growth, and external rate limits. An HPA that creates 100 Pods cannot help when the subnet has no Pod addresses, the database pool is full, the Kafka topic has 12 consumer-owned partitions, or an AWS API quota blocks more capacity. Quota headroom must include a zone failure, node replacement, and deployment surge rather than only steady state.

Cost review belongs in the design because architecture creates the bill. Name idle provisioned capacity, cross-zone and cross-Region transfer, public IPv4, NAT processing, log and metric volume, retained replicas, object requests, database I/O, backup retention, and internet egress. Spot capacity fits interruptible work with checkpointing and graceful interruption handling; a cheaper instance does not repair a workload that cannot be interrupted.

Capacity plans need a forecast trigger. Record the current peak, measured growth, safe limit, acquisition lead time, and owner. Alerting at 80 percent means little when a quota increase takes three weeks and traffic reaches the limit in four days.

## Efficiency connects performance, cost, and energy

Infrastructure consumes energy while it performs useful work, and manufacturing hardware carries an impact before that hardware runs. A cloud customer usually sees requested instances, runtime, bytes, and service charges rather than facility power draw. CPU utilization is therefore not a kilowatt-hour meter, and a lower bill does not by itself prove a lower environmental impact.

Start with a workload unit that the product cares about: successful requests, processed records, completed exports, or model tokens under a stated quality and latency target. Then measure the compute time, memory, storage, and transferred bytes required per unit. An optimization is useful only if it preserves correctness and the service objective; compressing data can reduce network and storage work while increasing CPU, and aggressive batching can improve throughput while worsening individual latency.

The first fixes are usually plain engineering: delete unused resources, right-size requests and instances, scale idle capacity down where recovery time permits it, improve algorithms and data access, choose hardware that completes the work efficiently, and shorten unnecessary retention or transfer. Keep capacity needed for failures and rollout surge. Running every resource near 100 percent can reduce headroom enough to cause queueing, retries, and failed work, which wastes more resources.

AWS treats sustainability as a separate Well-Architected concern centered on resource use and efficiency. If an environmental target matters, record the target, measurement source, estimate boundaries, and uncertainty. Provider emissions reports, hardware energy counters, and application work metrics answer different questions; do not combine them into a precise claim without a documented method.

## Review a cloud design in a fixed order

| Question                          | Evidence expected in an architecture or interview answer                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What must the system do?          | Peak and steady traffic, latency target, payload size, data growth, consistency, RTO, RPO, security constraints, and team ownership                                        |
| How does one request enter?       | DNS, edge or content-delivery network, web application firewall where needed, TLS boundaries, ALB or NLB choice, health checks, timeouts, and the target-registration path |
| Where does code run?              | A reasoned choice among Lambda, ECS, EKS, EC2/Auto Scaling, and Fargate or managed instances; include startup and rollout behavior                                         |
| Where does state live?            | Database model, cache authority, S3/EBS/EFS contract, replication, backup, restore, retention, and encryption-key recovery                                                 |
| What leaves the synchronous path? | SQS or another task queue, SNS/EventBridge fan-out, Kafka/MSK event history, idempotency, retry ownership, poison work, and backpressure                                   |
| Who can do what?                  | IAM principal and condition, short-lived workload credentials, security groups, Kubernetes policy, secret delivery, KMS key policy, and audit trail                        |
| What breaks first?                | Zone and Region loss, dependency slowdown, quota exhaustion, hot keys, connection budgets, overload behavior, degraded mode, and tested stop conditions                    |
| How will it be operated?          | Infrastructure as code, deployment and rollback owner, SLO signals, logs/metrics/traces, alert action, capacity forecast, cost drivers, and DR exercise                    |

An answer does not need every AWS product. It needs one coherent path with named contracts, plus alternatives where a requirement could change the choice. Use [CI9](09-infrastructure-as-code-and-gitops.md) for the change path and [CI11](11-shared-production-services.md) for queue, connection-pool, and durable-workflow boundaries.

## Fictional case: compare one cell and its scaling loop

The bookshop has two independently deployed cells. DNS and an Application Load Balancer route a customer's requests to the assigned cell. Inside each cell, a Kubernetes Service sends traffic to `storefront-api` Pods, while an `export-worker` Deployment drains that cell's queue. This model and every value below exist only in this fictional example.

Suppose cell A's oldest export is 12 minutes old while cell B remains below 40 seconds. The worker HPA reads an external queue-age metric every 30 seconds and targets 60 seconds, with a range of 2 to 20 replicas. Karpenter can add nodes when new Pods remain Pending. The database permits 80 worker connections per cell, and each worker Pod can open four, so 20 replicas already consume the full worker allocation before rollout surge. The HPA maximum and database budget describe the same ceiling from different sides.

Start with the cell comparison. Check metric freshness, desired and ready replicas, Pending-Pod reasons, node claims, worker runtime, retry rate, and database wait. If cell A runs the same version as cell B but shows one hot customer partition, adding fleet-wide capacity wastes nodes and preserves the skew. If new Pods wait for nodes, trace node supply. If 20 ready workers spend most of their time waiting for database connections, reduce offered work or repair the database boundary before raising the HPA maximum.

## Summary

Production operation starts with a service contract and measures whether the running system still meets it. Scaling, alerts, recovery, and efficiency decisions must point to user behavior and a named resource boundary.

- Define the SLI population and threshold before the SLO. Keep workload shape, topology, dataset, version, and duration with every test result.
- Autoscaling includes metric delay, decision policy, Pod startup, node supply, and downstream capacity. Desired replicas are only one state in the loop.
- Metrics show population shape, traces follow one causal path, and logs retain discrete context. Stable operation IDs join retries that do not share one trace.
- Cells limit impact only when routing, compute, state, and deployment ownership respect the boundary. Preserve a healthy peer as an incident comparison.
- Multi-AZ availability and regional recovery address different failures. State RTO and RPO, protect recovery points from replicated corruption, and test traffic movement and failback.
- Capacity includes concurrency, database and queue limits, address space, quotas, rollout surge, failure reserve, growth, and acquisition time.
- Compare successful work with compute, memory, storage, and transfer demand. Utilization and price can reveal waste, but neither directly measures energy.
- The fictional two-cell case shows why an autoscaling maximum must agree with node supply and the downstream connection budget.

## References

- [Kubernetes Horizontal Pod Autoscaling](https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/)
- [AWS Well-Architected Reliability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html)
- [AWS disaster-recovery options](https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html)
- [AWS service quota guidance](https://docs.aws.amazon.com/wellarchitected/latest/framework/rel_manage_service_limits_aware_quotas_and_constraints.html)
- [AWS retry with backoff pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/retry-backoff.html)
- [AWS circuit breaker pattern](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/circuit-breaker.html)
- [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/)
- [Google SRE book: Service Level Objectives](https://sre.google/sre-book/service-level-objectives/)
- [AWS Well-Architected Framework](https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html)
- [AWS Well-Architected Sustainability Pillar](https://docs.aws.amazon.com/wellarchitected/latest/sustainability-pillar/sustainability-pillar.html)

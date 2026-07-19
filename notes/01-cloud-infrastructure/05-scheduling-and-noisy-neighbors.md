---
title: Scheduling, autoscaling, and noisy neighbors
shortTitle: Scheduling
description: Follow filter, score, and bind; then connect resource contracts to cgroups, placement rules, autoscaling, and contention.
collection: cloud-infrastructure
slug: scheduling-and-noisy-neighbors
order: 5
number: CI5
duration: 115 min
difficulty: Core
tags:
  - scheduler
  - bin packing
  - cgroups
  - QoS
  - autoscaling
---

## Working model

The scheduler packs reservations, not measurements. After placement, the kernel arbitrates real consumption; the gap between those two views creates most surprises.

## Questions this note answers

- Predict node eligibility from requests and placement constraints
- Explain how requests differ from limits and observed use
- Apply affinity, taints, topology spread, and priority for a stated goal
- Diagnose throttling, OOM kills, stranded capacity, and queue-driven scaling

## Translate the resource contract before scheduling it

A node's hardware capacity is not the amount available to Pods. Kubernetes reports **allocatable** CPU, memory, and other resources after reserving capacity for the operating system and node components. The scheduler compares Pod requests with that allocatable amount.

A **request** is reserved demand used for placement and, for some resources, contention policy. A **limit** is a runtime ceiling or enforcement input. Neither field reports current use. One Kubernetes CPU means one vCPU or physical core's compute capacity as reported by the node; `1000m` means one CPU and `250m` means one quarter. Memory is bytes, with binary suffixes such as `Mi` and `Gi`. Write units explicitly because `400m` CPU and `400Mi` memory describe unrelated quantities.

CPU, memory, storage bandwidth, network queues, cache, and kernel work remain shared on a node. A **noisy neighbor** is another workload whose use of one of those shared resources delays or destabilizes its peers. CPU and memory declarations help, but they do not isolate every queue or device.

```text
node capacity
  - operating-system and Kubernetes reservations
  = node allocatable

sum of scheduled requests must fit allocatable capacity
observed use later competes under kernel and cgroup policy
```

## Feasible first, preferable second

Scheduling starts with unscheduled Pods. Filter plugins remove nodes that lack requested resources or violate hard constraints. Score plugins rank what remains, reserve plugins protect the decision, and bind records the chosen node. A high score cannot rescue a node that failed a filter.

Requests drive the resource-fit calculation even when a container usually consumes less. This makes placement predictable, but inflated requests strand capacity while missing requests let a node accept more work than it can survive.

Namespace policy can reject the object before scheduling begins. A ResourceQuota caps aggregate namespace use such as requested CPU, memory, object counts, or selected storage. A LimitRange can set defaults or minimum and maximum values for individual Pods, containers, or claims. Admission against those policies is separate from whether any node can fit the admitted Pod.

> **Fictional case.** The bookshop keeps latency-sensitive `storefront-api` Pods on the default scheduler. Disposable image-resize Jobs may opt into a second scheduler profile that scores requested CPU and memory with `MostAllocated`, which helps empty a node for later scale-down. The profile name and every value below belong only to this exercise.

## Trace a fictional packing profile to Pod opt-in

The scheduler configuration fragment below defines the teaching profile `batch-packer`. It tells the `NodeResourcesFit` scoring plugin to prefer nodes with a larger requested-resource share. A complete second-scheduler deployment also needs its own process arguments, credentials, permissions, health checks, and leader-election identity; this fragment shows only the scoring contract.

```yaml
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: batch-packer
    pluginConfig:
      - name: NodeResourcesFit
        args:
          scoringStrategy:
            type: MostAllocated
            resources:
              - name: cpu
                weight: 1
              - name: memory
                weight: 1
```

An image-resize Job opts in with `spec.template.spec.schedulerName: batch-packer`; an ordinary Pod without that field uses `default-scheduler`. The profile name joins the running scheduler to the Pod. Resource requests supply the scoring inputs, while current dashboard use does not, so inspect the Pod requests before trying to explain a placement.

_The running scheduler profile and each workload opt-in form one contract._

## CPU slows down; memory can end the process

CPU requests influence shares during contention, while a CPU limit can impose a cgroup quota and throttle work. Memory requests guide placement; a memory limit becomes a hard ceiling that can lead to an OOM kill. Neither request nor limit measures current demand.

Kubernetes derives Pod quality-of-service (QoS) classes from request and limit patterns. QoS affects eviction order under node pressure, but it doesn't make a process immune to its own cgroup limit. Inspect throttling, working set, out-of-memory (OOM) events, and node pressure together.

For a Horizontal Pod Autoscaler (HPA) CPU-utilization target, utilization is measured against the relevant CPU request, not the limit. A missing request can leave utilization undefined for that Pod and prevent the metric from producing the expected scale decision. On clusters with Pod-level resources enabled, CPU and memory budgets can also appear at `spec.resources`; capacity and QoS inspection must include both Pod-level and container-level declarations.

## Spread what must survive; pack what can wait

Node affinity selects labeled hardware or zones. Taints repel Pods unless a matching toleration admits them. Pod affinity and anti-affinity express relationships among workloads, while topology spread constraints distribute replicas across domains. Every hard rule shrinks the feasible set, sometimes to zero.

Priority and preemption can clear lower-priority Pods for urgent work; they don't create nodes. HPA changes replica demand, and a node autoscaler such as Karpenter or Cluster Autoscaler changes supply. Queue age or depth often describes worker pressure better than CPU, provided the metric has a defined aggregation, freshness check, stabilization window, and downstream-capacity limit.

- Pack batch work to free whole nodes for scale-down.
- Spread serving replicas across failure domains.
- Reserve dedicated pools only when isolation or hardware justifies fragmentation.
- Set scale-down stabilization longer than a brief traffic lull.

## Autoscaling has separate demand and supply loops

The Horizontal Pod Autoscaler changes a workload's desired replica count from measured demand. The scheduler then tries to place those new Pods. If they do not fit, a node autoscaler may ask the cloud provider for more machines. Node startup, image pulls, initialization, and readiness all happen after the demand spike, so autoscaling cannot create instant capacity.

Every loop needs a metric, target, sampling interval, delay, minimum and maximum, and stop condition. CPU can fit a compute-bound request handler. Queue age or drain time often fits workers better because a deep queue with cheap handlers and a shallow queue with expensive handlers need different responses. Scaling also stops at downstream limits: database connections, API quotas, Pod IP addresses, or Kafka partition concurrency can become the actual ceiling.

## Reservations set the fit even when dashboards look empty

Assume each node has 4 vCPU and 16 GiB of allocatable memory after system reservation. A worker Pod requests 1.5 vCPU and 5 GiB. Two workers fit because they reserve 3 vCPU and 10 GiB. A third would request 4.5 vCPU and fail the CPU filter even though memory would remain. If the first two workers happen to use only 200 millicores each, the scheduler still sees their 3 vCPU of requests; observed idleness does not rewrite the reservation.

Now suppose the same Pod has a 2 vCPU limit and 6 GiB memory limit. Short CPU bursts above its available quota can be throttled without a restart. Crossing the memory limit can end a container with an OOM reason. The node can also experience pressure from page cache, kernel memory, image storage, or Pods without honest requests. Size from measured working sets and service behavior, then keep enough unreserved capacity for daemons, rollout surge, eviction recovery, and a failed node.

_Run the same arithmetic for every hard placement domain, including zones and dedicated pools._

```text
node allocatable: 4 vCPU, 16 GiB
worker request: 1.5 vCPU, 5 GiB
2 workers: 3 vCPU, 10 GiB → feasible
3 workers: 4.5 vCPU, 15 GiB → rejected by CPU fit
```

## Separate placement failure from runtime contention

For Pending Pods, read scheduler events and evaluate each hard condition: requests, node selectors, required affinity, taints and tolerations, topology spread, volume topology, host ports, quotas, and priority. `kubectl describe pod <name>` usually shows the filter summary. Compare that message with `kubectl get nodes` labels, taints, and allocatable resources. If a node autoscaler does not add capacity, look for an impossible constraint or provider limit before increasing a pool maximum.

For running Pods, compare CPU usage with throttled periods and throttled time, then compare memory working set, limit, container termination reason, and node pressure. A high CPU percentage with low request may trigger HPA while the process is not throttled; a low average CPU can hide a single-thread limit or long request queue. For noisy neighbors, group latency and resource signals by node and compare an affected node with a healthy peer. Check disk I/O, network, and kernel pressure too, because CPU and memory charts do not account for every shared resource.

- Unschedulable: events, feasible nodes, and the first hard constraint.
- CPU slowdown: quota, throttling counters, run queue, and application latency.
- Memory death: termination reason, working set, limit, node pressure, and recent allocation growth.
- Stranded capacity: requests, topology rules, fragmentation by shape, and system reservations.
- Scaling delay: metric timestamp, HPA condition, pending Pods, node-claim progress, and startup time.

## Summary

Scheduling and runtime resource control use different inputs. The scheduler admits Pods against declared reservations and hard placement rules; after binding, cgroups and the kernel decide how actual CPU, memory, I/O, and network demand contend.

- Filter plugins determine feasible nodes from requests and hard constraints; score plugins rank only that feasible set. A high score cannot override a failed filter.
- Scheduler fit uses requests, not current dashboard usage. For each resource, the sum of Pod requests must fit node allocatable capacity.
- One Kubernetes CPU equals one reported vCPU or physical core and `1000m`; memory uses byte quantities such as `Mi` and `Gi`. Node allocatable is capacity after system reservations.
- CPU requests influence entitlement under contention, while CPU limits can throttle. Memory requests guide placement, while crossing a memory limit can end the container.
- HPA CPU utilization divides observed use by the request, not the limit. Missing requests and stale external metrics can therefore block or distort scaling.
- Affinity, taints, volume topology, host ports, and topology spread all reduce the feasible set. Spread serving replicas across failure domains; pack delay-tolerant work when freeing whole nodes matters.
- ResourceQuota constrains aggregate namespace demand, while LimitRange constrains or defaults individual objects. Passing admission does not prove a node can fit the Pod.
- HPA changes desired Pod count; node autoscaling changes supply. Neither can satisfy an impossible selector, topology rule, quota, or hardware constraint.
- For Pending Pods, start with scheduler events and node labels, taints, allocatable capacity, claims, and quotas. For running Pods, compare throttling, working set, OOM reasons, pressure, and latency by node.
- Reserve capacity for system daemons, rollout surge, failed-node recovery, and startup lag. Apparent idle CPU does not reclaim an oversized request.

## References

- [Kubernetes scheduling framework](https://kubernetes.io/docs/concepts/scheduling-eviction/scheduling-framework/)
- [Resource management for Pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Kubernetes resource units](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/#resource-units-in-kubernetes)
- [Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)
- [Assigning Pods to nodes](https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/)
- [Taints and tolerations](https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/)
- [Pod topology spread constraints](https://kubernetes.io/docs/concepts/scheduling-eviction/topology-spread-constraints/)
- [Pod quality of service classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
- [Kubernetes resource quotas](https://kubernetes.io/docs/concepts/policy/resource-quotas/)
- [Kubernetes LimitRange](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Kubernetes scheduler configuration](https://kubernetes.io/docs/reference/scheduling/config/)
- [Kubernetes node resource scoring](https://kubernetes.io/docs/concepts/scheduling-eviction/resource-bin-packing/)

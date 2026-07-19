---
title: GPU orchestration on Kubernetes
shortTitle: GPU orchestration
description: Advertise, allocate, place, share, and autoscale accelerators while respecting hardware topology and startup time.
collection: ai-inference
slug: gpu-orchestration
order: 7
number: AI7
duration: 210 min
difficulty: Advanced
tags:
  - Kubernetes
  - DRA
  - MIG
  - Karpenter
---

## Working model

Kubernetes runs containers in Pods on a pool of machines called nodes. Its scheduler can place a GPU workload only after node software publishes devices as resources and the Pod requests them. Placement is still only the first step: runtime injection, model artifacts, engine load, distributed rendezvous, warm-up, and readiness must all succeed before the replica can serve traffic.

For inference, define the **serving group** first. A serving group is the complete set of processes and GPUs required for one logical model replica. It may be one four-GPU Pod or four coordinated one-GPU Pods. Capacity, readiness, failure, rollout, and autoscaling must operate on complete serving groups rather than accidentally counting partial ranks as replicas.

## Questions this note answers

- Trace an NVIDIA GPU node from driver initialization through a ready serving Pod
- Separate GPU Operator, driver, Container Toolkit or CDI, device-plugin, and DCGM responsibilities
- Request a GPU and diagnose missing allocatable capacity separately from failed runtime injection
- Calculate how CPU, memory, system reservations, and DaemonSets constrain GPU bin packing
- Place a four-rank tensor-parallel group without treating four arbitrary free GPUs as one fast fabric
- Compare a single four-GPU Pod with four coordinated one-GPU rank Pods
- Distinguish passthrough, vGPU, SR-IOV, MIG, and time slicing
- Convert measured token demand and cold-start time into complete warm serving groups

## Establish the Kubernetes path

A Kubernetes **cluster** has a control plane plus worker nodes. A controller turns desired state such as a Deployment into Pods. Each Pod is one scheduling unit containing one or more containers, declared resource needs, and placement constraints. The scheduler chooses a node for an unassigned Pod; the node's **kubelet** asks the container runtime to start its containers and reports status.

CPU and memory requests help the scheduler decide what fits. A GPU needs an additional integration because Kubernetes does not discover and prepare every accelerator type itself. A vendor device plugin or Dynamic Resource Allocation driver reports available devices and supplies the information needed to attach an allocated device to the Pod.

```text
Deployment -> Pod -> scheduler chooses node -> kubelet starts container
                 -> device integration prepares assigned GPU -> model loads
                 -> all ranks rendezvous and warm -> readiness passes
                 -> Service includes the Pod as an endpoint
```

Read [containers and Kubernetes objects](../01-cloud-infrastructure/02-containers-and-kubernetes-objects.md), [control planes and reconciliation](../01-cloud-infrastructure/03-control-planes-and-reconciliation.md), and [scheduling and noisy neighbors](../01-cloud-infrastructure/05-scheduling-and-noisy-neighbors.md) for the general mechanics. This note adds accelerator setup, allocation, topology, and long model startup.

## Make the node usable before scheduling the model

The NVIDIA GPU Operator is a Kubernetes operator that can deploy and reconcile a supported combination of GPU drivers, NVIDIA Container Toolkit, the NVIDIA device plugin, GPU Feature Discovery, MIG Manager, DCGM, and DCGM Exporter. It does not turn those components into one layer. Each still owns a distinct boundary:

| Component                            | What it owns                                                                                                                                                         | What success proves                                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Host GPU driver                      | Initializes the hardware, loads the kernel module, exposes device interfaces, and supplies host-side driver libraries                                                | The operating system can communicate with the GPU; a host `nvidia-smi` result does not prove that a container received a device |
| NVIDIA Container Toolkit or CDI path | Configures a compatible container runtime and describes the device nodes, mounts, and driver capabilities to inject                                                  | The chosen runtime can expose an allocated GPU inside a container; it does not advertise schedulable capacity                   |
| Kubernetes device plugin             | Registers with the kubelet, reports healthy devices, advertises an extended resource such as `nvidia.com/gpu`, and returns allocation data during container creation | Kubernetes can count and allocate the reported devices; the plugin does not install the host driver                             |
| DCGM and DCGM Exporter               | Collect device inventory, health, power, temperature, clock, error, and utilization telemetry and export configured fields                                           | Operators can observe the device; a monitoring sample does not make a Pod schedulable or ready                                  |
| GPU Operator                         | Reconciles the selected NVIDIA components and validates its supported installation path                                                                              | The declared node software converged; application model load and request readiness remain separate                              |

Some managed GPU images already contain a driver or Container Toolkit. In that case, configure the Operator not to install a duplicate component and verify the provider image, Operator release, driver, toolkit, plugin, Kubernetes, and container-runtime support matrix together. A default Operator installation is one path, not a guarantee that every cloud image and version combination is valid.

Follow one node through the complete path:

1. The machine boots, the host driver binds the GPU, and the host can inventory each GPU UUID.
2. The Operator reconciles the selected driver, toolkit, device-plugin, validation, and telemetry workloads. Preinstalled components are explicitly disabled in the Operator configuration rather than installed twice.
3. The device plugin discovers healthy devices, starts its service, and registers its resource name with the kubelet. The kubelet publishes capacity and allocatable counts in Node status.
4. A controller creates a Pod requesting the exact extended resource. The scheduler binds it only to a node whose remaining requests, taints, affinity, zone, and GPU count satisfy the declaration.
5. During container creation, the kubelet asks the device integration to allocate devices. The runtime consumes the returned device nodes, mounts, environment, or CDI names and creates the container with only the assigned devices.
6. The process records its visible CUDA ordinals, GPU UUIDs, PCI bus identities, rank mapping, driver, runtime, framework, and engine build before loading the model.
7. The engine loads the pinned model bundle, forms any distributed communicator, performs warm-up, and passes its startup and readiness contracts.
8. Only then does the EndpointSlice for the Service mark the Pod ready for ordinary traffic.

Use evidence from each boundary instead of treating `Running` as proof of service readiness. The resource and label names below match the example in this note; GPU Operator workload labels can vary by release, so list the installed objects before relying on a selector.

```bash
kubectl get daemonsets,pods -n gpu-operator -o wide
kubectl get nodes -o 'custom-columns=NAME:.metadata.name,CAPACITY:.status.capacity.nvidia\.com/gpu,ALLOCATABLE:.status.allocatable.nvidia\.com/gpu'
kubectl describe node gpu-a-01
kubectl logs -n gpu-operator -l app=nvidia-device-plugin-daemonset --tail=200 --prefix
kubectl logs -n gpu-operator -l app=nvidia-container-toolkit-daemonset --tail=200 --prefix

kubectl get pods -n inference -l app=textgen -o wide
kubectl describe pods -n inference -l app=textgen
kubectl get events -n inference --sort-by=.lastTimestamp
kubectl exec -n inference deploy/textgen -- nvidia-smi --query-gpu=uuid,pci.bus_id --format=csv,noheader
kubectl get endpointslices -n inference -l kubernetes.io/service-name=textgen
```

## Deploy one complete four-GPU serving group

The following manifest is structurally complete but illustrative. It assumes that the pinned image contains a wrapper and immutable example model at `/models/example`; the wrapper implements `/startupz`, `/readyz`, and `/drain`. Replace the image digest, resource measurements, node labels, taints, endpoints, and engine arguments with values validated in the target cluster. After the container starts, the startup probe allows up to 15 minutes for application initialization. That intentionally conservative number is separate from node boot and scheduling time; a real threshold should come from a measured high percentile.

One Pod is one TP4 serving group here, so Deployment replica count equals serving-group count.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: textgen
  namespace: inference
spec:
  replicas: 1
  selector:
    matchLabels:
      app: textgen
  template:
    metadata:
      labels:
        app: textgen
        inference.example.com/group-size: "4"
    spec:
      terminationGracePeriodSeconds: 180
      nodeSelector:
        inference.example.com/accelerator-class: tp4-node
      tolerations:
        - key: workload.example.com/gpu
          operator: Equal
          value: "true"
          effect: NoSchedule
      containers:
        - name: server
          image: registry.example.com/inference/vllm-wrapper@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
          args:
            - serve
            - /models/example
            - --tensor-parallel-size=4
            - --port=8000
          ports:
            - name: http
              containerPort: 8000
          resources:
            requests:
              cpu: "40"
              memory: 300Gi
              ephemeral-storage: 20Gi
              nvidia.com/gpu: "4"
            limits:
              cpu: "40"
              memory: 300Gi
              ephemeral-storage: 40Gi
              nvidia.com/gpu: "4"
          startupProbe:
            httpGet:
              path: /startupz
              port: http
            periodSeconds: 5
            failureThreshold: 180
          readinessProbe:
            httpGet:
              path: /readyz
              port: http
            periodSeconds: 5
            failureThreshold: 2
          lifecycle:
            preStop:
              httpGet:
                path: /drain
                port: http
---
apiVersion: v1
kind: Service
metadata:
  name: textgen
  namespace: inference
spec:
  selector:
    app: textgen
  ports:
    - name: http
      port: 80
      targetPort: http
```

The startup endpoint should stay false while artifacts, ranks, or warm-up are incomplete. Readiness should stay false whenever the group cannot accept new work, including during drain or after one rank fails. A liveness probe is deliberately absent: add one only after defining a condition that a process restart can repair. An aggressive liveness probe during model load or overload can repeatedly destroy expensive progress.

The `preStop` request begins application drain, but the application must also handle its termination signal, stop accepting new requests, and finish or cancel existing streams within `terminationGracePeriodSeconds`. Kubernetes starts the termination grace-period clock before executing the hook. The Service and application therefore need compatible drain semantics; sleeping blindly in a hook is not a substitute for observing live streams.

## Kubernetes schedules declared device resources

The device-plugin framework lets a node agent advertise extended resources and pass allocated device information to a container runtime. A Pod requests a whole integer count for the named resource; ordinary overcommit semantics do not apply to that extended resource. For a typical NVIDIA plugin resource, the request and limit can be `nvidia.com/gpu: 4`. If both are stated, they must match.

Dynamic Resource Allocation (DRA) models richer claims and device selection through Kubernetes APIs. Drivers publish devices in `ResourceSlice` objects, administrators define `DeviceClass` policy, and workloads consume `ResourceClaim` or `ResourceClaimTemplate` objects. The core `resource.k8s.io/v1` API reached generally available status in Kubernetes 1.34; current Kubernetes documentation marks DRA stable from 1.35. Optional alpha and beta capabilities continue to mature separately, and a vendor's DRA driver can have a narrower support policy than the Kubernetes API. Pin the cluster version, API version, feature gates, and allocation driver instead of treating one example manifest as timeless.

An extended-resource count says “four resources with this name.” It cannot select devices by attributes inside the request. DRA can express richer selection through claims, but only when a compatible driver publishes the required attributes and prepares the device. The NVIDIA DRA driver, for example, has its own versioned installation and GPU-allocation guidance; Kubernetes declaring DRA stable does not make every driver feature production-ready.

## Bin-pack every requested resource

Suppose an illustrative node has eight GPUs, 96 schedulable vCPUs before reservations, and 768 GiB of memory. Reserve 8 vCPUs and 32 GiB for the operating system, kubelet, container runtime, CNI, GPU Operator DaemonSets, logging, and monitoring. The workload pool is then 8 GPUs, 88 vCPUs, and 736 GiB.

The example TP4 Pod requests four GPUs, 40 vCPUs, and 300 GiB. Calculate the maximum count independently for every resource and take the minimum:

```text
GPU bound    = floor(8 / 4)       = 2 groups
CPU bound    = floor(88 / 40)     = 2 groups
memory bound = floor(736 / 300)   = 2 groups

node capacity = min(2, 2, 2) = 2 complete TP4 groups
```

This is an example, not a recommended request. Measure CPU, host memory, pinned memory, temporary files, image space, logging, network interfaces, and DaemonSet requests on the real node. A third group does not fit merely because a dashboard shows unused memory, and two groups do not fit if ephemeral storage, Pod count, network attachment, or a topology policy becomes the first constraint. Scheduler requests should reflect the measured high-water mark plus declared headroom; limits that are never representative only move failure from placement to runtime.

## A free GPU count does not describe the machine

Node labels, taints, affinity, topology managers, NUMA placement, PCIe layout, peer links, and network adapters decide whether a Pod's assigned devices form a useful group. Multi-Pod distributed jobs may also need gang semantics so partial placement does not leave expensive idle ranks.

Labels describe node properties, and node affinity or a selector requires the scheduler to match chosen node properties. A taint repels Pods unless they declare a matching toleration. The kubelet's Topology Manager can align CPU, memory, and devices within a suitable NUMA region when the configured policy and device hints permit it. It does not infer an engine's desired NVLink or NIC path from `nvidia.com/gpu: 4`.

**Gang scheduling** means admitting the required group of ranks together instead of leaving a partial group waiting with allocated GPUs. Kubernetes' default scheduler can place extended resources. Kubernetes 1.36 added alpha Workload and PodGroup APIs, an alpha PodGroup scheduling cycle, topology constraints, and optional Job integration for workload-aware scheduling. Because those APIs are alpha and gated, many production clusters still use an external controller or scheduler for gang placement. State the exact cluster version and group-admission implementation rather than implying that a label creates atomic placement.

> **Hypothetical example.** Suppose a team runs CPU embedding workers as a DaemonSet, which keeps one matching Pod on each eligible node. Those workers reserve CPU and memory before model Pods arrive. Keep them off GPU nodes unless locality justifies the lost headroom, and include their requests in bin-packing tests.

## Place one TP4 group on one measured fabric

Assume an illustrative eight-GPU server presents two measured four-device peer domains. GPUs 0–3 share the faster domain near NUMA node 0 and NIC `mlx5_0`; GPUs 4–7 form another domain near NUMA node 1 and `mlx5_1`. Real HGX, PCIe, and cloud topologies differ, so collect the actual map with provider inventory, device UUID and PCI identity, `nvidia-smi topo -m`, and link tests.

For one TP4 group, preserve a startup record like this:

| Rank | Assigned UUID    | PCI identity   | CPU/NUMA locality | Peer domain | Preferred NIC |
| ---- | ---------------- | -------------- | ----------------- | ----------- | ------------- |
| 0    | `GPU-example-a0` | `0000:41:00.0` | NUMA 0            | island A    | `mlx5_0`      |
| 1    | `GPU-example-a1` | `0000:42:00.0` | NUMA 0            | island A    | `mlx5_0`      |
| 2    | `GPU-example-a2` | `0000:43:00.0` | NUMA 0            | island A    | `mlx5_0`      |
| 3    | `GPU-example-a3` | `0000:44:00.0` | NUMA 0            | island A    | `mlx5_0`      |

The table is observed state, not a request syntax. With the ordinary extended resource, four allocated GPUs may not be the four UUIDs the engine expected. A compatible device plugin can provide NUMA hints to Topology Manager, and a compatible DRA driver may publish selectable attributes, but neither should be assumed without inspecting that exact implementation. Another defensible option is a node shape whose requested device set is already one validated peer domain.

There are two common process layouts:

| Layout                                            | Useful property                                                                                                       | New obligation                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One Pod requests four GPUs and starts four ranks  | The scheduler evaluates the four-device request as one Pod-sized fit; one Deployment replica equals one serving group | The later allocation path must still choose a valid four-device domain; one failed rank makes the entire Pod and serving group unready                                                                |
| Four Pods each request one GPU and start one rank | Each rank has an independent Pod identity and can use a multi-node launcher when the engine requires it               | A headless discovery or rendezvous path, stable rank assignment, and group-aware admission are required; ordinary scheduling can otherwise leave three ranks holding GPUs while the fourth is Pending |

Choose the first layout when one node contains the whole tensor group and the engine can spawn ranks locally. Choose the second only for a named need such as a supported multi-node topology or separate rank lifecycle, and then make its group controller part of the design. A Deployment with four replicas is not a gang scheduler.

The communication consequence can be large. Reuse the [distributed-inference example](06-distributed-inference.md#count-communication-at-the-boundary-you-plan-to-cross): each of four ranks receives 768 MiB, or 0.75 GiB, of useful payload for one all-gather. If measured effective bandwidth is 400 GiB/s inside the selected peer domain and 50 GiB/s across the wrong path, the payload-only lower bounds are:

```text
inside-domain lower bound = 0.75 GiB / 400 GiB/s = 0.001875 s = 1.875 ms
wrong-path lower bound    = 0.75 GiB /  50 GiB/s = 0.015000 s = 15.000 ms
```

These bandwidths are illustrative measurements, not hardware guarantees. Collective algorithms, forwarding, concurrency, protocol work, and synchronization add time. The calculation shows why a correct GPU count can still produce an unusable token cadence when a frequent collective crosses the wrong boundary.

Inspect the placed group rather than trusting its declaration:

```bash
kubectl get pods -n inference -l inference.example.com/group=tp4-a -o wide
kubectl describe pods -n inference -l inference.example.com/group=tp4-a
kubectl exec -n inference deploy/textgen -- nvidia-smi -L
kubectl exec -n inference deploy/textgen -- nvidia-smi topo -m
kubectl logs -n inference -l inference.example.com/group=tp4-a --all-containers --prefix
```

The process should also log logical rank, CUDA ordinal, GPU UUID, node, peer group, and communicator identifier. CUDA ordinals can be remapped inside a container, so an ordinal alone is not a durable device identity.

## Release partial groups instead of waiting forever

For four rank Pods, define a group-admission timeout before downloading full weights. Until all four ranks have devices, network reachability, and a consistent rendezvous record, none is ready and none accepts work. If rank 3 remains Pending past the timeout:

1. Preserve scheduler events and the unsatisfied constraint for rank 3.
2. Mark the logical group failed and remove it from routing.
3. Terminate ranks 0–2, abort their communicator setup, and release any ResourceClaims or other group-scoped allocations.
4. Retry the complete group with bounded backoff only after the placement constraint or capacity state changes.

If a running rank dies, the same serving-group boundary applies. Stop admission to the group, abort blocked collectives, decide which idempotent requests fit the retry budget, and recreate every rank from the pinned bundle and validated topology. Do not leave three survivors reporting readiness while they wait on a communicator that can no longer complete. NCCL RAS can identify incomplete or dead peers on supported releases, but the serving controller still owns routing and group replacement.

## MIG and time slicing make different promises

Whole-device passthrough gives a virtual machine direct ownership behind an input-output memory management unit (IOMMU) boundary. Vendor virtual GPU (vGPU) products expose supported mediated devices, while single-root I/O virtualization (SR-IOV) exposes virtual functions from a physical device. NVIDIA Multi-Instance GPU (MIG) partitions supported GPUs into instances with defined compute and memory resources; time slicing alternates software contexts on a device and does not create the same memory or performance isolation.

A Kubernetes resource name alone does not prove tenant isolation. Review the hardware mode, driver, memory boundary, reset and fault behavior, monitoring visibility, and threat model. Repeat the capacity and failure calculations using the actual advertised MIG profile or shared resource rather than counting it as equivalent to a full GPU.

## A provisioned node is still cold

Karpenter is a Kubernetes node-lifecycle project that reacts to pending Pod constraints and cloud capacity, then provisions suitable nodes. Other node autoscalers solve a similar capacity problem. The path can include instance acquisition, boot, driver and device-plugin readiness, image pull, model download, weight load, graph capture, cache fill, and application readiness.

Keep warm capacity or prefetch artifacts when the response target is shorter than that path. Scale on queue and admitted demand with model-aware limits; GPU utilization alone arrives late and cannot show work already rejected or timed out.

## Measure readiness as a chain, not a node event

Suppose cloud capacity acquisition and boot take 4 minutes, node registration and GPU driver readiness take 2 minutes, image pull takes 3 minutes, model download takes 5 minutes, and engine load plus warm-up take 1 minute. If every stage is serial, the first ready replica appears after 15 minutes. If image and model prefetch begin during node preparation, the elapsed time may approach the longest dependency path instead of the sum, but only a trace can show the overlap.

Now compare that path with a 60-second response target for a traffic burst. Reactive node provisioning cannot cover the burst by itself. The service needs some mix of warm groups, queued work with an honest deadline, smaller staged artifacts, local caches, or rejection. Record timestamps for Pod creation, scheduling, node claim, node ready, device allocatable, image ready, model bytes ready, engine loaded, ranks formed, warm-up complete, and readiness success. The interval between adjacent timestamps tells the team which cache or controller could matter.

_Use measured distributions for each stage; a mean startup time cannot protect a percentile target._

```text
serial cold path = 4 + 2 + 3 + 5 + 1 = 15 minutes
traffic response target = 1 minute
reactive node capacity arrives 14 minutes too late for that target
```

## Convert the burst into warm serving groups

Reuse the hypothetical measured envelope from the [production capstone](09-production-safety-and-capstone.md#choose-group-count-from-the-measured-envelope). One TP4 group sustains 18,000 input tokens/s and 4,500 output tokens/s while meeting the service targets. At 40 requests/s, the declared mix produces 48,000 input and 12,000 output tokens/s. Three groups meet both phase rates, and one complete failed-group spare makes four warm groups.

Now suppose the same request mix jumps to 80 requests/s. Doubling the rate doubles this illustrative token demand:

```text
burst input demand  = 96,000 tokens/s
burst output demand = 24,000 tokens/s

input groups  = ceil(96,000 / 18,000) = 6
output groups = ceil(24,000 / 4,500)   = 6
serving groups for measured work = max(6, 6) = 6
one failed-group spare = 6 + 1 = 7 warm groups

steady warm fleet = 4 groups
immediate burst fleet = 7 groups
additional groups needed inside the response target = 3
```

The 15-minute cold path cannot supply those three groups inside 60 seconds. They must already be ready, the service must hold an equivalent explicitly measured buffer elsewhere, or admission must reject work that cannot meet its deadline. The capstone allows only 200 ms of queueing within its TTFT example. At 80 requests/s that interval contains about 16 mean arrivals, not 15 minutes of cold-start demand, and request count still understates token and KV differences.

This result is not a universal recommendation to keep seven groups warm. It assumes the capstone's token mix, per-group replay result, 80-rps burst, one-group failure promise, and unchanged phase behavior. Measure burst duration and arrival correlation. If the burst lasts longer than the cold path, reactive nodes can help after they become ready; they still do not save requests whose deadlines expire before then.

## Build a token-aware capacity control loop

Separate model replica scaling from node provisioning. A model-aware controller should compute complete serving groups; a node autoscaler should supply machines for Pods the scheduler cannot place.

1. **Measure admitted work before the GPU.** Export input-token arrival rate, a bounded output-token reservation or tested forecast, oldest queue age, predicted service-start time, retained and reserved KV tokens, cancellations, and rejections. An engine's waiting-request count is useful evidence but is not a token-weighted capacity estimate.
2. **Calculate complete groups.** Use the greater of input and output phase demand, add the declared failure spare, and apply scale-up stabilization appropriate to the SLO. When one TP4 Pod is a group, a controller can set Deployment replicas. If four Pods form a group, use a group-aware controller; a vanilla HPA replica count cannot guarantee four-rank atomicity.
3. **Provision only compatible nodes.** Constrain the Karpenter NodePool to validated instance types, zones, capacity types, architecture, and permanent GPU taint. The provider-specific NodeClass must also select the correct image, storage, network, and bootstrap path.
4. **Hold new nodes behind a startup taint.** Declare the temporary taint in the NodePool, and assign one controller to remove it only after driver and device-plugin validation, the expected allocatable resources, a runtime device smoke test, and any required artifact prefetch succeed. Workload Pods tolerate the permanent GPU taint but not the startup taint.
5. **Route only ready groups.** A startup probe protects long initialization. Readiness stays false until all ranks, model shards, communicators, and warm-up checks pass, so the Service cannot count a cold Pod as capacity.
6. **Drain before scale-down.** Mark the group unready, stop new admissions, allow bounded streams to finish or cancel them according to the API contract, then terminate within the grace period. Configure Karpenter disruption conservatively for expensive warm nodes and use a PodDisruptionBudget as one voluntary-disruption guard, not as protection from node failure, direct deletion, or every rollout action.
7. **Preserve the spare.** Seven groups in the burst example include one failure spare. A failed group leaves six for measured demand; the spare is not free canary or consolidation capacity. A rollout or zone-failure promise requires its own additional arithmetic.

This illustrative NodePool fragment shows the two taint roles. It is not deployable without a provider-specific NodeClass, a real instance type, and the controller that removes the startup taint.

```yaml
apiVersion: karpenter.sh/v1
kind: NodePool
metadata:
  name: inference-gpu
spec:
  template:
    metadata:
      labels:
        inference.example.com/accelerator-class: tp4-node
    spec:
      requirements:
        - key: node.kubernetes.io/instance-type
          operator: In
          values: [gpu-8x-example]
      taints:
        - key: workload.example.com/gpu
          value: "true"
          effect: NoSchedule
      startupTaints:
        - key: inference.example.com/gpu-not-ready
          value: "true"
          effect: NoSchedule
  disruption:
    consolidationPolicy: WhenEmpty
    consolidateAfter: 30m
```

Karpenter treats declared startup taints as temporary and expects another component to remove them. If the taint remains, inspect the designated initialization controller and node evidence rather than launching more identical cold nodes. If a bootstrap system adds a temporary taint that the NodePool did not declare, Karpenter can repeatedly conclude that another node is needed; keep the provisioning and bootstrap declarations consistent.

## Find the first unsatisfied claim

A Pending Pod may have no node matching its resource name, count, taints, affinity, architecture, zone, or topology constraints. A DRA ResourceClaim may be unallocated because no published device matches its class and selectors. A scheduled Pod can still fail when the runtime cannot inject a device, the driver is unhealthy, or topology policy rejects the CPU and device combination. A Running container can remain unready while artifacts load, ranks wait, or graph capture fails.

Read scheduler events, ResourceClaim status, node allocatable resources, plugin or DRA driver logs, kubelet and container-runtime errors, and application readiness phases in that order. Compare the assigned GPU UUIDs and peer topology with what the engine expects. For a multi-Pod group, confirm that every rank was placed and can reach its peers before loading full weights. Repeatedly deleting Pods can hide a deterministic placement error and consume more model-download bandwidth without changing the unmet constraint.

Kubernetes 1.36 promotes allocated device status reporting to beta, which can expose `Unhealthy` or `Unknown` device state in Pod status for plugin- or DRA-managed resources. Older clusters and drivers may not report that state, so keep device-plugin health, DCGM, kubelet, and vendor logs in the diagnostic path.

### Host GPU works, but Node allocatable is zero

If a host-level inventory sees eight GPUs but Node capacity and allocatable omit `nvidia.com/gpu`, the application manifest is not yet the failing boundary. Check whether the device-plugin Pod was selected onto that node, whether it can reach the kubelet device-plugin socket, whether it registered the expected resource name, and whether it reports the devices healthy. Also check Operator validation, node labels, plugin configuration, and kubelet logs. Fixing a Service or increasing Pod replicas cannot create the missing Node resource.

### Node allocatable is correct, but the container sees no GPU

If Node allocatable is eight, the Pod is bound, and the container sees no device or driver library, scheduling has already succeeded. Inspect the Pod's assigned device evidence, the plugin's allocation response and logs, container-runtime configuration, CDI specification or runtime hook, runtime class if the selected installation requires one, and kubelet or runtime errors. Run the same minimal device query in the exact application image. Reinstalling the scheduler or relabeling the node does not repair runtime injection.

Use the smallest classification that fits the evidence:

- No allocatable device: inspect driver discovery, Operator state, plugin placement, registration, health, and kubelet publication.
- No placement: inspect requests, labels, taints, affinity, zones, quotas, topology, and autoscaler constraints.
- Placement but no device: inspect claim allocation, device-plugin allocation, Container Toolkit or CDI, kubelet, and container runtime.
- Device present but no service: inspect UUID and topology mapping, artifacts, memory, rank rendezvous, model load, graph capture, warm-up, and probes.
- Service ready but deadlines fail: inspect admission, queue age, batch shape, phase demand, collective path, and warm-group calculation before adding nodes.

## Summary

A GPU Pod becomes useful only after the host driver, device publication, scheduling, runtime injection, artifacts, rank formation, engine load, warm-up, and readiness all succeed. Operate the complete serving group, not an individual rank or an unready Pod.

- **Keep component boundaries explicit.** The driver initializes hardware; Container Toolkit or CDI enables runtime injection; the device plugin advertises and allocates devices; DCGM observes them; the GPU Operator reconciles the chosen components.
- **Prove the entire node-to-endpoint trace.** Node allocatable, scheduler events, plugin and runtime logs, in-container UUIDs, model startup, readiness, and EndpointSlice membership prove different boundaries.
- **Diagnose zero allocatable separately from failed injection.** A healthy host with no Node GPU resource points to publication or plugin registration. A scheduled Pod with no visible device points to allocation, CDI or runtime configuration, or injection.
- **Bin-pack every resource.** The worked 8-GPU, 96-vCPU, 768-GiB node holds two example TP4 groups only after system and DaemonSet reservations. GPU count alone cannot prove fit.
- **Map ranks to physical devices.** Record rank, GPU UUID, PCI identity, NUMA locality, peer domain, and NIC. CUDA ordinal alone can be remapped and does not describe topology.
- **Choose one-Pod or multi-Pod groups deliberately.** One four-GPU Pod makes the request one scheduling unit, although device selection still happens later. Four one-GPU Pods require rendezvous and group-aware admission; a four-replica Deployment is not gang scheduling.
- **Put time on the wrong boundary.** Moving 0.75 GiB at illustrative measured rates of 400 versus 50 GiB/s gives payload-only lower bounds of 1.875 versus 15 ms for one all-gather, before collective overhead.
- **Release partial groups.** If one rank cannot place or dies, preserve evidence, remove the whole group from routing, abort peers, release its allocations, and retry the complete group with a budget.
- **State the isolation model.** Whole-device assignment, MIG partitions, time slicing, vendor vGPU, and SR-IOV expose different memory, fault, performance, and security boundaries.
- **Size warm groups from token demand and failure promises.** The illustrative 80-rps burst needs six measured TP4 groups plus one failed-group spare. Because the cold path is 15 minutes and the response target is 60 seconds, the additional three groups must already be ready or excess work must be rejected.
- **Separate group scaling from node provisioning.** A token-aware controller computes complete groups; Karpenter or another node autoscaler supplies compatible nodes. Startup taints hold cold nodes, probes hold cold Pods, and drain prevents scale-down from silently cutting streams.

## References

- [Kubernetes: device plugins](https://kubernetes.io/docs/concepts/extend-kubernetes/compute-storage-net/device-plugins/)
- [Kubernetes: Dynamic Resource Allocation](https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/)
- [Kubernetes 1.34: DRA core APIs graduate to GA](https://kubernetes.io/blog/2025/09/01/kubernetes-v1-34-dra-updates/)
- [Kubernetes 1.36: workload-aware scheduling](https://kubernetes.io/blog/2026/05/13/kubernetes-v1-36-advancing-workload-aware-scheduling/)
- [Kubernetes: resource managers](https://kubernetes.io/docs/concepts/workloads/resource-managers/)
- [Kubernetes: Topology Manager](https://kubernetes.io/docs/tasks/administer-cluster/topology-manager/)
- [Kubernetes: liveness, readiness, and startup probes](https://kubernetes.io/docs/concepts/workloads/pods/probes/)
- [Kubernetes: Pod lifecycle and termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [Kubernetes: Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)
- [Kubernetes: disruptions and PodDisruptionBudgets](https://kubernetes.io/docs/concepts/workloads/pods/disruptions/)
- [NVIDIA GPU Operator: components](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/index.html)
- [NVIDIA GPU Operator: installation and configuration](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/getting-started.html)
- [NVIDIA Container Toolkit: CDI support](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/cdi-support.html)
- [NVIDIA GPU Operator: GPU sharing](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/gpu-sharing.html)
- [NVIDIA GPU Operator: DRA Driver for NVIDIA GPUs](https://docs.nvidia.com/datacenter/cloud-native/gpu-operator/latest/dra-intro-install.html)
- [NVIDIA NCCL: RAS diagnostics](https://docs.nvidia.com/deeplearning/nccl/user-guide/docs/troubleshooting/ras.html)
- [vLLM: parallelism and scaling](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/)
- [vLLM: production metrics](https://docs.vllm.ai/en/latest/usage/metrics/)
- [Karpenter: NodePools](https://karpenter.sh/docs/concepts/nodepools/)
- [Karpenter: disruption](https://karpenter.sh/docs/concepts/disruption/)
- [Linux kernel: VFIO device assignment](https://docs.kernel.org/driver-api/vfio.html)

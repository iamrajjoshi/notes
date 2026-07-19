---
title: Containers and the Kubernetes object model
description: Connect OCI images and Linux processes to Pods, controllers, configuration, and disposable workload instances.
slug: containers-and-kubernetes-objects
order: 2
identifier: CI2
duration: 105 min
difficulty: Foundation
tags:
  - OCI
  - containers
  - Pods
  - controllers
  - configuration
---

## Working model

An image is a packaged filesystem and launch contract. A container is a running process under isolation controls. A Pod is Kubernetes' smallest scheduling envelope.

## Kubernetes coordinates processes across machines

One machine can run a container directly. The harder production problem is keeping several copies alive across many machines, replacing failures, rolling out a new image, giving changing copies a stable network name, and attaching configuration or storage. Kubernetes addresses that problem through an API and controllers.

A **cluster** is one Kubernetes control plane plus its worker **nodes**. A node is a machine, physical or virtual, that runs workload processes. The control plane stores desired objects and makes cluster-wide decisions. A node agent called the kubelet receives assigned Pods and asks a container runtime to start them. [CI3: Control planes, etcd, and reconciliation](03-control-planes-and-reconciliation.md) follows that full path.

Kubernetes objects use a common shape:

- `apiVersion` selects the API group and version.
- `kind` names the object type, such as `Deployment`, `Service`, or `Pod`.
- `metadata` carries identity, namespace, labels, annotations, and versioning data.
- `spec` states the desired configuration supplied by a user or controller.
- `status`, when the type provides it, reports what the responsible controller currently observes. It is not another place to declare intent.

Labels are small identifying key-value pairs. Selectors use those labels to join objects, such as a Deployment to its Pods or a Service to its backends. A typo can produce valid YAML and valid objects that no longer select one another.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: orders
spec:
  replicas: 3
  selector:
    matchLabels:
      app: orders
  template:
    metadata:
      labels:
        app: orders
    spec:
      containers:
        - name: api
          image: registry.example/orders@sha256:<digest>
```

This declaration asks for three Pods. It does not say which nodes will run them, prove the image can start, or create a stable client address. Later controllers fill in those parts.

## An image isn't a tiny virtual machine

An Open Container Initiative (OCI) image contains ordered filesystem layers plus metadata such as the entrypoint, arguments, environment defaults, and platform. A runtime unpacks that image and starts a host-kernel process with namespaces, cgroups, capabilities, mounts, and a restricted root filesystem around it.

Those Linux terms describe separate controls. A namespace changes what the process can see, such as process IDs, mounts, or network devices. A cgroup accounts for processes and can apply CPU or memory policy. Capabilities split privileged kernel operations into narrower checks. None creates a separate kernel; [LL6: Containers and cgroups](../02-low-level-infrastructure/06-containers-and-cgroups.md) assembles the complete host-side path.

The process still makes system calls into the node's kernel. That shared kernel is why a container starts quickly and why its security boundary differs from a hardware virtual machine. Immutability applies to the image artifact; a running container can still write to its writable layer or mounted volumes.

A registry stores image manifests and layers. A tag such as `stable` is a movable name; a digest identifies exact content. Production promotion should preserve the tested digest, while signatures, provenance, vulnerability scanning, and a software bill of materials (SBOM) answer separate supply-chain questions. A multi-platform image index can point to different manifests for architectures such as `linux/amd64` and `linux/arm64`, so confirm the resolved platform when a Pod pulls on one node type but fails on another.

## A Pod is a colocated process group

Every container in a Pod lands on the same node and shares the Pod network namespace. They can use localhost, see the same Pod IP, and mount shared volumes when configured. They don't merge filesystems or process namespaces by default. A sidecar should exist only when tight lifecycle and locality are part of the design.

Regular init containers run to completion in order before application containers start. Kubernetes also supports restartable sidecars as init containers with `restartPolicy: Always`; they start in init order, keep running with the Pod, and no longer prevent a Job from completing after its main container finishes. Check the target cluster version before adopting that form because older clusters used only ordinary application containers as sidecars.

Pods are replaceable. Their names, UIDs, and IPs change as controllers create new instances. Put stable access behind a Service and durable state behind an external store or persistent volume; don't teach clients to remember a Pod.

> **Fictional case.** Each bookshop `storefront-api` Pod runs an API container and an OpenTelemetry Collector sidecar. The sidecar receives telemetry over localhost, but clients reach the replaceable Pods through a Service. Nothing about the Pod name or IP becomes durable application identity.

## Controllers own replacement and rollout

A Deployment manages interchangeable replicas through ReplicaSets. StatefulSets add stable ordinal identity and storage claims; DaemonSets target nodes; Jobs seek completion, while CronJobs create Jobs on a schedule. Pick the controller whose failure and completion semantics match the process.

ConfigMaps carry non-secret configuration. Secret objects improve API separation and role-based access control (RBAC), but base64 is only an encoding, and Kubernetes stores Secret data unencrypted in etcd unless the cluster enables encryption at rest. Keep credentials out of images and Git, restrict API and node access, encrypt the store, and arrange rotation before the first incident. Mounting a Secret or injecting it as an environment variable changes delivery, not its lifetime or authority.

- Deployment: stateless replicas and rolling replacement
- StatefulSet: ordered identity or one claim per replica
- DaemonSet: one eligible copy per node
- Job or CronJob: finite work now or on a schedule

## Read a fictional base as one workload contract

Suppose the bookshop keeps the following toy repository. These paths and values exist only in this note:

```text
deploy/storefront/base/kustomization.yaml
  ├─ deployment.yaml → Pod template, probes, resources, lifecycle
  └─ service.yaml    → selector and target port

deploy/storefront/overlays/dev/kustomization.yaml → two replicas and a dev image digest
deploy/storefront/overlays/prod/kustomization.yaml → four replicas and a prod image digest
```

The base includes a Deployment and Service. Both use the label `app: storefront-api`; the Service exposes port `80` and forwards it to the named container port `http` on port `8080`. The Pod template declares readiness at `/ready`, requests CPU and memory, and gives the process time to drain on termination. An overlay supplies a replica count and immutable image digest.

Render each overlay with `kubectl kustomize` and inspect the result before applying it. A changed image digest alters the Pod template and starts a rollout. A changed Service selector alters traffic membership without replacing Pods. A selector typo can therefore produce healthy Pods and an empty EndpointSlice—the Kubernetes object that lists a Service's current network backends—at the same time. CI4 follows that traffic path in full.

_The example is self-contained; build the field relationships rather than copying a deployment from another service._

## A Deployment changes ReplicaSets when its Pod template changes

Take a four-replica Deployment with `maxSurge: 1` and `maxUnavailable: 1`. During a rolling update, the controller may run at most five old-plus-new Pods and should keep at least three available under that strategy. It creates a new ReplicaSet for the changed Pod template, increases the new ReplicaSet, and decreases the old one while readiness determines which Pods count as available. Scheduling, image download, startup, and readiness can pause the sequence independently.

Only changes to the Deployment's Pod template start this rollout. Editing a ConfigMap that a Pod reads does not by itself change the template or replace existing Pods. Common patterns put a content hash or versioned ConfigMap name in the template so a reviewed configuration change also changes the template. Keep the old ReplicaSet long enough for rollback, but remember that rolling back a Deployment cannot reverse a database migration or restore an overwritten external object.

_Availability is based on Pod readiness and any minimum-ready time, not merely a Running phase._

```text
desired replicas = 4
maxSurge = 1       → at most 5 Pods during rollout
maxUnavailable = 1 → at least 3 available Pods
Pod-template change → new ReplicaSet → ready new Pods → old scale-down
```

## Read the controller chain before opening a shell

Start with `kubectl get deployment,replicaset,pod` in the intended namespace and compare desired, current, updated, available, and ready counts. `kubectl rollout status deployment/<name>` reports rollout progress, while `kubectl describe` shows conditions and recent events. Match the Pod template labels to the Service selector before assuming traffic reaches the new Pods. Sort namespace events by time when a scheduling or image problem is suspected.

A Pending Pod points first to scheduling events, storage claims, namespace quotas, or image credentials; CI4 covers claims and CI5 covers quotas and placement. `ImagePullBackOff` points to image reference, registry reachability, or authentication. A Running but unready Pod points to the readiness path, listener, configuration, or dependency. `CrashLoopBackOff` calls for current and previous container logs, exit reason, and restart count. An OOM-killed process calls for memory limit and working-set evidence. Use `kubectl debug` or an ephemeral container—a temporary diagnostic container added to an existing Pod—only when the image lacks tools and policy allows it; record any change made during diagnosis.

- Controller evidence: Deployment conditions and ReplicaSet counts.
- Node evidence: scheduling event, assigned node, image pull, and mount status.
- Process evidence: exit code, previous logs, restart count, probes, and resource events.
- Traffic evidence: Service selector, EndpointSlice readiness, and target-port listener.

## Summary

Kubernetes schedules process groups, not miniature machines. The image defines what to start, the Pod defines what must be colocated, and a controller defines how instances are replaced, completed, or kept present.

- An OCI image is layered filesystem content plus launch metadata; a container is a host-kernel process constrained by namespaces, cgroups, mounts, capabilities, and policy.
- A Kubernetes cluster consists of a control plane and worker nodes. Nodes run Pods through kubelet and a container runtime; the control plane stores and reconciles objects rather than directly running application code.
- Kubernetes objects separate identity in metadata, desired state in spec, and observed state in status. Labels and selectors connect controllers, Pods, and Services.
- Tags are movable registry names, while digests identify content. Promote the tested digest and treat signatures, provenance, scanning, and an SBOM as related but separate checks.
- Containers in one Pod share a node, network namespace, and optionally volumes. They do not share filesystems or process namespaces by default.
- Regular init containers finish before application startup. Restartable init containers provide native sidecar lifecycle on supported Kubernetes versions.
- Pods are disposable identities. Put stable network access behind a Service and durable state behind an external store or persistent volume.
- Use Deployments for interchangeable replicas, StatefulSets for ordered identity or per-replica claims, DaemonSets for node-scoped work, and Jobs or CronJobs for finite work.
- A Deployment rollout begins only when its Pod template changes. A ConfigMap edit alone does not replace Pods unless a version or content hash is part of that template.
- During rollout, maximum Pods equal desired replicas plus max surge; minimum available Pods equal desired replicas minus max unavailable. Readiness, not merely Running state, determines availability.
- Diagnose from controller to process: Deployment conditions, ReplicaSet counts, scheduling and mount events, image pulls, current and previous logs, probe state, Service selectors, and ready EndpointSlices.

## References

- [OCI Image Format Specification](https://github.com/opencontainers/image-spec/blob/main/spec.md)
- [OCI Runtime Specification](https://github.com/opencontainers/runtime-spec/blob/main/spec.md)
- [Kubernetes cluster architecture](https://kubernetes.io/docs/concepts/architecture/)
- [Understanding Kubernetes objects](https://kubernetes.io/docs/concepts/overview/working-with-objects/)
- [Kubernetes labels and selectors](https://kubernetes.io/docs/concepts/overview/working-with-objects/labels/)
- [Kubernetes Pods](https://kubernetes.io/docs/concepts/workloads/pods/)
- [Kubernetes init containers](https://kubernetes.io/docs/concepts/workloads/pods/init-containers/)
- [Kubernetes sidecar containers](https://kubernetes.io/docs/concepts/workloads/pods/sidecar-containers/)
- [Kubernetes workload management](https://kubernetes.io/docs/concepts/workloads/controllers/)
- [Kubernetes Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Kubernetes ConfigMaps](https://kubernetes.io/docs/concepts/configuration/configmap/)
- [Kubernetes Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Declarative management with Kustomize](https://kubernetes.io/docs/tasks/manage-kubernetes-objects/kustomization/)

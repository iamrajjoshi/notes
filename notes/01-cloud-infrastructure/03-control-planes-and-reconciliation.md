---
title: Control planes and reconciliation
shortTitle: Reconciliation
description: Read Kubernetes as an API plus cooperating control loops, including watches, finalizers, plugins, and health signals.
collection: cloud-infrastructure
slug: control-planes-and-reconciliation
order: 3
number: CI3
duration: 105 min
difficulty: Core
tags:
  - control plane
  - controllers
  - watches
  - kubelet
  - probes
---

## Working model

Kubernetes is a database of intent surrounded by control loops. Each loop observes, compares, and acts; no single request performs the whole deployment.

## Questions this note answers

- Trace an object from API write to a running container
- Assign work to the API server, scheduler, controller manager, and kubelet
- Explain CRI, CNI, and CSI as replaceable node interfaces
- Explain what a CustomResourceDefinition and operator add to Kubernetes
- Use watches, finalizers, and probes without confusing their jobs
- Read field ownership before resolving a conflict between declarative writers

## Separate the control plane from the data plane

The **control plane** accepts desired state and makes decisions about the cluster. The **data plane** is where application traffic and workload processes run. In Kubernetes, worker nodes form the ordinary workload data plane, although node agents still talk to the control-plane API.

The main components divide work:

| Component          | Responsibility                                                                                            | What success from it proves                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| API server         | Authenticates and authorizes API requests, runs admission, validates objects, and exposes persisted state | The requested API operation was accepted or rejected                   |
| etcd               | Stores the control plane's strongly consistent cluster metadata                                           | A committed metadata write exists; not that a workload is healthy      |
| controller manager | Runs controllers that compare desired and observed objects, then create or update dependent state         | The relevant controller has acted when its status and children advance |
| scheduler          | Chooses a node for an unscheduled Pod and records the binding                                             | A node was selected; no process has started yet                        |
| kubelet            | Drives assigned Pods toward their declared node-local state                                               | Containers, mounts, and network setup progressed on that node          |

Admission occurs inside the API request before persistence. Mutating admission can change the candidate object; validating admission can accept or reject it. Reconciliation starts after persisted state exists and can continue for the object's lifetime.

## An accepted object is a promise to reconcile

The API server authenticates and authorizes requests, runs admission, validates objects, and persists cluster state in etcd, Kubernetes' strongly consistent metadata store. Returning success means the desired object exists; it doesn't mean a container is healthy. Controllers notice the new state and create or update dependent objects until observed state approaches intent.

A Deployment controller creates a ReplicaSet, the ReplicaSet controller creates Pods, and the scheduler binds unscheduled Pods to nodes. These steps can pause, retry, race with new writes, or fail independently, so status and events matter as much as spec.

> **Fictional case.** The bookshop repository uses Kustomize to render a `storefront-api` Deployment and Argo CD to compare that result with a disposable cluster. A Git change starts one reconciliation loop; Kubernetes controllers still create ReplicaSets and Pods afterward.

## Begin at the persisted object and name its controller

An object can arrive from `kubectl`, a delivery system, an operator, or another controller. Once the API server accepts and persists it, Kubernetes reconciliation follows the same object graph. The source revision, manifest render, promotion gate, and rollback path belong to [CI9: Infrastructure as code and GitOps](./09-infrastructure-as-code-and-gitops.md). This note begins at the API boundary: which object exists, which controller watches it, what child or status it should produce, and where progress stopped.

Argo CD is useful here only as another example of the pattern. Its `ApplicationSet` controller can write `Application` custom resources. An Argo CD application controller can then write ordinary Kubernetes objects such as Deployments and Services. It does not schedule a Pod or start a process; the built-in Kubernetes controllers, scheduler, and kubelet still own those later transitions.

| Observed object  | Next owner to inspect          | Evidence of progress                                                         |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `ApplicationSet` | ApplicationSet controller      | Generated `Application` objects, conditions, and controller errors           |
| `Application`    | Argo CD application controller | Target revision, sync operation, resource comparison, and conditions         |
| `Deployment`     | Deployment controller          | Observed generation, conditions, and owned ReplicaSets                       |
| `ReplicaSet`     | ReplicaSet controller          | Desired, current, and ready counts plus owned Pods                           |
| Unbound `Pod`    | Scheduler                      | Scheduling condition, events, and recorded node binding                      |
| Bound `Pod`      | Kubelet on the selected node   | Pod conditions, container states, restart reasons, mounts, and network setup |

Use the same discovery order for an unfamiliar resource:

1. Record its `apiVersion`, `kind`, namespace, name, generation, spec, status, and conditions.
2. Read owner references to find the parent and dependent objects. Ownership shows lifecycle relationships, not necessarily every controller that can write a field.
3. Identify the controller from the resource's documentation, installed controller Deployment, events, status fields, and field managers. Do not infer ownership from a product name alone.
4. Compare the latest object generation with `status.observedGeneration` when that controller publishes it. Then inspect the child object or external result the controller should create.
5. At the first stalled transition, read reason codes, events, controller logs, queue or API errors, and authorization evidence before editing the object.

_Delivery explains why the desired object changed. Reconciliation explains what each controller did after that object existed._

```text
accepted Application
  → Argo CD application controller writes Deployment
    → Deployment controller writes ReplicaSet
      → ReplicaSet controller writes Pod
        → scheduler records node binding
          → kubelet starts local workload state
```

## The kubelet turns a binding into local processes

Once a Pod has a node, that node's kubelet drives it toward the declared state. The kubelet calls a Container Runtime Interface (CRI) implementation for container sandboxes and processes. A Container Network Interface (CNI) plugin wires Pod networking, while Container Storage Interface (CSI) components provision or attach storage. The Kubernetes API stays stable even when implementations differ.

The scheduler reserves no CPU cycles and starts no process. It only chooses a node and records the binding. The kubelet and runtime create local state; the Linux kernel later accounts for CPU, memory, I/O, and process isolation.

## Watches carry change; finalizers hold deletion

Controllers list current objects, then watch changes from a resource version. A watch can close or fall behind, so correct clients relist and resume instead of treating one stream as permanent. Reconciliation must be idempotent because the same state can arrive more than once.

Deletion sets a timestamp when finalizers remain. A responsible controller cleans external state and removes only its own finalizer; a stuck finalizer leaves an object terminating. Owner references and garbage collection solve a different problem: dependent Kubernetes objects.

### Why level-triggered control wins

A controller should derive the next action from current state rather than depend on receiving every edge. Restart it midway and the next reconciliation still knows what remains.

## Desired state can have more than one writer

Server-Side Apply records which field manager owns each applied field in `managedFields`. When another manager tries to apply a different value to the same owned field, the API can report a conflict instead of silently choosing a winner. Forcing the apply transfers ownership; it is not a harmless retry.

This matters when GitOps, a Horizontal Pod Autoscaler (HPA), an admission controller, and an operator all touch one object. For example, committing a fixed Deployment replica count while an HPA owns scaling can repeatedly reset the live value, depending on the apply mode and field ownership. Decide which controller owns each field, inspect `managedFields` and the last writer, then change one contract rather than racing controllers.

## Custom resources add nouns; operators add behavior

A CustomResourceDefinition (CRD) extends the Kubernetes API with another resource type and schema. After the API server accepts that definition, clients can create custom objects and use ordinary API features such as watch, authorization, metadata, and finalizers. The CRD alone does not create a database, certificate, or cloud resource.

An **operator** is a controller that watches those custom objects and carries domain-specific reconciliation code. A database operator might turn a `DatabaseCluster` object into Pods, Services, claims, backups, and provider calls, then write health into status. This is ordinary control-loop architecture with a new API type, which means permissions, upgrades, finalizers, webhooks, and failure recovery all need owners.

## Startup, readiness, and liveness answer different questions

A startup probe protects a slow-starting container from premature liveness failure. Readiness decides whether the Pod should receive Service traffic. Liveness decides whether kubelet should restart the container. A dependency outage usually belongs in readiness or application error handling, not liveness, or every replica may restart together.

Probe timing forms a failure detector. A one-second timeout against a path that occasionally takes 1.1 seconds creates an outage machine; tune thresholds against measured startup and response behavior.

## One write becomes several independently observed transitions

An engineer submits a Deployment with three replicas. The API server authenticates the caller, authorizes the operation, runs mutating and validating admission, validates the resulting object, and persists it. The Deployment controller observes a new generation and creates or updates a ReplicaSet. The ReplicaSet controller creates Pods until its count matches intent. Each unbound Pod enters the scheduler queue; the scheduler filters and scores nodes, then records a binding. The selected node's kubelet asks the runtime and node plugins to prepare the sandbox, network, volumes, and containers.

Status travels back through the API rather than through one synchronous deployment call. Compare `.metadata.generation` with a controller's `.status.observedGeneration` when available to see whether it has processed the latest spec. Follow owner references from Deployment to ReplicaSet to Pod, then read Pod conditions, assigned node, container states, and events. If an object stops deleting, inspect its deletion timestamp and finalizers before removing anything. If a controller does not react, check its leader, watch errors, queue depth, API authorization, and logs; repeatedly resubmitting the object can add noise without changing the blocked state.

_Use a narrow namespace and sanitized object name. Read-only inspection comes before a manual patch or finalizer change._

```text
kubectl get deploy,rs,pod -o wide
kubectl describe deployment <name>
kubectl get pod <name> -o yaml
kubectl get events --sort-by=.metadata.creationTimestamp
```

### Admission is not reconciliation

Admission can reject or change the submitted object before persistence. Controllers act after persistence. A request accepted by admission can still remain unscheduled or unready, and a controller-created object can face admission separately.

## Summary

Kubernetes turns persisted intent into running state through several independent control loops. API acceptance proves that an object was admitted and stored; status, events, and service evidence prove whether later controllers and node components completed their parts.

- The API server authenticates, authorizes, admits, validates, and persists. It does not synchronously create a healthy container.
- Control-plane components accept intent and make placement or reconciliation decisions; worker nodes run application processes and carry ordinary service traffic.
- A typical chain is Deployment → ReplicaSet → Pod → scheduler binding → kubelet → CRI, CNI, and CSI work. Each transition can pause or fail independently.
- A delivery controller is one writer in the graph. An ApplicationSet can generate Applications and an Argo CD application controller can write workload objects, but Kubernetes controllers, the scheduler, and the kubelet still own the later transitions. CI9 covers source rendering, promotion, and rollback.
- The scheduler chooses and records a node; the kubelet and runtime create local processes, networking, and mounts.
- Controllers must relist after a broken or stale watch and reconcile idempotently because notifications may be repeated or missed.
- Server-Side Apply tracks field managers and reports ownership conflicts. A forced apply transfers field ownership; it should follow an ownership decision, not serve as the first repair command.
- A CRD adds a custom API type and schema. An operator supplies the controller behavior that reconciles objects of that type; installing one without the other leaves either no accepted object or no domain action.
- A finalizer delays deletion until its owning controller finishes external cleanup. Owner references and garbage collection handle dependent Kubernetes objects, which is a different concern.
- Startup protects slow initialization, readiness gates traffic, and liveness requests restart. Dependency outages usually should not make all replicas fail liveness together.
- Compare generation with observed generation, then follow owner references, Pod conditions, events, and component logs. Reapplying the same object rarely fixes a controller blocked on permissions, queues, or an external API.

## References

- [Kubernetes components](https://kubernetes.io/docs/concepts/overview/components/)
- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Kubernetes API concepts and watches](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- [Kubernetes Server-Side Apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
- [Kubernetes custom resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [Kubernetes operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Kubernetes finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- [Configure liveness, readiness, and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Kubernetes Container Runtime Interface](https://kubernetes.io/docs/concepts/architecture/cri/)
- [Argo CD Applications](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/)
- [Argo CD ApplicationSet](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/)

---
title: Control planes, etcd, and reconciliation
description: Follow a Kubernetes API mutation through etcd, watches, controllers, scheduling, and node reconciliation, then operate the storage boundary under churn and failure.
slug: control-planes-and-reconciliation
order: 3
identifier: CI3
duration: 3 hours
difficulty: Core
tags:
  - control plane
  - controllers
  - etcd
  - Raft
  - watches
  - kubelet
  - probes
---

## Working model

Kubernetes is a database of intent surrounded by control loops. Each loop observes, compares, and acts; no single request performs the whole deployment.

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

> **Fictional case.** A client submits the bookshop's `storefront-api` Deployment with three replicas. API acceptance records that intent. The built-in Deployment and ReplicaSet controllers must still create the three Pod objects, the scheduler must place them, and kubelets must start them.

## Begin at the persisted object and name its controller

An object can arrive from `kubectl`, a delivery system, another controller, or any authorized API client. Once the API server accepts and persists it, Kubernetes reconciliation follows the same object graph. Begin at the API boundary: which object exists, which controller watches it, what child or status it should produce, and where progress stopped.

| Observed object | Next owner to inspect        | Evidence of progress                                                         |
| --------------- | ---------------------------- | ---------------------------------------------------------------------------- |
| `Deployment`    | Deployment controller        | Observed generation, conditions, and owned ReplicaSets                       |
| `ReplicaSet`    | ReplicaSet controller        | Desired, current, and ready counts plus owned Pods                           |
| Unbound `Pod`   | Scheduler                    | Scheduling condition, events, and recorded node binding                      |
| Bound `Pod`     | Kubelet on the selected node | Pod conditions, container states, restart reasons, mounts, and network setup |

Use the same discovery order for an unfamiliar resource:

1. Record its `apiVersion`, `kind`, namespace, name, generation, spec, status, and conditions.
2. Read owner references to find the parent and dependent objects. Ownership shows lifecycle relationships, not necessarily every controller that can write a field.
3. Identify the controller from the resource's documentation, installed controller Deployment, events, status fields, and field managers. Do not infer ownership from a product name alone.
4. Compare the latest object generation with `status.observedGeneration` when that controller publishes it. Then inspect the child object or external result the controller should create.
5. At the first stalled transition, read reason codes, events, controller logs, queue or API errors, and authorization evidence before editing the object.

_Delivery explains why the desired object changed. Reconciliation explains what each controller did after that object existed._

```text
accepted Deployment
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

## Advanced: etcd capacity and recovery

The control-plane path above is enough for a first reading: clients declare objects, controllers reconcile them, the scheduler binds Pods, and kubelets create local processes. The next sections keep that same path but inspect its durable store, write load, scaling boundary, maintenance, and recovery in detail.

### The API server owns the durable storage boundary

Ordinary Kubernetes clients do not write to etcd. A kubelet, scheduler, built-in or custom controller, or `kubectl` sends an API request to a kube-apiserver. The API server authenticates and authorizes the caller, runs the applicable admission and validation logic, converts the object to its storage representation, and performs the storage operation. This boundary keeps API version conversion, optimistic concurrency, authorization, admission, audit, and storage layout out of every client.

An update normally carries the object's `metadata.resourceVersion`. The API server uses that value to reject an update based on an older object rather than silently overwrite a concurrent change. Clients must treat `resourceVersion` as an opaque concurrency and watch token. It is related to the persisted revision, but application code must not parse it as a timestamp or depend on a numeric gap having a particular meaning.

The same distinction matters when measuring load. A kubelet heartbeat is an API update request. If accepted, the API server persists the new Lease through etcd. Saying that every node “writes directly to etcd” skips the component that owns authentication, flow control, conversion, and the storage transaction.

```text
client or control-plane component
  -> kube-apiserver
       -> API request pipeline
          (authentication, authorization, admission,
           validation, defaulting, and conversion)
       -> etcd transaction
       -> API response
  <- watch event through the API server
```

### etcd keeps one ordered metadata history

etcd is a persistent key-value store built for small, frequently read control-plane records that need strong ordering. Kubernetes serializes API objects under prefixes in etcd; etcd itself sees byte keys and byte values rather than Pods or Deployments.

A production etcd cluster is a Raft replication group. One member is the leader for the current term. A modifying request reaches the leader, becomes a Raft log entry, commits after a quorum has persisted it, and is applied to the multi-version key-value store on each healthy member. A three-member group needs two members for quorum and tolerates one permanent member loss; a five-member group needs three and tolerates two. Adding members can improve fault tolerance, but it adds replication work and does not partition the write stream.

Commit latency therefore depends on more than CPU. It includes network delay between members and durable write-ahead-log work. The `fdatasync` system call asks the operating system to transfer changed file data and the metadata needed to retrieve it to the storage stack; the filesystem, device caches, and error path still determine the complete persistence promise described in [LL4: Linux storage and I/O](../02-low-level-infrastructure/04-storage-and-io.md#start-with-the-persistence-promise). A slow synchronization call, a slow quorum member, packet loss, or leader elections can delay API mutations even when application nodes are idle. If the group loses quorum, existing Pods may keep running on their nodes, but the control plane cannot commit new desired state, bindings, heartbeats, or status changes.

etcd assigns one cluster-wide **revision** whenever a transaction changes the keyspace, even when that transaction changes several keys. Its multi-version concurrency control (MVCC) store retains older versions until compaction, which lets a watcher resume from a known revision. A **linearizable read** must behave as if it took effect at one instant between its request and response, after every write that completed before the read began; [DS7: Replication, consistency, and transactions](../06-distributed-systems/07-replication-consistency-and-transactions.md#define-consistency-from-histories-clients-can-observe) develops that client-visible guarantee. A watch serves a different contract: it receives ordered `PUT` and `DELETE` events after its start revision, but the stream is not itself a linearizable read and has no bounded delivery latency. If the requested history has already been compacted, the watcher must obtain current state again and resume from the newer revision. Kubernetes controllers implement this as list, watch, relist, and idempotent reconciliation.

The kube-apiserver keeps a watch cache so many reads and watches can use an in-memory view instead of repeatedly scanning etcd. Current Kubernetes releases can serve more consistent list reads from that cache when the required features and etcd versions are present. This reduces read pressure; it does not erase durable mutations, Raft replication, MVCC history, or downstream watch fan-out. Treat the exact cache behavior as version-sensitive.

### One Pod creates a sequence of durable mutations

There is no fixed “writes per Pod” constant in the Kubernetes API. The count depends on workload controllers, admission, scheduling, kubelet behavior, finalizers, status changes, and installed custom controllers. The useful model is to enumerate the object mutations in the actual lifecycle.

For one ordinary controller-managed Pod, the durable path can include:

1. A ReplicaSet controller creates the Pod object.
2. The scheduler binds the Pod to a Node, which persists the placement decision.
3. The kubelet updates Pod status as sandbox, initialization, container, and readiness state changes.
4. Other controllers update related objects. EndpointSlices—the API objects that list a Service's current network backends—are separate durable objects rather than fields inside the Pod; CI4 follows their traffic role.
5. Deletion can first persist a deletion timestamp, wait for grace periods or finalizers, and later remove the key. A workload controller may create a replacement at the same time.

Events are separate API objects with their own retention policy. They are useful evidence, but they are not an immutable audit log and their creation count is not a stable proxy for Pod mutations. A custom controller or admission webhook can also create related resources, add finalizers, or cause retries. Measure writes by API resource and verb instead of multiplying Pod count by an assumed universal constant.

Each persisted mutation creates work at several layers: API admission and serialization, an etcd proposal and durable commit, the API-server watch cache, watch delivery to interested clients, controller queueing, and sometimes a new mutation in response. High Pod churn is therefore not only a scheduler or container-runtime problem. It is a feedback workload across the whole control plane.

### Node Leases create a standing write floor

Kubernetes gives every Node a same-named `Lease` object in the `kube-node-lease` namespace. This Kubernetes API object is different from an etcd TTL lease. The kubelet renews its Node Lease through the API server by updating `spec.renewTime`. In the current kubelet configuration API, renewal occurs every 10 seconds and the default Lease duration is 40 seconds. Node status is a separate object path: changes are reported promptly, while unchanged status defaults to a five-minute report interval when Node Leases are enabled. Explicit compatibility settings and distributions can change these values, so inspect the deployed kubelet configuration before using them in an incident calculation.

For `N` Nodes and Lease renewal interval `T`, the steady request rate is approximately:

```text
node Lease update requests per second = N / T

5,000 Nodes / 10 seconds = 500 update requests per second
```

That rate is `O(N)` for a fixed interval and exists even when no Pod is created. Retries during API or network trouble can raise the offered rate. Leader-election Leases, controller writes, status changes, and every other resource mutation sit on top of it.

### Estimate control-plane write demand from measured lifecycles

Let `lambda_pod` be the rate of Pod lifecycles beginning each second, and let `w_pod` be the measured mean number of accepted durable API mutations caused by one lifecycle during the observation window. A first capacity model is:

```text
R_mutation ~= N / T_lease + lambda_pod * w_pod + R_other
```

Suppose a 5,000-node cluster uses a 10-second Lease renewal interval. A controlled rollout then creates 200 Pods per second, and an API audit or request-metric sample shows a mean of seven accepted mutations across each Pod's create, bind, status, related-object, and deletion activity. The estimate is `500 + 200 * 7 = 1,900` mutations per second before other controllers, custom resources, retries, and user changes. Seven is a measured input for this fictional window, not a Kubernetes guarantee.

The formula is a starting point, not a throughput promise. Mutation sizes differ, transactions may compare or update more than one key, watch fan-out varies by resource, and admission webhooks add latency before etcd. Run the test with the deployed object shapes and controller set. Record API request latency, rejected and throttled requests, etcd proposal and disk latency, watch delivery lag, controller queue age, and scheduler throughput together.

### etcd does not transparently shard one keyspace

An etcd cluster uses one Raft replication group and one globally ordered revision history. It does not hash ranges across independent Raft groups to gain horizontal write throughput. This choice makes transactions, watches, and ordering easier to reason about for metadata, while placing a real upper bound on the size and mutation rate of one Kubernetes control plane.

The kube-apiserver has an advanced `--etcd-servers-overrides` option that can route a compiled-in `group/resource` to a different set of etcd servers. That is manual separation by whole resource type, not transparent sharding of Pods or another hot resource by namespace, tenant, or key range. Each target cluster has a separate Raft group and revision history, so there is no cross-cluster transaction. The split creates more clusters to secure, back up, restore, upgrade, monitor, and reason about. Use it only after reducing avoidable churn, large objects, expensive list patterns, and controller bugs, then proving which resource dominates.

Splitting one very large Kubernetes fleet into multiple independent clusters is a broader form of partitioning. It reduces the node, object, watch, and failure domain per control plane, but moves placement, policy, rollout, identity, and service discovery problems to a fleet layer. Neither technique is free capacity.

### Compaction, defragmentation, and backup solve different problems

MVCC history grows as keys change. **Compaction** discards historical revisions older than a selected point, limiting how far a watch can resume and making backend pages reusable. It does not shrink the database file. **Defragmentation** rewrites one member's backend database so free pages return to the filesystem. Online defragmentation blocks reads and writes on that member while it runs, so operate members deliberately and verify cluster health between them. Compaction is a logical history operation; defragmentation is a physical per-member operation. Running only one does not perform the other.

etcd enforces a backend space quota. Crossing it raises a cluster-wide alarm and restricts normal writes until space is recovered and the alarm is cleared. Monitor both total backend size and in-use size, and schedule maintenance from measured growth rather than waiting for a write outage.

A snapshot protects against loss of the whole quorum; another member is not a backup because Raft faithfully replicates a bad deletion. Encrypt snapshot files because they contain Kubernetes state, including sensitive object data unless an upstream encryption layer changed the stored representation. Verify snapshot integrity, restore into an isolated environment, and prove API objects, credentials, controllers, and workloads recover.

Restoring an older snapshot also moves etcd's revision backward. Informer caches may otherwise believe they have already seen later revisions. Current etcd disaster-recovery guidance recommends `--bump-revision` plus `--mark-compacted` for Kubernetes restores so existing watches are invalidated and clients relist. From etcd 3.6 onward, `etcdctl` takes an online snapshot and `etcdutl` performs restore and offline snapshot operations. Pin the commands to the installed etcd release.

### Read the limiting layer from its evidence

Do not diagnose every slow API request as “etcd is slow.” Separate the stages:

| Evidence                                                                            | What an increasing value suggests                          | What it does not prove alone                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| API request latency by resource and verb                                            | A slow admission, storage, serialization, or response path | That disk is the cause                              |
| API Priority and Fairness queue or rejection                                        | Offered concurrency exceeds the configured API share       | That etcd has reached its write limit               |
| `etcd_server_proposals_pending`                                                     | Proposals are waiting to commit                            | Whether network, disk, or apply work is responsible |
| `etcd_disk_wal_fsync_duration_seconds`                                              | Durable Raft-log writes are slow                           | That every backend commit is slow                   |
| `etcd_disk_backend_commit_duration_seconds`                                         | Backend commits are slow                                   | That quorum network latency is healthy              |
| committed minus applied proposals                                                   | The apply path is falling behind committed work            | Which request or range operation caused it          |
| leader changes and peer round-trip time                                             | Consensus membership or network stability is changing      | That a Kubernetes controller is correct             |
| `etcd_mvcc_db_total_size_in_bytes` versus `etcd_mvcc_db_total_size_in_use_in_bytes` | History or free pages are consuming space                  | That defragmentation is safe during peak load       |
| `etcd_network_peer_round_trip_time_seconds`                                         | Consensus peer latency is changing                         | Whether disk persistence is also slow               |
| watch and controller queue lag                                                      | Consumers cannot keep up with state change                 | That the original mutation failed to commit         |

Correlate these signals over the same interval as Pod creation, deletion, Node Lease traffic, list calls, and controller retries. A slow disk can create leader instability; an admission webhook can make API latency high while etcd is healthy; a controller loop can flood a healthy store with valid but unnecessary writes. The repair belongs to the layer that owns the evidence.

## Desired state can have more than one writer

Server-Side Apply records which field manager owns each applied field in `managedFields`. When another manager tries to apply a different value to the same owned field, the API can report a conflict instead of silently choosing a winner. Forcing the apply transfers ownership; it is not a harmless retry.

This matters when GitOps, a Horizontal Pod Autoscaler (HPA), an admission controller, and a domain-specific controller all touch one object. For example, committing a fixed Deployment replica count while an HPA owns scaling can repeatedly reset the live value, depending on the apply mode and field ownership. Decide which controller owns each field, inspect `managedFields` and the last writer, then change one contract rather than racing controllers.

## Custom resources add nouns; operators add behavior

A CustomResourceDefinition (CRD) extends the Kubernetes API with another resource type and schema. A **custom resource (CR)** is one object created from that type. If a CRD registers `WorkspaceClaim`, then `claim-42` is a CR of kind `WorkspaceClaim`. After the API server accepts the definition, clients can create those objects and use ordinary API features such as watch, authorization, metadata, and finalizers. The CRD alone does not create a database, certificate, or cloud resource.

An **operator** is a controller that watches those custom objects and carries domain-specific reconciliation code. A database operator might turn a `DatabaseCluster` object into Pods, Services, claims, backups, and provider calls, then write health into status. This is ordinary control-loop architecture with a new API type, which means permissions, upgrades, finalizers, webhooks, and failure recovery all need owners.

### A claim-oriented controller separates recipes, inventory, and ownership

Consider four fictional custom kinds:

| Custom resource     | Desired state in `spec`                                    | Reconciled result in `status` or child objects                        |
| ------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `WorkspaceTemplate` | Pod recipe plus an immutable filesystem-template reference | A reusable, versioned launch contract                                 |
| `WorkspaceWarmPool` | Desired number of ready, unclaimed workspaces              | Enough `Workspace` CRs and Pods to restore idle inventory             |
| `WorkspaceClaim`    | Template or pool selector, claimant, and lifetime          | Exactly one acquired `Workspace`, or a named pending or failed reason |
| `Workspace`         | One concrete workspace's desired lifecycle                 | Its Pod, Service, readiness, owner, and cleanup progress              |

The template is API configuration. It may point to a filesystem image, but it does not contain that image's files. The warm-pool controller creates workspaces from the template. A claim then adopts one ready unclaimed workspace instead of creating another Pod on the critical path.

Acquisition needs an atomic ownership transition. A controller can use `resourceVersion`, a compare-and-set update, or another single-writer rule so two claims cannot both observe `available` and receive the same workspace. It records the winner in status, updates ownership references where the lifecycle requires them, and keeps reconciling from persisted state after a restart. A finalizer can delay claim or workspace deletion until credentials, Services, volumes, and provider-side state are cleaned up.

```text
WorkspaceWarmPool.spec.replicas = 3
  -> controller maintains 3 ready unclaimed Workspace CRs

WorkspaceClaim claim-42
  -> atomically adopts workspace-b
  -> status.workspace = workspace-b
  -> pool controller creates a replacement workspace
```

`spec` says what the caller wants. `status` says what the controller has observed and assigned. `resourceVersion` detects a stale update. Owner references tell Kubernetes which objects are lifecycle dependents; they do not replace the controller's domain-specific ownership checks.

### A GitOps controller adds an earlier reconciliation loop

Kustomize renders a base plus selected overlays into ordinary Kubernetes objects. Argo CD can compare that rendered target with live objects and write the differences through the Kubernetes API. Those delivery decisions belong to [CI9: Infrastructure as code and GitOps](./09-infrastructure-as-code-and-gitops.md); the built-in object graph begins after a workload object such as a Deployment has been accepted.

Argo CD also demonstrates the custom-resource pattern just described. Its `ApplicationSet` controller can write `Application` custom resources, and an Argo CD application controller can turn an accepted `Application` into Deployments, Services, or other declared objects. Neither controller schedules a Pod or starts a process.

| Observed custom object | Next owner to inspect          | Evidence of progress                                               |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------ |
| `ApplicationSet`       | ApplicationSet controller      | Generated `Application` objects, conditions, and controller errors |
| `Application`          | Argo CD application controller | Target revision, sync operation, resource comparison, and status   |

> **Fictional case.** The bookshop repository uses Kustomize to render the `storefront-api` Deployment. Argo CD accepts that rendered target through an `Application`, then writes the Deployment. At that point the same built-in Deployment → ReplicaSet → Pod chain traced earlier takes over.

```text
accepted ApplicationSet
  → ApplicationSet controller writes Application
    → Argo CD application controller writes Deployment
      → built-in Deployment, ReplicaSet, scheduler, and kubelet path
```

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
- Kubernetes components mutate resources through the API server rather than writing etcd directly. The API boundary owns concurrency checks, admission, conversion, audit, and storage transactions.
- etcd stores Kubernetes metadata in one Raft replication group with a cluster-wide MVCC revision history. Quorum adds fault tolerance and ordering, but members do not shard the keyspace or multiply write throughput.
- Pod creation, binding, status, related resources, and deletion are separate mutations whose count varies by workload and installed controllers. Node Lease renewals add a standing rate of about `N / T_lease`; at current defaults, 5,000 Nodes offer about 500 Lease updates per second before retries.
- The API-server watch cache can remove many reads from etcd, but it does not remove durable writes or the fan-out from each change. Measure API, etcd, watch, and controller evidence in the same interval.
- Compaction removes old MVCC history, defragmentation reclaims backend pages on each member, and snapshots protect against loss of the quorum. A Kubernetes restore needs revision handling that forces stale informers to relist.
- Control-plane components accept intent and make placement or reconciliation decisions; worker nodes run application processes and carry ordinary service traffic.
- A typical chain is Deployment → ReplicaSet → Pod → scheduler binding → kubelet → CRI, CNI, and CSI work. Each transition can pause or fail independently.
- A delivery controller is one writer in the graph. An ApplicationSet can generate Applications and an Argo CD application controller can write workload objects, but Kubernetes controllers, the scheduler, and the kubelet still own the later transitions. CI9 covers source rendering, promotion, and rollback.
- The scheduler chooses and records a node; the kubelet and runtime create local processes, networking, and mounts.
- Controllers must relist after a broken or stale watch and reconcile idempotently because notifications may be repeated or missed.
- Server-Side Apply tracks field managers and reports ownership conflicts. A forced apply transfers field ownership; it should follow an ownership decision, not serve as the first repair command.
- A CRD adds a custom API type and schema; a CR is one object of that type. An operator supplies behavior, and a claim-oriented controller needs an atomic persisted ownership transition before assigning one ready resource.
- A finalizer delays deletion until its owning controller finishes external cleanup. Owner references and garbage collection handle dependent Kubernetes objects, which is a different concern.
- Startup protects slow initialization, readiness gates traffic, and liveness requests restart. Dependency outages usually should not make all replicas fail liveness together.
- Compare generation with observed generation, then follow owner references, Pod conditions, events, and component logs. Reapplying the same object rarely fixes a controller blocked on permissions, queues, or an external API.

## References

- [Kubernetes components](https://kubernetes.io/docs/concepts/overview/components/)
- [Kubernetes controllers](https://kubernetes.io/docs/concepts/architecture/controller/)
- [Kubernetes API concepts and watches](https://kubernetes.io/docs/reference/using-api/api-concepts/)
- [The Kubernetes API: persistence](https://kubernetes.io/docs/concepts/overview/kubernetes-api/#persistence)
- [Kubernetes Leases](https://kubernetes.io/docs/concepts/architecture/leases/)
- [Kubelet configuration API](https://kubernetes.io/docs/reference/config-api/kubelet-config.v1beta1/)
- [Kube-apiserver command-line reference](https://kubernetes.io/docs/reference/command-line-tools-reference/kube-apiserver/)
- [Kubernetes API Priority and Fairness](https://kubernetes.io/docs/concepts/cluster-administration/flow-control/)
- [Operating etcd clusters for Kubernetes](https://kubernetes.io/docs/tasks/administer-cluster/configure-upgrade-etcd/)
- [etcd API, revisions, MVCC, and watches](https://etcd.io/docs/v3.6/learning/api/)
- [Why etcd uses one replication group](https://etcd.io/docs/v3.6/learning/why/)
- [etcd maintenance](https://etcd.io/docs/v3.6/op-guide/maintenance/)
- [etcd metrics](https://etcd.io/docs/v3.6/metrics/)
- [etcd disaster recovery](https://etcd.io/docs/v3.6/op-guide/recovery/)
- [Kubernetes Server-Side Apply](https://kubernetes.io/docs/reference/using-api/server-side-apply/)
- [Kubernetes custom resources](https://kubernetes.io/docs/concepts/extend-kubernetes/api-extension/custom-resources/)
- [Kubernetes operator pattern](https://kubernetes.io/docs/concepts/extend-kubernetes/operator/)
- [Kubernetes finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/)
- [Configure liveness, readiness, and startup probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)
- [Kubernetes Container Runtime Interface](https://kubernetes.io/docs/concepts/architecture/cri/)
- [Argo CD Applications](https://argo-cd.readthedocs.io/en/stable/operator-manual/declarative-setup/)
- [Argo CD ApplicationSet](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/)

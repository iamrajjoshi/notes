---
title: Kubernetes networking, storage, and security
description: Trace packets through Services and gateways, bind durable volumes with CSI, and layer workload security controls.
slug: kubernetes-networking-storage-security
order: 4
identifier: CI4
duration: 145 min
difficulty: Core
tags:
  - CNI
  - Services
  - NLB
  - Gateway API
  - CSI
  - RBAC
---

## Working model

Kubernetes names intent while plugins program data paths. A Service, PVC, or NetworkPolicy matters only when its controller and provider turn that object into packets, mounts, or enforcement.

## Start with the connection the application wants

Suppose the `checkout` process needs `http://inventory:8080/stock`. The hostname `inventory` must resolve, a route must reach the chosen backend, policy must allow the flow, and a process must listen on the destination port. Kubernetes adds stable objects around a changing set of Pod addresses; it does not change those basic requirements.

Traffic between workloads inside a cluster is often called **east-west** traffic. Traffic entering or leaving the cluster is **north-south** traffic. **Ingress** means traffic entering a boundary, while **egress** means traffic leaving it. Always name the boundary because a packet can be egress from one Pod and ingress to another.

For a Service:

- `port` is the port clients use on the Service.
- `targetPort` is the port on each selected Pod; it can be a number or a named container port.
- `nodePort` is an extra port allocated on eligible nodes for a NodePort Service. A LoadBalancer Service normally uses the same mechanism unless the implementation supports and enables allocation without node ports.

The source port is normally a temporary client port chosen for that connection. A reply reverses source and destination addresses and ports. This four-value pair, plus the transport protocol, identifies the flow that routing and policy tools inspect.

```text
checkout Pod:temporary-port
  -> DNS inventory
  -> inventory ClusterIP:8080
  -> Service implementation chooses a ready endpoint
  -> inventory Pod:targetPort
```

## Pod IPs move; Services preserve intent

The Kubernetes network model gives each Pod a cluster-wide Internet Protocol (IP) address and expects direct Pod communication unless policy blocks it. A Container Network Interface (CNI) implementation creates interfaces, assigns addresses, and arranges routes. CoreDNS turns Service names into records. EndpointSlices hold the current ready backends for a Service.

A ClusterIP is a virtual destination, not a process listening on every node. kube-proxy or another service implementation watches Services and EndpointSlices, then programs packet handling. Debug in that order: name resolution, Service definition, ready endpoints, policy, route, listener.

Service type describes exposure, not the application protocol. `ClusterIP` supplies an internal virtual address. `NodePort` also opens a port on eligible nodes. `LoadBalancer` asks an installed cloud integration to provision or configure a load balancer outside the cluster; provider settings determine whether it is public or private. `ExternalName` returns a DNS alias and creates no proxy path. Gateway or Ingress adds L7 routing in front of Services; it does not replace the Service-to-endpoint contract.

New tooling should read EndpointSlices. Kubernetes deprecated the older Endpoints API in v1.33 because it truncates large backend sets and lacks dual-stack and newer routing data. Existing Endpoints objects still work, but their presence is not a reason to build another dependency on them.

> **Fictional case.** The bookshop cluster uses the Amazon VPC CNI for Pod addresses, CoreDNS plus NodeLocal DNSCache for lookup, and kube-proxy for Service traffic. A second toy cluster uses Cilium for both Service handling and NetworkPolicy, which is why diagnosis starts by identifying the installed implementation instead of assuming every cluster programs packets the same way.

### CNI chaining can split address allocation from policy

A cluster can use the Amazon VPC CNI as its primary network setup and chain Cilium after it. In that arrangement, the VPC CNI prepares the Pod interface, allocates a VPC-routable address from EC2 network-interface capacity, and installs the required routes. Cilium then attaches eBPF programs to the prepared interface for identity-aware policy, flow handling, and visibility.

Exact ownership depends on the installed mode. Record which component owns IP address management, routes, Service handling, and NetworkPolicy before debugging. Do not assume that installing Cilium means it replaced the VPC CNI or kube-proxy.

| Boundary            | Question it answers                                                       |
| ------------------- | ------------------------------------------------------------------------- |
| Amazon VPC CNI      | Which interface, VPC address, and route does this Pod receive?            |
| Cilium ingress      | Which sources may send selected traffic into this destination Pod?        |
| Cilium egress       | Which destinations may this selected source Pod contact?                  |
| Hubble              | Which flows and policy verdicts were observed? It grants no permission.   |
| gVisor              | Which syscall path separates the process from the host kernel?            |
| Kubernetes RBAC     | Which Kubernetes API operations may this principal perform?               |
| Cloud workload role | Which AWS API operations may the resulting temporary credentials perform? |
| Application auth    | Which product objects and business actions may this caller use?           |

Once policy selects a Pod for a direction, traffic not allowed by the resulting policy set is denied in that direction. If both source egress and destination ingress are isolated, both sides must allow the flow. For an FQDN egress rule, Cilium observes DNS queries and answers, then programs policy for the returned IP addresses. Ordinary L3/L4 packets carry an IP address and port, not the hostname that produced the address. The rule therefore depends on DNS visibility, answer lifetime, and shared-address behavior; it still cannot decide whether the application sends an HTTP read or write after connecting.

### Use an internal NLB as a stable VPC entry point

A process in the same VPC but outside Kubernetes, such as a Lambda function or EC2 worker, usually cannot rely on cluster DNS or a ClusterIP. Calling a Pod IP directly is also unsafe because that address changes when Kubernetes replaces the Pod. An internal Network Load Balancer (NLB) gives the VPC caller a stable DNS name while Kubernetes and AWS keep its changing Pod targets current.

The NLB path has five pieces:

| Piece                        | Responsibility                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| NLB DNS name                 | Stable name the caller resolves; the answers are private NLB frontend addresses                                                  |
| Listener                     | Accepts a transport protocol and port, such as TCP `8080`                                                                        |
| Target group                 | Holds eligible destination IP and port pairs                                                                                     |
| Health check                 | Decides which registered targets may receive new connections                                                                     |
| AWS Load Balancer Controller | Reconciles the Kubernetes Service into the NLB, listener, target group, security rules, target registrations, and Service status |

Suppose a private job must call a catalog API running in EKS. A modern Service request can look like this:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: internal-catalog-api
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-scheme: internal
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
spec:
  type: LoadBalancer
  loadBalancerClass: service.k8s.aws/nlb
  selector:
    app: catalog-api
  ports:
    - name: http
      protocol: TCP
      port: 8080
      targetPort: 8080
```

`type: LoadBalancer` is a request for infrastructure; it does not create the AWS objects by itself. `loadBalancerClass` assigns that request to the AWS Load Balancer Controller. The `internal` scheme places the NLB in private subnets, so it has no internet-facing entry point. The `ip` target type registers Pod IPs directly. With `instance` targets, the target group instead contains node IP and NodePort pairs, adding the node-side Service path before the packet reaches a Pod.

Older manifests may use this annotation instead of `loadBalancerClass`:

```yaml
service.beta.kubernetes.io/aws-load-balancer-type: external
```

Here `external` assigns reconciliation to the external AWS controller rather than the legacy in-tree controller. It does not make the load balancer internet-facing; the scheme controls that choice. Treat controller ownership and network exposure as separate settings.

After reconciliation, the provider state resembles:

```text
Kubernetes Service
  -> internal NLB with a stable private DNS name
      -> TCP listener :8080
          -> IP target group
              -> 10.0.42.187:8080  healthy Pod
              -> 10.0.56.91:8080   healthy Pod
```

The caller's connection follows:

```text
private VPC caller
  -> resolve internal NLB DNS
  -> connect to one NLB frontend address:8080
  -> listener selects the target group
  -> NLB selects one healthy Pod IP:8080
  -> application handles the HTTP request
```

The NLB operates at Layer 4 for a TCP listener. It selects a target for the connection but does not route by HTTP host or path. The HTTP bytes pass through to the application. Use an ALB, Gateway, or another Layer 7 proxy when routing rules must inspect the request.

Pod replacement changes targets without changing the caller configuration:

```text
before: target group -> 10.0.42.187:8080
after:  target group -> 10.0.55.23:8080
caller: same NLB DNS name
```

The controller removes the old target and registers the new ready endpoint. The NLB cannot move an established TCP connection to another Pod, so requests in flight during replacement may fail. Clients still need bounded timeouts, safe retries, and idempotency for retried writes.

An internal NLB narrows reachability; it does not provide application identity, authorization, or encryption. Security groups and routes must admit the VPC caller, NetworkPolicy must admit traffic to the selected Pods when enforced, and the application must authenticate the caller. Plain TCP or HTTP remains plaintext even on a private route, so use TLS when the threat model requires encryption inside the VPC.

### Set up and verify the path

1. Install the AWS Load Balancer Controller, including its Kubernetes permissions and AWS workload identity.
2. Give Pods VPC-routable addresses for IP targets, normally through the Amazon VPC CNI, and make suitable private subnets discoverable to the controller.
3. Create the Deployment and LoadBalancer Service with matching selectors, ports, scheme, and target type.
4. Permit the caller-to-listener and NLB-to-target paths through routes, security groups, network ACLs, and NetworkPolicy.
5. Define readiness and target health checks that answer whether the process can accept new work.
6. Configure the caller with the NLB hostname or a private DNS alias, plus connection and request timeouts.
7. Test Pod replacement and controller reconciliation rather than checking only the first successful request.

Debug from desired state toward the socket:

```text
Service status has NLB hostname?
  -> Service selector has ready EndpointSlices?
  -> controller created listener and target group?
  -> target group reports useful healthy targets?
  -> caller resolves a private NLB address?
  -> VPC route and security rules admit both directions?
  -> TCP connects?
  -> TLS and HTTP succeed?
```

[CI12: Internet edge and private connectivity](12-internet-edge-and-private-connectivity.md) covers DNS caching, listener and target-group state, cross-zone balancing, health-driven fail-away, TLS termination, and PrivateLink in more depth.

## Map each network and storage object to its operator

Build an inventory for the fictional bookshop cluster from installed Kubernetes objects and the public component documentation. Record the API objects each component watches, the controller-side work, the node-side work, and the state left behind. That inventory should make it possible to answer whether a failed step belongs to Kubernetes, an AWS API, or a process on one node.

| Component                      | Kubernetes or provider work                                                | Node-side result                                                            |
| ------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Amazon VPC CNI                 | Node agents manage network-interface and address capacity through EC2 APIs | The CNI binary connects the Pod network namespace and assigns a VPC address |
| kube-proxy                     | Each node proxy watches Services and EndpointSlices through the API        | Programs that node's Service forwarding rules                               |
| CoreDNS and NodeLocal DNSCache | CoreDNS watches Service discovery data                                     | A local cache answers or forwards the Pod's DNS query                       |
| Amazon EBS CSI driver          | Provisions and attaches a volume through AWS APIs                          | Registers the CSI node service and mounts the attached device               |

Now compare two failures. A scheduled Pod stuck while its sandbox lacks an address points toward CNI address capacity before Service routing matters. A Pod waiting on `MountVolume` has passed API admission and scheduling, but its sandbox networking may still be incomplete; follow PVC binding, the CSI controller operation, EBS attachment, and the node plugin. The object timeline narrows the owner.

_For each component, name the watched object, controller action, node process, and resulting data-path change._

## L4 forwards connections; L7 understands requests

A layer-4 load balancer chooses a target using connection metadata such as address and port. A layer-7 proxy can route by host, path, header, or method, terminate Transport Layer Security (TLS), and apply HTTP behavior. More application awareness also means more configuration, buffering, timeout, and retry decisions.

Ingress remains supported, but its API is frozen. Gateway API gives infrastructure owners and application teams separate objects with richer routing. The controller implementation still determines which cloud load balancers and proxies appear.

_A fictional request path; each hop needs its own timeout and health signal._

```text
client → authoritative DNS → ALB → Gateway data plane → Service
Service → EndpointSlice → ready Pod IP:port
```

## A claim asks; a volume answers

A PersistentVolumeClaim (PVC) states capacity, access mode, and StorageClass needs. A dynamic provisioner creates a PersistentVolume (PV), and Container Storage Interface (CSI) node components mount it where the Pod lands. `WaitForFirstConsumer` delays provisioning until scheduling reveals the topology, which prevents an Availability Zone mismatch for zone-bound block storage.

A volume outlives a Pod only according to its reclaim policy and backend durability. Access mode describes attach or mount capability, not application-level concurrency safety. Backups and restore drills remain separate from persistence.

> **Fictional case.** The bookshop's `orders-db` claim uses a `gp3` EBS StorageClass with `WaitForFirstConsumer` to expose the binding path. It is not a recommendation to run PostgreSQL in Kubernetes; the same application could instead use RDS and avoid a Pod-mounted database volume.

### Advanced storage-driver case: an object-backed virtual block device

The ordinary PVC, PV, and CSI path above is enough for a first reading. This case examines drivers whose block interface is assembled from object storage and node-local cache. Return to [LL4: Linux storage and I/O](../02-low-level-infrastructure/04-storage-and-io.md) and [CI14: Storage, backups, and disaster recovery](14-storage-backup-and-disaster-recovery.md) if the block, mount, flush, cache, and recovery boundaries are unfamiliar.

CSI standardizes calls between kubelet and storage plugins; it does not require a provider block disk or even a controller-side provisioner. Compare two valid designs:

| CSI design                   | Kubernetes objects and calls                                                                                                                                                                      | Possible durability contract                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Dynamically provisioned disk | A provisioner creates a volume and PV; the controller may attach it with `ControllerPublishVolume`; the node plugin may stage it with `NodeStageVolume` and publishes it with `NodePublishVolume` | Flush can wait for provider-block or remote-manifest durability            |
| Inline ephemeral workspace   | The Pod embeds CSI volume attributes; kubelet generates an inline volume ID and calls the node plugin directly when the `CSIDriver` advertises the `Ephemeral` lifecycle mode                     | Ordinary writes can stay node-local until a periodic or unmount checkpoint |

For the first design, an object-backed driver could acknowledge a flush only after new immutable chunks and a committed volume manifest are durable. Losing a node should then discard only cache state. That is one possible contract, not a property CSI supplies.

#### CSI can also be inline and node-only

An inline CSI volume appears directly in a Pod specification. There may be no PVC, PV, StorageClass, external provisioner, requested capacity, or controller-side attach step. The driver must advertise `Ephemeral` in `CSIDriver.spec.volumeLifecycleModes`. Kubelet generates an opaque volume ID as `csi-<sha256(Pod UID + Pod volume name)>`, then gives that ID to the node plugin in `NodePublishVolume`. The driver name selects the plugin separately; it is not part of this hash.

Pod metadata is conditional. When `CSIDriver.spec.podInfoOnMount` is true, kubelet also puts the Pod name, namespace, UID, and service-account name in `NodePublishVolume.volume_context`. Without that setting, the plugin still receives the generated volume ID but not those Pod fields.

```yaml
volumes:
  - name: workspace
    csi:
      driver: scratch.csi.example
      volumeAttributes:
        templateBuildID: build-7f3
```

```yaml
apiVersion: storage.k8s.io/v1
kind: CSIDriver
metadata:
  name: scratch.csi.example
spec:
  attachRequired: false
  podInfoOnMount: true
  volumeLifecycleModes:
    - Ephemeral
```

The template ID can select an ext4 image whose header advertises a 50 GiB logical device even though the Pod requested no Kubernetes storage capacity. Logical size comes from that image format. Physical node usage can remain sparse because only fetched and changed blocks occupy cache files.

#### Follow an object-backed inline volume into the container

Suppose a privileged node DaemonSet implements the CSI node service and an NBD backend. Each eligible node gets one daemon instance before any workspace is mounted there.

```text
Pod inline CSI attributes
  -> kubelet calls NodePublishVolume
  -> node-local CSI DaemonSet reads immutable template header
  -> Go backend connects a free /dev/nbdN
  -> host mounts /dev/nbdN as ext4 at /mnt/workspaces/volume-ID
  -> driver bind-mounts that tree at kubelet's publish target
  -> container runtime exposes it at /workspace
```

NBD means Network Block Device. The Linux kernel presents `/dev/nbdN` as a block device but forwards READ, WRITE, and FLUSH commands to userspace. The backend can be local; it need not send NBD protocol traffic across the VPC. A Go dispatcher is one userspace request loop translating logical block commands into cache and object-store operations. It has nothing to do with scheduling Pods or dispatching agent work.

The two mounts have different jobs. The ext4 mount interprets raw device blocks as a filesystem and makes its directories, inodes, and files visible at a host path. The bind mount aliases that already-mounted tree at kubelet's target. It copies no bytes and creates no second filesystem.

#### Keep every storage identity separate

| Identity or mapping                   | Owner and purpose                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Template build ID                     | Pod attribute selecting an immutable base header and its object-store data                                  |
| Generated inline volume ID            | Kubelet currently hashes Pod UID plus volume name; the node plugin must consume the result as an opaque key |
| Optional Pod fields in volume context | Supplied only when `podInfoOnMount` is true; useful routing context but not proof of caller identity        |
| CSI volume ID inside the node daemon  | Keys the NBD device, private cache, host mount, and current in-memory state                                 |
| Header logical range                  | Maps logical block addresses to an immutable object ID and byte offset                                      |
| Stable run or conversation ID         | Application identity that must point to the latest header if another Pod must resume it                     |

The pathname is not an object-store patch key. A lookup such as `/workspace/src/app.py` passes through ext4 directory entries, an inode, and extents to logical block numbers. The blockstore maps those numbers to a private changed block or an immutable object range. Object storage never edits `src/app.py` by name.

The application database may map a stable run to the current sandbox or Pod name. Kubernetes records the resulting Pod UID. Kubelet derives the inline volume ID, and the node plugin uses that ID to select the NBD device, mount, and caches. Those mappings solve live routing. Cross-Pod filesystem recovery still needs a durable stable-run-to-latest-header mapping.

#### “Warm” and “cache” name several different states

| State                          | Location and population path                                                    | Sharing boundary                                   |
| ------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------- |
| Prebaked filesystem content    | Dependency trees, generated files, tools, and datasets written before S3 upload | Every volume using that immutable template         |
| Node-shared clean read cache   | Sparse node file filled lazily from object-store range reads                    | Mounts on one node using the exact immutable build |
| Per-volume private write cache | Sparse node file filled by one workspace's NBD writes plus a dirty-block bitmap | One CSI volume only                                |
| Linux page cache               | RAM pages populated above ext4 by file reads and writes                         | Kernel and mount rules on that node                |
| CI, registry, and image cache  | BuildKit layers, registry objects, or container-runtime image layers            | Build system or node image path, not workspace I/O |

A warm Pod is ready idle execution capacity. A prebaked template already contains expensive development state. A warm node cache has fetched popular clean blocks. They reduce different delays and can exist independently.

Sharing clean blocks is safe only because the cache key includes immutable build or object identity. Writes go to the volume's private cache and dirty bitmap, so two workspaces can read the same base without seeing each other's changes.

A concrete tuning profile keeps the shared clean cache on the node's `gp3` root disk, fills it lazily, and protects active entries with leases. It expires idle entries after six hours and evicts least-recently-used idle entries above a 30 GiB high watermark until usage reaches a 20 GiB low watermark. Daemon startup clears its shared clean read-cache files because completed-range state exists only in daemon memory; later reads refill them from object storage.

The virtual device uses 4 KiB logical blocks and four NBD socket connections per mounted volume; the connections allow independent I/O to proceed concurrently. A cached-device layer coalesces 4 KiB misses into 4 MiB read-cache chunks and fetches those chunks in 512 KiB object-range batches. That avoids issuing roughly one S3 range request for every missing 4 KiB block. These values are implementation tuning rather than CSI semantics.

#### Read, write, checkpoint, and resume are different paths

```text
read:
container pathname
  -> ext4 and page-cache lookup
  -> NBD READ on page-cache miss
  -> private changed block, else shared clean cache
  -> header lookup and object-store range read on cache miss

write:
container write
  -> Linux page cache and ext4 allocation
  -> NBD WRITE for logical blocks
  -> private sparse cache + dirty bitmap
  -> no edit to the immutable base or prior object

checkpoint:
syncfs pushes ext4 dirty pages through NBD WRITE
  -> pack selected dirty logical blocks into a new immutable diff object
  -> upload a cumulative header that directly maps every logical range
     to an immutable object UUID and byte offset
  -> periodic path: advance only the daemon's in-memory mountState.hdr
  -> final unmount: quiesce ext4 and NBD
     -> when dirty blocks exist, upload the generation
     -> record <volume-ID>.latest for that volume on that node
```

The completion point decides the failure behavior. A normal file write can be acknowledged after bytes enter the page cache. `fsync` asks ext4 and the block driver to honor their flush contract. In this reference design, the NBD connection does not advertise `SEND_FLUSH`; if a FLUSH command arrives anyway, its handler acknowledges without syncing the mmap-backed private cache to host media or S3. The checkpoint path calls `syncfs` so ext4 emits dirty blocks through NBD writes, but only a completed diff and header upload proves S3 durability.

The header is flattened rather than a linked list of prior headers. A reader loads one header and resolves every logical range directly to an object UUID and offset instead of chasing a checkpoint chain. Older data objects remain dependencies of the new header, so flattening lookup metadata does not compact or copy all underlying data.

Periodic checkpointing uploads a generation and advances only `mountState.hdr` in daemon memory. Final unmount quiesces ext4 and NBD, uploads a final generation when dirty blocks exist, and writes a volume-ID-scoped `.latest` record on that node. The current clean-unmount edge is unsafe: export can skip the upload when the dirty count is zero while unmount still writes a freshly generated UUID into `.latest`, leaving a pointer to an object that was never created. Treat that as a code defect, not a recovery guarantee.

Even on the normal dirty path, neither checkpointing nor unmount publishes a durable run-or-session-to-header head that a new Pod with a different volume ID can discover. If the implementation keeps a cumulative dirty bitmap, later checkpoints may also re-upload blocks included in an earlier checkpoint.

Durable objects still do not prove workspace resumability. If the latest header exists only in daemon memory or a node-local pointer keyed by the old volume ID, a replacement Pod with a new UID and volume ID starts from the original template. A stable run or session needs a durable, versioned head that another node can discover. [HE5: Durable state, continuity, and handoffs](../05-harness-engineering/05-durable-state-continuity-and-handoffs.md#a-stored-snapshot-is-not-yet-a-recovery-point) derives that publication protocol.

Transcript resume and filesystem resume are independent. Restoring model messages does not restore unpushed files. Until the platform publishes a cross-Pod filesystem head, push source changes to a remote repository or publish another external artifact before treating them as durable output.

Kubernetes can report that a volume is published and mounted; those facts do not prove its flush, snapshot, consistency, or recovery semantics. Read the exact driver contract before using it for write-sensitive state. Treat cache hit rate and occupancy as performance evidence, remote checkpoint publication as durability evidence, and a replacement-node restore test as recovery proof.

## Security needs independent gates

Role-based access control (RBAC) authorizes Kubernetes API operations. Service accounts identify workloads, while cloud workload identity maps them to narrowly scoped AWS roles. Pod Security Admission constrains dangerous Pod settings by namespace policy. NetworkPolicy limits selected packet flows when the installed network provider enforces it.

None replaces the others. A Pod may lack permission to list Secrets yet still reach an open database port; another may have network access but no database credential. Without a selecting ingress or egress NetworkPolicy, Kubernetes treats a Pod as non-isolated in that direction. Policies become additive once they select it, and both source egress and destination ingress must allow a restricted flow. Start with default-deny policy, then add the smallest API, network, cloud, and secret paths the workload needs.

## Walk a failed request from name to listening socket

Begin inside a disposable diagnostic Pod in the same namespace and policy context as the caller. Resolve the Service name and record the returned ClusterIP. Inspect the Service ports and selector, then list its EndpointSlices. No endpoints means the problem is usually selector match, Pod readiness, or endpoint ownership. Ready endpoints shift the next questions to NetworkPolicy, CNI routing, Service data-path programming, and whether the application listens on the declared target port and Pod address.

For external traffic, inspect Gateway and route status conditions before the cloud load balancer. A route can exist but be unattached because its parent reference, hostname, namespace permission, or controller support is wrong. For provisioned storage, follow PVC phase to StorageClass, selected or bound PV, scheduling events, CSI controller provisioning and attachment, then node staging and publishing. A Pod waiting on a volume in another zone is a topology problem; an attached volume that fails to publish may be a node plugin, filesystem, permission, or stale-attachment problem.

For inline CSI, start with the Pod's inline attributes and the `CSIDriver` object. Confirm that `Ephemeral` is advertised, then inspect `CSINode` for the selected node to prove that this driver registered there. Inspect the node DaemonSet and its registrar, then follow the kubelet event and `NodePublishVolume` log. For the object-backed design above, continue through `/dev/nbdN`, the host ext4 mount, the bind target, the private and shared caches, the active header, and the S3 objects. There is no PVC or controller attach to inspect on this path.

> **Policy check.** NetworkPolicy rules are additive for a selected Pod. Test both egress from the caller and ingress to the destination, and confirm the installed provider implements the policy types in use.

_Run read-only commands in the intended namespace. Use provider and node logs only after Kubernetes objects identify the failing boundary._

```text
kubectl get gateway,httproute,service,endpointslice,networkpolicy,pod
kubectl describe service <name>
kubectl describe pod <name>
kubectl get pvc,pv,storageclass
kubectl get csidriver
kubectl get csinode <selected-node> -o yaml
kubectl get daemonset -n kube-system
kubectl get events --sort-by=.metadata.creationTimestamp
```

## Summary

Kubernetes networking, storage, and security objects are requests to controllers and node plugins. Debugging starts by identifying the component that watches each object and the concrete route, mount, or policy state it was expected to create.

- CNI creates Pod interfaces, addresses, and routes; CoreDNS resolves names; EndpointSlices list ready Service backends; kube-proxy or an alternative programs the Service data path.
- In chained networking, the VPC CNI can own Pod interfaces and addresses while Cilium attaches eBPF policy and visibility. Ingress, egress, runtime, Kubernetes API, AWS API, and application authorization remain separate gates.
- A Service port is the stable client-facing port, while targetPort is the listening port on selected Pods. NodePort adds a node-facing port for the Service types that use it.
- ClusterIP, NodePort, LoadBalancer, and ExternalName expose a Service in different ways. Gateway and Ingress add protocol-aware routing in front of that stable backend contract.
- An internal NLB gives callers elsewhere in the VPC a stable private entry point. The AWS Load Balancer Controller converts the Service into listeners, target groups, health checks, and changing Pod registrations.
- EndpointSlice is the current backend-discovery API. The older Endpoints API is deprecated and can truncate a set larger than 1,000 endpoints.
- Trace service traffic in order: DNS → Service ports and selector → EndpointSlices → network policy → route or proxy rules → target listener. No endpoints usually means selector or readiness, not packet routing.
- L4 load balancing chooses with connection metadata. L7 proxying terminates protocol state and adds a separate upstream connection, HTTP routing, timeouts, buffering, and retry behavior.
- A PVC requests capacity, access mode, and a StorageClass. A provisioner supplies a volume and PV, a CSI controller may attach it, and the node plugin may stage it before publishing it. WaitForFirstConsumer helps align zone-bound storage with Pod placement.
- CSI does not dictate the storage backend or require PVC provisioning. An inline node-only driver can map a template ID through NBD, a host ext4 mount, and a bind mount while keeping clean shared reads and private writes in separate caches.
- An immutable diff and header in object storage become cross-Pod workspace state only when a durable head keyed by stable run identity lets another node discover them. Transcript resume is a different contract.
- Persistence does not imply backup, restore, or safe concurrent access. Reclaim policy and backend durability must match the application's recovery plan.
- RBAC, workload identity, Pod Security Admission, secret controls, and NetworkPolicy guard different operations. Passing one gate says nothing about the others.
- For an external failure, inspect Gateway or route attachment before the cloud load balancer. For a provisioned volume failure, follow PVC → StorageClass → PV → scheduling → attach → node publish. For an inline failure, follow Pod attributes → `CSIDriver` → selected-node `CSINode` registration → node plugin → device and mounts.

## References

- [Kubernetes Services, load balancing, and networking](https://kubernetes.io/docs/concepts/services-networking/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Gateway API concepts](https://gateway-api.sigs.k8s.io/docs/concepts/api-overview/)
- [Persistent volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Kubernetes volumes and CSI operations](https://kubernetes.io/docs/concepts/storage/volumes/#csi)
- [Kubernetes CSI ephemeral volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/#csi-ephemeral-volumes)
- [Deploying a CSI driver: controller and node components](https://kubernetes-csi.github.io/docs/deploying.html)
- [Using RBAC authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Kubernetes Service debugging](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Amazon VPC CNI concepts](https://docs.aws.amazon.com/eks/latest/userguide/managing-vpc-cni.html)
- [Cilium chaining with the AWS VPC CNI](https://docs.cilium.io/en/stable/installation/cni-chaining-aws-cni/)
- [Cilium Hubble](https://docs.cilium.io/en/stable/observability/hubble/)
- [AWS Load Balancer Controller: Network Load Balancer](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/nlb/)
- [Amazon EKS: Route TCP and UDP traffic with Network Load Balancers](https://docs.aws.amazon.com/eks/latest/userguide/network-load-balancing.html)
- [Kubernetes NodeLocal DNSCache](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)
- [Amazon EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html)

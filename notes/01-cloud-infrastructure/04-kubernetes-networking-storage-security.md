---
title: Kubernetes networking, storage, and security
description: Trace packets through Services and gateways, bind durable volumes with CSI, and layer workload security controls.
slug: kubernetes-networking-storage-security
order: 4
identifier: CI4
duration: 125 min
difficulty: Core
tags:
  - CNI
  - Services
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

Service type describes exposure, not the application protocol. `ClusterIP` supplies an internal virtual address. `NodePort` also opens a port on eligible nodes. `LoadBalancer` asks an installed cloud integration to provision or configure an external load balancer, while `ExternalName` returns a DNS alias and creates no proxy path. Gateway or Ingress adds L7 routing in front of Services; it does not replace the Service-to-endpoint contract.

New tooling should read EndpointSlices. Kubernetes deprecated the older Endpoints API in v1.33 because it truncates large backend sets and lacks dual-stack and newer routing data. Existing Endpoints objects still work, but their presence is not a reason to build another dependency on them.

> **Fictional case.** The bookshop cluster uses the Amazon VPC CNI for Pod addresses, CoreDNS plus NodeLocal DNSCache for lookup, and kube-proxy for Service traffic. A second toy cluster uses Cilium for both Service handling and NetworkPolicy, which is why diagnosis starts by identifying the installed implementation instead of assuming every cluster programs packets the same way.

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

The ordinary PVC, PV, and CSI path above is enough for a first reading. This case examines a driver whose block interface is assembled from object storage and node-local cache. Return to it after [LL4: Linux storage and I/O](../02-low-level-infrastructure/04-storage-and-io.md) and [CI14: Storage, backups, and disaster recovery](14-storage-backup-and-disaster-recovery.md) if flush, fencing, cache, and recovery contracts are unfamiliar.

CSI standardizes calls between Kubernetes and a storage driver; it does not require the driver to map a volume to a provider block disk. A driver commonly has a controller component for operations such as create, delete, attach, and detach, plus a per-node component that registers with kubelet and handles stage and publish calls. The backend can therefore have a different durability and caching model from EBS, provided the driver states and implements that model.

Suppose a toy driver exposes `archive-scratch` as a block device. Its authoritative chunks and volume manifest live in object storage, while a privileged node plugin keeps a disposable cache on local NVMe. After the external provisioner asks the controller to create a logical volume, the resulting PV stores an opaque volume handle. Once the scheduler chooses a node, kubelet asks that node's driver to stage the volume, the driver reconstructs or opens the virtual device, and kubelet mounts the filesystem into the Pod.

```text
PVC -> external provisioner -> CSI controller -> logical volume handle
Pod scheduled -> kubelet -> CSI node plugin -> virtual block device -> filesystem mount
read miss -> node cache miss -> object chunk fetch
acknowledged write -> durable chunk upload -> committed volume manifest
```

The final line is the important contract. If the driver acknowledges a flush before the new chunks and manifest are durable, losing the node can lose acknowledged data. If it waits for remote commit, node loss should discard only cache state, although recovery may be slow and object-store unavailability can stop cache misses or new commits. A stale node must not publish an older manifest after another node takes ownership, so multi-attach policy, leases or fencing, cache invalidation, and mount recovery belong in the driver design.

Kubernetes can report that the PVC is bound and the volume is mounted; those facts do not prove the driver's flush, snapshot, consistency, or recovery semantics. Read the exact driver contract before placing a database or another write-sensitive filesystem on it. Treat local cache capacity and hit rate as performance signals, remote manifest commit as durability evidence, and a restore test as separate proof.

## Security needs independent gates

Role-based access control (RBAC) authorizes Kubernetes API operations. Service accounts identify workloads, while cloud workload identity maps them to narrowly scoped AWS roles. Pod Security Admission constrains dangerous Pod settings by namespace policy. NetworkPolicy limits selected packet flows when the installed network provider enforces it.

None replaces the others. A Pod may lack permission to list Secrets yet still reach an open database port; another may have network access but no database credential. Without a selecting ingress or egress NetworkPolicy, Kubernetes treats a Pod as non-isolated in that direction. Policies become additive once they select it, and both source egress and destination ingress must allow a restricted flow. Start with default-deny policy, then add the smallest API, network, cloud, and secret paths the workload needs.

## Walk a failed request from name to listening socket

Begin inside a disposable diagnostic Pod in the same namespace and policy context as the caller. Resolve the Service name and record the returned ClusterIP. Inspect the Service ports and selector, then list its EndpointSlices. No endpoints means the problem is usually selector match, Pod readiness, or endpoint ownership. Ready endpoints shift the next questions to NetworkPolicy, CNI routing, Service data-path programming, and whether the application listens on the declared target port and Pod address.

For external traffic, inspect Gateway and route status conditions before the cloud load balancer. A route can exist but be unattached because its parent reference, hostname, namespace permission, or controller support is wrong. For storage, follow PVC phase to StorageClass, selected or bound PV, scheduling events, CSI controller operation, node attachment, and mount event. A Pod waiting on a volume in another zone is a topology problem; an attached volume that fails to mount may be a node plugin, filesystem, permission, or stale-attachment problem.

> **Policy check.** NetworkPolicy rules are additive for a selected Pod. Test both egress from the caller and ingress to the destination, and confirm the installed provider implements the policy types in use.

_Run read-only commands in the intended namespace. Use provider and node logs only after Kubernetes objects identify the failing boundary._

```text
kubectl get gateway,httproute,service,endpointslice,networkpolicy,pod
kubectl describe service <name>
kubectl describe pod <name>
kubectl get pvc,pv,storageclass
kubectl get events --sort-by=.metadata.creationTimestamp
```

## Summary

Kubernetes networking, storage, and security objects are requests to controllers and node plugins. Debugging starts by identifying the component that watches each object and the concrete route, mount, or policy state it was expected to create.

- CNI creates Pod interfaces, addresses, and routes; CoreDNS resolves names; EndpointSlices list ready Service backends; kube-proxy or an alternative programs the Service data path.
- A Service port is the stable client-facing port, while targetPort is the listening port on selected Pods. NodePort adds a node-facing port for the Service types that use it.
- ClusterIP, NodePort, LoadBalancer, and ExternalName expose a Service in different ways. Gateway and Ingress add protocol-aware routing in front of that stable backend contract.
- EndpointSlice is the current backend-discovery API. The older Endpoints API is deprecated and can truncate a set larger than 1,000 endpoints.
- Trace service traffic in order: DNS → Service ports and selector → EndpointSlices → network policy → route or proxy rules → target listener. No endpoints usually means selector or readiness, not packet routing.
- L4 load balancing chooses with connection metadata. L7 proxying terminates protocol state and adds a separate upstream connection, HTTP routing, timeouts, buffering, and retry behavior.
- A PVC requests capacity, access mode, and a StorageClass; a provisioner supplies a PV; CSI node components attach and mount it. WaitForFirstConsumer helps align zone-bound storage with Pod placement.
- CSI does not dictate the storage backend. For an object-backed virtual block device, distinguish disposable node cache from durable chunks and the committed volume manifest, then verify flush, fencing, and recovery behavior.
- Persistence does not imply backup, restore, or safe concurrent access. Reclaim policy and backend durability must match the application's recovery plan.
- RBAC, workload identity, Pod Security Admission, secret controls, and NetworkPolicy guard different operations. Passing one gate says nothing about the others.
- For an external failure, inspect Gateway or route attachment before the cloud load balancer. For a volume failure, follow PVC → StorageClass → PV → scheduling → attach → mount events.

## References

- [Kubernetes Services, load balancing, and networking](https://kubernetes.io/docs/concepts/services-networking/)
- [DNS for Services and Pods](https://kubernetes.io/docs/concepts/services-networking/dns-pod-service/)
- [Gateway API concepts](https://gateway-api.sigs.k8s.io/docs/concepts/api-overview/)
- [Persistent volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Kubernetes volumes and CSI operations](https://kubernetes.io/docs/concepts/storage/volumes/#csi)
- [Deploying a CSI driver: controller and node components](https://kubernetes-csi.github.io/docs/deploying.html)
- [Using RBAC authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Kubernetes Service debugging](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Amazon VPC CNI concepts](https://docs.aws.amazon.com/eks/latest/userguide/managing-vpc-cni.html)
- [Kubernetes NodeLocal DNSCache](https://kubernetes.io/docs/tasks/administer-cluster/nodelocaldns/)
- [Amazon EBS CSI driver](https://docs.aws.amazon.com/eks/latest/userguide/ebs-csi.html)

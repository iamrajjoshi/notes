---
title: Containers and cgroups
description: Assemble a Linux container from namespaces, cgroups, filesystems, credentials, and an OCI runtime contract.
slug: containers-and-cgroups
order: 6
identifier: LL6
duration: 145 min
difficulty: Core
tags:
  - containers
  - cgroups v2
  - OCI
  - Kubernetes
---

## Working model

A container is a normal host process with a prepared view and a resource contract. Namespaces change what it can identify, cgroups account and control consumption, and security policy narrows what its credentials may do.

## Start with an image and end with a host process

A container image is packaged filesystem content plus launch metadata. A registry stores and distributes that content. A container manager pulls the selected image, prepares a writable runtime view and an Open Container Initiative (OCI) bundle, then asks a low-level runtime to create the process described by the bundle.

The resulting **container** is not the image file. It is one or more running host processes plus their prepared namespaces, mounts, cgroup membership, credentials, and security policy. Stopping the processes ends execution, while the immutable image can start another instance. A runtime may retain the stopped instance's writable layer, but replacement or removal can discard it; state that must survive those events belongs on a durable volume or in an external service.

```text
registry image
  -> unpacked root filesystem + OCI configuration
  -> runtime prepares kernel state
  -> exec application as a host process
```

## No single kernel feature creates a container

PID, mount, network, IPC, UTS, user, cgroup, and time namespaces isolate selected views. A mount namespace plus a prepared root filesystem changes the visible file tree; overlay filesystems commonly compose immutable image layers with a writable upper layer.

### Overlay layers do not erase filesystem semantics

A lookup can cross lower and upper layers, whiteouts represent removed lower names, and copy-up can turn the first write into extra metadata and data work. Inspect the merged mount and backing storage when container writes stall.

[Linux kernel: OverlayFS](https://docs.kernel.org/filesystems/overlayfs.html)

## The runtime prepares a process with fewer rights

Capabilities, seccomp, and LSM policy reduce authority. An OCI runtime reads a configuration that describes the process, root filesystem, namespaces, mounts, resources, and hooks, then asks the host kernel to create that state. The container still shares the host kernel.

A user namespace maps container IDs to host IDs and scopes many capability checks. Root inside that namespace is not root in the initial user namespace, but it can still exercise authority over resources owned by its namespace. A bind mount, device node, host socket, broad capability, or permissive seccomp profile can expose an interface that the namespace alone does not make safe.

> **Container boundary.** A kernel escape crosses every ordinary container on that host. Use a VM-backed runtime when the threat model requires a separate guest kernel.

### RuntimeClass can insert a userspace kernel

In Kubernetes, `runtimeClassName` selects a cluster-defined `RuntimeClass`. A value such as `gvisor` is a lookup name, not a built-in Kubernetes keyword. The `RuntimeClass` maps that name to a container-runtime handler, and that handler must be installed and configured on every node eligible to receive the Pod. Missing node support causes startup failure rather than an automatic fallback.

The ordinary `runc` path lets the container process issue syscalls to the host kernel after namespace, cgroup, capability, seccomp, and LSM setup. gVisor's `runsc` path puts a userspace application kernel, called Sentry, between the process and a narrower host interface.

```text
runc:   process -> host Linux syscall interface
gVisor: process -> Sentry userspace kernel -> narrower host interface
```

gVisor reduces direct host-kernel syscall exposure, but it still consumes CPU and memory on the same node and depends on host networking, storage, and scheduling. It is not a VM or a separate node. Compatibility and syscall-heavy performance can differ from ordinary containers. A `RuntimeClass` can declare scheduling constraints and runtime overhead, but the node image still has to install the handler.

Kata Containers uses a different boundary: the workload runs with a guest kernel inside a virtual machine while Kubernetes retains Pod-oriented lifecycle. [LL9: MicroVMs and Kata](09-microvms-and-kata.md) compares that guest-kernel path with ordinary containers.

## An OCI start assembles kernel state before exec

A container manager prepares an OCI bundle containing config.json and a root filesystem, then asks a low-level runtime to create the container. The runtime joins or creates the requested namespaces, places the process in its cgroup, constructs the mount tree, installs bind mounts and pseudo-filesystems, and changes the process's root. User and group ID mappings may need privileged setup outside the new user namespace before the child can continue.

The runtime then applies credentials, capability sets, resource limits, no-new-privileges, seccomp, and the requested LSM label before exec replaces the setup program with the container command. Inside a new PID namespace that command can see itself as PID 1 while the host assigns another PID. A manager can retain a pidfd or namespace handles to monitor and later enter the container without treating the inner PID as a host identity.

Failures belong to different phases. A missing image file precedes runtime creation; an invalid mount or ID map fails during setup; seccomp and LSM denials usually appear when the process attempts a restricted operation; cgroup placement can fail because the manager lacks delegation. Record the runtime error, host PID, bundle digest, cgroup path, namespace identifiers, mountinfo, and audit records before cleanup removes the evidence.

_Ordering varies by runtime and namespace requirements, but exec happens after the process environment is prepared._

```text
OCI bundle -> namespaces + ID maps -> cgroup placement
  -> rootfs and mounts -> credentials + limits + security policy
  -> exec container process -> monitor with host PID and optional pidfd
```

### Compare desired OCI state with the live process

Read the bundle configuration, then inspect /proc/<host-pid>/status, cgroup, uid_map, gid_map, ns, mountinfo, and fd. A runtime can accept a configuration while host policy, kernel support, or later hooks produce different live state.

[Open Container Initiative: Linux runtime configuration](https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md)

## cgroup v2 organizes control in one hierarchy

A cgroup groups processes for accounting and controller policy. In v1, controllers could mount separate hierarchies, allowing one process to occupy different group shapes for CPU and memory. v2 uses one hierarchy with explicit controller delegation, which makes composition and ownership clearer.

In v2, a parent exposes available controllers through cgroup.controllers and enables selected controllers for children through cgroup.subtree_control. Domain controllers normally require processes to live in leaf cgroups rather than internal nodes. Moving one process or enabling one controller without respecting that tree can fail even when file permissions look open.

Threaded subtrees are the deliberate exception. `cgroup.type` identifies a normal domain, threaded domain, threaded cgroup, or invalid topology; only controllers that support thread mode can operate inside that subtree. Do not work around a no-internal-process error by scattering threads until the resource domain matches the intended ownership.

CPU weight distributes contested time, while CPU max can impose a quota and cause throttling. Memory low expresses protected demand, memory high applies reclaim pressure, and memory max is a hard boundary. PSI reports time lost to CPU, memory, or I/O pressure, often before coarse utilization graphs reveal the stall.

Cgroup v2 device access does not use a writable set of device-controller files. The kernel implements it with BPF_PROG_TYPE_CGROUP_DEVICE programs attached to cgroups, and each access check carries operation type plus the device's type and major/minor numbers. A runtime may translate OCI device rules into this mechanism; inspect the live BPF attachment when the configured rule and the observed EPERM disagree.

_Representative cgroup v2 files; available controllers depend on the host._

```text
/sys/fs/cgroup/team/service
  cgroup.procs
  cpu.weight
  cpu.max
  memory.current
  memory.high
  memory.max
  memory.events
```

## Move to v2 as a userspace migration, not a mount swap

Start by identifying the active layout. `stat -fc %T /sys/fs/cgroup` reports cgroup2fs for a unified v2 mount, while /proc/self/cgroup and mountinfo reveal single, split, or hybrid membership. Inventory every runtime, agent, and script that reads v1 controller paths or writes v1-only files; a compatible kernel cannot repair incompatible userspace.

On a systemd host, PID 1 owns the top-level tree. A container manager or service that needs child cgroups should request Delegate= on its service or scope, create descendants only below that boundary, and enable controllers through its own cgroup.subtree_control. Two writers managing the same nodes will eventually undo each other's placement or policy.

Before removing v1 boot settings or mounts, test the runtime and kubelet cgroup driver, CPU throttling, memory and swap behavior, OOM events, pressure metrics, device access, nested containers, and monitoring labels. Compare workload evidence across the change; matching directory names do not prove matching enforcement.

_Replace UNIT with a service you own. These checks reveal hierarchy and ownership without changing controller state._

```shell
stat -fc %T /sys/fs/cgroup
cat /proc/self/cgroup
findmnt -R /sys/fs/cgroup
cat /sys/fs/cgroup/cgroup.controllers
systemctl show -p ControlGroup -p Delegate UNIT
```

### Translate semantics, not filenames

v1 allowed controller-specific membership and exposed different resource files. Build a table of every v1 read or write, its desired behavior, the v2 replacement, and the metric or failure test that proves the translation.

[Linux kernel: cgroup v1 overview](https://docs.kernel.org/admin-guide/cgroup-v1/cgroups.html)

### Delegate one subtree to one writer

Delegate= marks the boundary where systemd leaves descendants to a service or scope. The manager still must create leaf cgroups, enable available controllers, and keep its own processes out of internal domain nodes.

[systemd: control group APIs and delegation](https://systemd.io/CGROUP_DELEGATION/)

## Kubernetes reaches the kernel through node software

A **Pod** is Kubernetes' smallest scheduling unit: one or more containers that must run together. A **node** is the worker machine whose kernel runs those container processes. The control-plane **scheduler** normally selects a node for an unscheduled Pod; the node's **kubelet** then works to make the assigned Pod match its spec. For the broader object model, read [Containers and the Kubernetes object model](../01-cloud-infrastructure/02-containers-and-kubernetes-objects.md).

The kubelet asks a **container runtime**, such as containerd or CRI-O, to prepare the Pod sandbox and containers through the Container Runtime Interface (CRI). The runtime pulls and unpacks images, then uses an OCI-compatible low-level runtime to create each **OCI container**: an execution environment containing host processes with prepared namespaces, mounts, credentials, and cgroup membership. Kubelet and runtime use the same cgroup driver so those processes enter the intended Pod and container cgroups.

```text
Pod spec -> scheduler binds Pod to a node -> node kubelet
  -> container runtime -> OCI runtime creates host processes
  -> Pod and container cgroups -> kernel accounts for and controls resources
```

## Kubernetes requests and limits serve different decisions

The scheduler places a Pod using declared requests, node capacity, and scheduling policy rather than live CPU usage. On the node, the kubelet and runtime arrange cgroups for Pods and containers according to the cgroup driver and QoS configuration.

A CPU request influences placement and relative entitlement under contention; a CPU limit generally becomes quota and can throttle. Memory enforcement is reactive: pressure, reclaim, cgroup OOM, and eviction can happen at different layers. Current Kubernetes guidance favors cgroup v2, while v1 belongs in compatibility and migration material.

## Summary

A container is a host process assembled from several kernel contracts, not one isolation primitive. The runtime prepares namespaces, mounts, credentials, policy, and cgroup placement before exec, while the resulting process continues to share the host kernel.

- Namespaces isolate selected views; the root filesystem and mounts define visible files; overlay layers add copy-up and whiteout behavior. None creates a separate kernel.
- An image is packaged filesystem content and metadata. A running container is a set of host processes plus prepared kernel state; its writable layer is not an automatic durability boundary.
- An OCI start prepares namespaces and ID maps, cgroup placement, root and mounts, credentials, limits, capabilities, seccomp, and LSM state before exec.
- `runtimeClassName` selects an installed runtime handler. gVisor inserts a userspace kernel in front of a narrower host interface while still sharing node CPU, memory, networking, and storage.
- Compare the OCI bundle with the live host process through status, cgroup, ID maps, namespace links, and mount information. An accepted configuration does not prove every intended control took effect.
- Cgroup v2 uses one hierarchy. Parents expose controllers, enable them for children, and normally keep domain-controller processes in leaf cgroups; threaded subtrees have separate topology rules reported by cgroup.type.
- CPU weight distributes contested time, CPU max can throttle, memory high can force reclaim stalls, memory max is a hard boundary, and pressure data reports time lost to contention.
- Device access on v2 uses cgroup BPF rather than controller files, so OCI device intent must be checked against the attached program and live device identity.
- A v1-to-v2 move is a userspace migration: inventory every reader and writer, runtime driver, monitoring path, swap behavior, OOM signal, and nested-container assumption.
- On systemd hosts, request delegation and let one manager own each subtree. In Kubernetes, requests drive scheduling while kubelet and runtime translate policy into node cgroups; limits govern runtime behavior.

## References

- [Linux kernel: cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html): Defines the unified hierarchy, controller enablement, delegation model, and resource files.
- [Open Container Initiative: Linux runtime configuration](https://github.com/opencontainers/runtime-spec/blob/main/config-linux.md)
- [Kubernetes RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/)
- [gVisor with Kubernetes](https://gvisor.dev/docs/user_guide/quick_start/kubernetes/)
- [systemd: control group APIs and delegation](https://systemd.io/CGROUP_DELEGATION/): Explains systemd ownership, Delegate=, and safe subtree management on cgroup v2.
- [Kubernetes: cgroups v2](https://kubernetes.io/docs/concepts/architecture/cgroups/)
- [Kubernetes: container resource management](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)

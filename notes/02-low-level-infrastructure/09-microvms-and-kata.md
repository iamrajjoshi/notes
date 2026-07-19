---
title: Firecracker, Cloud Hypervisor, and Kata
shortTitle: MicroVMs
description: Compare a general virtual machine, a reduced cloud VMM, and a container runtime backed by a guest kernel.
collection: low-level-infrastructure
slug: microvms-and-kata
order: 9
number: LL9
duration: 95 min
difficulty: Advanced
tags:
  - Firecracker
  - Cloud Hypervisor
  - Kata Containers
  - microVM
---

## Working model

MicroVMs remove machine surface rather than removing the VM boundary. Kata then wraps that boundary in container-runtime plumbing so an orchestrator can request a Pod while a guest kernel supplies the stronger isolation layer.

## Questions this note answers

- Explain which device and workload choices make a VM a microVM in practice
- Trace Firecracker's process, API, vCPU, virtio, jailer, and seccomp boundaries
- Describe Cloud Hypervisor's cloud-workload scope
- Explain how Kata presents an OCI container while running its workload inside a VM
- Separate memory snapshot state from disk state and external network state

## Firecracker narrows the device model

Firecracker runs a microVM in a host process, creates vCPU threads that enter KVM, and exposes a deliberately small set of virtio devices such as block, network, and vsock. The reduced emulation surface supports fast startup and dense cloud workloads, but it also rules out many devices and guest assumptions that QEMU can support.

The jailer prepares host namespaces, cgroups, a restricted filesystem view, and reduced privileges. Seccomp filters the VMM's syscalls. These are defense-in-depth layers around the VM boundary; they do not make untrusted network policy or host patching someone else's job.

## A Firecracker microVM starts through separate host and guest phases

A production launcher first prepares the kernel image, root disk, TAP device, cgroup policy, and any files that the jailed process must reach. A TAP device is a virtual network interface that exchanges Ethernet frames with a user-space process, allowing the VMM to connect guest networking to host routes or a bridge. The jailer creates the restricted host environment, drops privilege, and execs Firecracker. One Firecracker process owns one microVM; its API thread handles control requests, its VMM thread manages the machine model, and each configured guest CPU has a vCPU thread that enters KVM_RUN.

Before InstanceStart, the launcher uses the API to define boot source, memory, vCPUs, and supported devices. Startup then crosses KVM entry, guest kernel initialization, root-device discovery, and guest init before the workload becomes ready. A fast API response measures only the control plane. Readiness belongs after the guest or service produces a signal tied to useful work.

Each phase leaves different evidence. An inaccessible backing file points to jail or ownership setup; a KVM error stays on the host; a kernel panic needs guest boot output; a service timeout after guest init belongs above the VMM. Firecracker supplies TAP-backed networking but does not filter guest traffic, so a missing packet also requires host route and policy inspection.

_Use a readiness event from the last required phase; process creation alone understates startup time._

```text
host assets + TAP + cgroup -> jailer -> Firecracker API configuration
  -> InstanceStart -> vCPU KVM_RUN -> guest kernel -> guest init -> service ready
```

### The API thread is not the guest I/O path

Firecracker separates control requests from vCPU and VMM work. Diagnose a slow or rejected API operation separately from virtio queue latency, host TAP behavior, or guest execution.

[Firecracker: design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)

## Cloud Hypervisor targets current cloud guests

Cloud Hypervisor is a Rust VMM built around KVM on Linux and virtio-oriented devices for cloud workloads. It chooses a smaller hardware model than a broad system emulator while retaining features such as hotplug, snapshots, and migration according to its supported release matrix.

Neither reduced VMM is a universal QEMU replacement. Firmware, device compatibility, guest operating systems, migration format, operational tooling, and security review decide whether the smaller surface fits.

> **Version the claim.** Snapshot, migration, device, and architecture support changes by release. Link the feature documentation instead of freezing a feature matrix in these notes.

## Kata keeps container ergonomics and adds a guest kernel

Kata integrates with containerd through a shim and starts workloads in a lightweight VM. An agent inside the guest creates and manages the container processes; the host-side runtime coordinates lifecycle, storage, networking, and the selected VMM.

A Kubernetes RuntimeClass can select the Kata handler while the Pod keeps an OCI-facing lifecycle. The host shim creates or joins the configured sandbox VM, connects control transport to the agent, and passes process, mount, network, and resource requests inward. The agent applies the guest-side container setup and reports exit state back through the shim. Host cgroups constrain VMM processes; guest cgroups constrain workloads inside the VM, so both layers matter during resource diagnosis.

A create timeout can come from the container manager, shim, VMM launch, guest boot, control transport, agent, storage setup, or final exec. Capture correlated identifiers at the Kubernetes Container Runtime Interface (CRI) request, shim, VM, and guest process layers. Restarting the shim before collecting them can turn one failure into an unexplained sandbox loss.

### Check the host before treating Kata as available

Kata needs bare-metal virtualization or usable nested virtualization. Run the project's host capability check and record the selected hypervisor, kernel, runtime configuration, and RuntimeClass with the result.

[Kata Containers: software architecture](https://katacontainers.io/software/)

## A VM snapshot does not capture its whole environment

A snapshot captures defined VM memory and device state, not the whole surrounding system by magic. Firecracker manages guest-memory snapshot files separately from guest disks, while tap devices, host filtering, credentials, and remote services still need explicit lifecycle handling.

Restore also needs compatible CPU exposure, VMM and snapshot format, device configuration, guest disk contents, and host resources. If disk data advances after memory state freezes, replayed guest buffers can disagree with the backing image. Quiesce the application or define a storage snapshot order that creates one recoverable point; pausing vCPUs alone does not coordinate a remote database or network peer.

Memory snapshots contain application data, credentials, and encryption material that existed in RAM. Protect them as sensitive state, verify integrity before restore, and define deletion. Recreated TAP devices and connections acquire new host-side lifetimes, while guest clock behavior and expired external leases can make a technically successful resume fail at the application layer.

### Bind the files into one restore manifest

Record snapshot format and VMM version, memory and state file hashes, kernel and root-disk identity, CPU template, network reconstruction steps, and application quiesce status. Reject a restore when the manifest no longer matches its backing resources.

[Firecracker: snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)

## Measure launch, steady state, and restore as different workloads

For launch, timestamp request receipt, jailer completion, VMM configuration, first KVM entry, guest kernel milestones, agent readiness, and service readiness on one host clock where possible. Report cold and warm image conditions separately. A guest boot timestamp cannot reveal time spent before vCPU start, and a host process timestamp cannot show guest initialization.

For steady state, collect VMM logs and counters, host cgroup CPU and memory, vCPU and I/O thread scheduling, TAP and block-backend counters, guest pressure, and application latency. Density tests must include host page cache, guest kernels, VMM processes, file descriptors, cgroup limits, and the workload's peak memory rather than dividing physical RAM by configured guest memory.

Restore tests add snapshot read time, page-fault behavior, device reconstruction, clock jumps, network reconnection, and the first real request. Keep software release, machine type, CPU template, kernel, root image, storage mode, and host load fixed between comparisons. Firecracker, Cloud Hypervisor, and Kata expose different control and data paths, so one tool's startup number cannot rank all three without an identical readiness boundary.

_Publish phase distributions and failure counts; a single elapsed-time average hides the slow phase._

```text
launch: request -> jailer/VMM -> KVM -> kernel -> agent/init -> service
steady: vCPU + VMM I/O + host scheduler/storage/network + guest workload
restore: files -> VM state -> devices -> reconnect -> first successful request
```

## Summary

MicroVMs keep the guest-kernel boundary while reducing the emulated machine and management surface. Kata adds container-runtime plumbing around a lightweight VM, so the orchestrator sees a Pod lifecycle while host and guest components share responsibility for startup, resources, and failure.

- Firecracker uses KVM with a small virtio device set; the jailer, namespaces, cgroups, reduced privilege, and seccomp add host-side defense around the VM.
- Measure startup as launcher assets and TAP → jailer → VMM API → first KVM entry → guest kernel → guest init or agent → service readiness. Process creation is not service readiness.
- Cloud Hypervisor also targets current cloud guests with a smaller device model. Device, snapshot, migration, and architecture support must be checked against the selected release.
- Kata uses a host shim and VMM plus a guest agent. Host cgroups constrain VMM processes; guest cgroups constrain workload processes, so resource diagnosis needs both layers.
- A create timeout can occur in the container manager, shim, VMM launch, guest boot, control transport, agent, storage setup, or final exec. Preserve identifiers across all of them.
- A VM snapshot covers defined memory and device state, not disks, TAP setup, remote services, credentials, or external leases. Bind compatible files and reconstruction steps in one restore manifest.
- Compare launch, steady state, and restore separately, with fixed versions, machine type, CPU exposure, image, storage mode, host load, and the same useful-readiness boundary.

## References

- [Firecracker: design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
- [Firecracker: snapshot support](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [Cloud Hypervisor: introduction](https://www.cloudhypervisor.org/docs/prologue/introduction/)
- [Cloud Hypervisor: live migration](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/live_migration.md)
- [Cloud Hypervisor: snapshot and restore](https://github.com/cloud-hypervisor/cloud-hypervisor/blob/main/docs/snapshot_restore.md)
- [Cloud Hypervisor: project repository](https://github.com/cloud-hypervisor/cloud-hypervisor)
- [Kata Containers: software architecture](https://katacontainers.io/software/)

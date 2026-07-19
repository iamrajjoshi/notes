---
title: KVM, QEMU, hypercalls, and virtio
shortTitle: Virtual machines
description: Separate the kernel virtualization API, virtual machine monitor, guest kernel, and device path behind a Linux virtual machine.
collection: low-level-infrastructure
slug: kvm-qemu-and-virtio
order: 8
number: LL8
duration: 140 min
difficulty: Advanced
tags:
  - KVM
  - QEMU
  - virtio
  - hypercall
---

## Working model

A VM has two operating-system layers. The guest kernel manages guest processes and virtual devices; the VMM builds the virtual machine in host user space, while KVM lets its vCPU threads enter hardware-assisted guest execution.

## Questions this note answers

- Explain KVM's role without calling it a complete VM product
- Describe QEMU's machine and device-model responsibilities
- Distinguish syscalls, explicit hypercalls, and other VM exits
- Trace a virtio request through guest and host components
- Explain why an IOMMU matters for direct device access

## A virtual machine includes a second kernel

A container isolates host processes while sharing the host kernel. A virtual machine presents virtual CPUs, memory, interrupts, and devices to a **guest** operating system, so the guest runs its own kernel. The physical machine and operating system underneath are the **host**.

The names describe different roles:

| Term         | Meaning                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Hypervisor   | The virtualization layer that controls guest execution and access to physical resources; the term may include kernel and user-space pieces |
| VMM          | The virtual machine monitor process that constructs and manages a VM's memory and device model                                             |
| Guest kernel | The operating-system kernel inside the VM; it schedules guest processes and drives virtual devices                                         |
| vCPU         | Guest-visible CPU state, commonly executed by a host VMM thread through hardware virtualization                                            |
| Device model | Software or assigned hardware that presents storage, networking, timers, interrupts, and other devices to the guest                        |

Hardware virtualization lets ordinary guest instructions run directly on a physical CPU under controlled state. Selected events transfer control back to the host. This is why a VM can provide a separate kernel boundary without interpreting every instruction in software.

```text
guest application -> guest syscall -> guest kernel -> virtual device
                                                -> VMM or host backend
host VMM vCPU thread -> KVM -> hardware-assisted guest execution
```

## KVM supplies execution primitives; a VMM assembles the VM

Kernel-based Virtual Machine (KVM) exposes file-descriptor and device-control (`ioctl`) APIs for creating a VM, mapping guest memory, creating vCPUs, and entering guest execution. A vCPU is normally represented by a host thread that calls KVM_RUN.

QEMU can emulate a complete machine in software, but on Linux it commonly uses KVM for hardware-assisted CPU and memory virtualization while retaining responsibility for machine construction, firmware and device models. Firecracker and Cloud Hypervisor use KVM too, with different device and management choices.

_Conceptual KVM control flow, not a complete setup program._

```text
host process opens /dev/kvm
  -> creates VM and vCPU file descriptors
  -> maps guest memory
  -> vCPU thread enters KVM_RUN
  -> VM exit returns control for selected events
```

## Guest memory crosses two page-table contracts

A guest process translates its virtual address to a guest-physical address through page tables owned by the guest kernel. Hardware then applies a second-stage translation, called Extended Page Tables (EPT) on Intel or Nested Page Tables (NPT) on AMD, from that guest-physical address to host physical memory. Translation Lookaside Buffer (TLB) entries can cache the combined result. A missing guest page can therefore fault entirely inside the guest, while a missing or protected second-stage mapping gives KVM work at the host layer.

The VMM registers guest-physical ranges as KVM memory slots backed by host virtual mappings. Those host pages can be demand-faulted, placed on NUMA nodes, shared, or pinned according to the configuration. Guest free memory is not automatically host free memory; ballooning, virtio-mem, or explicit unplug coordinates reclamation, whereas blind host overcommit can stall vCPU threads in reclaim and make the guest report latency with no obvious guest allocator failure.

Virtualization literature calls the physical host hypervisor **L0**. A hypervisor running as its guest is **L1**, and a nested guest beneath that is **L2**. This note needs only L0: the guest owns its first translation, while L0 ultimately owns the host frame and second stage. [Nested virtualization](10-device-assignment-and-nested-virtualization.md) follows all three levels.

```text
guest VA --guest page tables--> guest physical address
  --EPT/NPT or other stage-2 tables--> host physical frame
  ^ combined translations may be cached in the TLB
```

### Dirty tracking changes the write path

Migration and snapshot code can ask KVM to report pages written since an earlier point. The chosen dirty-log mode, clear operation, and stop-and-copy boundary affect overhead and consistency; a memory image without synchronized virtual-device and disk state is not a restorable VM.

[Linux kernel: KVM API](https://docs.kernel.org/virt/kvm/api.html)

## A VM exit describes a control transfer, not one cause

A syscall moves a guest application into its guest kernel and may execute without leaving guest mode. A hypercall is an explicit guest request to a hypervisor-defined interface. A VM exit is the hardware transfer out of guest execution caused by a configured event, which can include privileged instructions, selected I/O, faults, interrupts, or hypercalls.

Exit frequency matters because the host must regain control and later re-enter the guest. Hardware virtualization avoids trapping ordinary instructions, while paravirtual interfaces reduce the need to emulate legacy devices one register operation at a time.

> **Do not count syscalls as exits.** A normal guest syscall usually stays inside guest execution. Measure actual VM exits before blaming virtualization overhead.

## virtio standardizes a cooperative device interface

A guest virtio driver places descriptors into a virtqueue and notifies a device implementation. A host backend consumes the request, performs host I/O, records completion, and signals the guest. Shared queues and batching avoid much of the cost of pretending to be a legacy physical device.

For device assignment, an input-output memory management unit (IOMMU) translates and restricts direct memory access (DMA) so a device cannot write arbitrary host memory. The Linux VFIO framework exposes controlled user-space device access; a later note follows that path into PCIe and GPUs.

## A split-virtqueue block read moves ownership through a queue

A guest cache miss reaches the virtio block driver, which builds a descriptor chain for the request header, data buffer, and status byte. In the split-virtqueue layout, the driver publishes the head descriptor in the available ring after the required memory ordering and may notify the device. Negotiated notification suppression can avoid a kick, so lack of one notification does not imply a lost request. A packed virtqueue uses one descriptor ring plus wrap counters rather than separate available and used rings; the negotiated queue format decides which ownership rules apply.

A QEMU device model, a vhost-user process, or another configured backend consumes the chain and maps the guest buffers into its host I/O path. Completion updates the used ring and may notify the guest; the guest driver matches the returned descriptor, reads status, and completes the original block request. Host file caching, direct I/O, image formats, throttling, and the physical device can each add a queue. A guest fsync requires negotiated flush semantics and every backend in the chain to preserve the durability contract.

_For a split virtqueue, available and used indexes transfer buffer ownership; notification suppression only changes how each side learns about progress._

```text
guest block request -> descriptor chain -> available ring -> optional kick
  -> device/backend -> host storage -> used ring -> optional interrupt
  -> guest driver status -> requesting task wakes
```

### The driver must tolerate a spurious notification

Virtio notification suppression is an optimization rather than a synchronized promise. The driver checks ring indexes and descriptor state, while the device must handle a notification that arrives after it already observed the available work.

[OASIS: Virtual I/O Device specification 1.4](https://docs.oasis-open.org/virtio/virtio/v1.4/virtio-v1.4.html)

## Split guest delay among vCPU, exit, VMM, and backend time

A guest reports what it can see: run-queue delay, steal time, I/O wait, device latency, and its own pressure. On the host, map each guest vCPU to its QEMU thread, inspect host scheduler delay and cgroup throttling, then count KVM exits by reason. An exit rate alone is weak evidence; record time per exit and the work done before re-entry. Device-emulation threads and vhost workers can bottleneck even when vCPU threads have spare CPU.

For a slow virtual disk request, align a guest block trace with virtqueue, KVM, QEMU, host filesystem, and block-device events. `perf kvm stat`, `kvm_stat`, KVM tracepoints, QMP state, and per-thread scheduling tools provide different pieces, subject to build and permission. Retain CPU model, machine type, accelerator, cache mode, image format, queue count, host NUMA placement, and guest kernel with the result.

_Tool syntax and access vary by distribution. Use the monitor command supported by the selected management layer._

```shell
ps -L -p QEMU_PID -o pid,tid,psr,stat,comm
pidstat -t -p QEMU_PID 1
perf kvm stat live -p QEMU_PID
kvm_stat
virsh qemu-monitor-command VM --hmp 'info status'
```

### Finish an incomplete exit before migration

For several userspace-handled KVM exit types, the operation becomes complete only when userspace calls KVM_RUN again. A VMM must finish that pending state before it captures migration-visible CPU state, or the destination can resume from an inconsistent boundary.

[Linux kernel: KVM API](https://docs.kernel.org/virt/kvm/api.html)

## Summary

KVM, the VMM, and the guest kernel own different parts of a virtual machine. Performance and correctness questions become easier when CPU entry, address translation, device emulation, host I/O, and guest-visible completion remain separate boundaries.

- KVM exposes file-descriptor and ioctl primitives for VM memory, vCPUs, and guest entry. QEMU or another VMM constructs the machine, firmware, devices, and management surface.
- A VM contains its own guest kernel, while a container uses the host kernel. The VMM constructs the virtual machine; KVM and the processor execute controlled guest CPU state.
- Guest virtual addresses first translate to guest physical addresses, then EPT or NPT translates them to host frames. Faults can belong to either stage.
- A guest syscall normally stays inside guest execution. A hypercall is explicit guest-to-hypervisor communication; a VM exit is a hardware control transfer caused by one of several configured events.
- Virtio transfers descriptor ownership through negotiated split or packed queue rules. Split queues use available and used rings; packed queues use one descriptor ring and wrap counters. Notification suppression changes how peers learn about work, not the requirement to check queue state.
- A guest fsync is durable only if the virtio flush contract and every host cache, filesystem, image, and device layer preserve it.
- Guest memory size is not automatically reclaimable host memory. Ballooning, virtio-mem, or unplug coordinates recovery; uncontrolled host overcommit can stall vCPU threads.
- Split slow I/O among guest queueing, vCPU scheduling, exits, VMM or vhost work, host filesystem, and device time. Count exit time and reason, not only exit rate.

## References

- [Linux kernel: KVM API](https://docs.kernel.org/virt/kvm/api.html)
- [Linux kernel: KVM x86 hypercalls](https://docs.kernel.org/virt/kvm/x86/hypercalls.html)
- [QEMU: system emulation introduction](https://www.qemu.org/docs/master/system/introduction.html)
- [QEMU: virtio devices](https://www.qemu.org/docs/master/system/devices/virtio/index.html)
- [OASIS: Virtual I/O Device specification 1.4](https://docs.oasis-open.org/virtio/virtio/v1.4/virtio-v1.4.html)

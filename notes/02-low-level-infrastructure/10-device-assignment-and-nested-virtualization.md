---
title: PCIe assignment, GPUs, and nested virtualization
shortTitle: Devices and nesting
description: Follow DMA through an IOMMU, compare GPU-sharing boundaries, and reason about a guest hypervisor running another guest.
collection: low-level-infrastructure
slug: device-assignment-and-nested-virtualization
order: 10
number: LL10
duration: 140 min
difficulty: Advanced
tags:
  - PCIe
  - VFIO
  - GPU passthrough
  - nested virtualization
---

## Working model

Device assignment gives a guest a shorter I/O path only after the host builds a DMA fence around it. Nested virtualization adds another manager of privileged CPU and memory state; neither technique removes the layers it asks hardware to accelerate.

## Questions this note answers

- Explain PCIe functions, BARs, DMA, IOMMU translation, and VFIO assignment
- Contrast whole-device passthrough with SR-IOV virtual functions
- Distinguish passthrough, mediated vGPU, time slicing, and MIG
- Map L0, L1, and L2 roles in nested virtualization
- Name the workload and feature checks required before claiming a nesting overhead

## A PCIe device moves data through queues and DMA

PCI Express (PCIe) connects devices such as network adapters, storage controllers, and GPUs to the host. One physical device can expose one or more **functions**, each identified by a domain, bus, device, and function address. A kernel driver claims the function and programs it.

Base Address Registers (BARs) describe device regions that software maps for memory-mapped I/O. The driver writes device registers and queue addresses through those mappings. **Direct memory access (DMA)** then lets the device read or write configured memory without asking a CPU to copy each byte. The device can raise an interrupt, often through Message Signaled Interrupts (MSI or MSI-X), so the driver learns that work completed.

```text
driver writes command and buffer address to device queue
  -> device performs DMA between device and memory
  -> device reports completion through queue state and interrupt
  -> driver wakes or completes the waiting request
```

That speed creates an isolation problem. A device given an unrestricted physical address could corrupt the kernel or another guest. The input-output memory management unit (IOMMU) adds address translation and access checks for device DMA, much as the memory management unit (MMU) constrains CPU memory access.

## The IOMMU makes device assignment defensible

A PCIe function exposes configuration space and memory-mapped regions through BARs. It can use DMA to read or write memory without asking a CPU to copy each byte. Direct assignment therefore needs an IOMMU domain that translates device-visible addresses and restricts the physical pages the function may reach.

The Linux VFIO framework gives user-space VMMs controlled access to devices and interrupt delivery. The legacy VFIO API is group-centric; IOMMUFD supplies a newer device-centric user API for I/O page tables and DMA mappings. That API change does not create finer hardware isolation. The kernel still has to honor the IOMMU topology, and reset behavior plus host-driver ownership still decide whether reassignment is safe.

> **Inspect the group.** Passing one function while a tightly coupled peer remains host-controlled can break the isolation claim. Check PCIe Access Control Services (ACS) topology, the IOMMU group, reset support, and the current VFIO/IOMMUFD path.

## A passed-through function changes owners and address spaces

Start with a PCIe function owned by a host driver. The operator identifies every function in its isolation group, stops workloads using them, and moves the selected device to the VFIO path. The VMM opens the VFIO or IOMMUFD objects, attaches the device to an IOMMU domain, maps selected guest memory at device-visible I/O virtual addresses, and presents configuration space, BAR access, and interrupts to the guest.

The guest driver now programs queues and DMA addresses as if it controlled hardware, but L0 retains the translation and interrupt boundary. An unmapped DMA request should fault instead of reaching arbitrary host memory. That safety property does not repair a device that cannot reset, shares state with another function, or relies on host firmware behavior the guest cannot reproduce.

Teardown reverses ownership only after guest DMA stops. The VMM removes interrupt routes and mappings, closes device objects, performs a supported reset, and returns the function to a host driver if required. A failed reset can leave stale device state across tenants; do not assign the function again until the platform's recovery procedure establishes a clean boundary.

_The IOMMU limits DMA addresses; reset and shared-device state need separate checks._

```text
host driver -> isolate group -> VFIO/IOMMUFD ownership
  -> map guest pages as IOVAs -> expose BARs + interrupts -> guest driver
  -> stop DMA -> unmap -> reset -> optional host-driver rebind
```

### Treat an IOMMU fault as an isolation event

Record requester ID, I/O virtual address, access type, domain, guest, device driver, and preceding map changes. Repeated faults can indicate a guest-driver bug, stale DMA after teardown, or an incorrect mapping lifetime.

[Linux kernel: VFIO](https://docs.kernel.org/driver-api/vfio.html)

## GPU sharing names different hardware contracts

Whole-device passthrough assigns a physical function to one guest. Single Root I/O Virtualization (SR-IOV) lets a physical function expose virtual functions with hardware-defined resource and DMA separation. A mediated vGPU shares a physical device through a vendor and host-driver interface, while time slicing swaps contexts without creating hard memory partitions.

NVIDIA Multi-Instance GPU (MIG) partitions supported GPUs into instances with defined compute and memory resources. It is not another name for time slicing, and it does not remove topology, driver, scheduler, or workload-fit concerns. Migration and reset support vary across devices and modes.

## A shorter device path can still cross the wrong socket

Passthrough removes a software device model from much of the data path, but requests still involve guest queues, DMA translation, interrupts, pinned or mapped host pages, and physical fabric. If the PCIe root complex sits on NUMA node 1 while vCPU threads and guest memory sit on node 0, DMA completion and CPU access can cross the socket link. Place vCPUs, memory, and the device with topology in mind, then leave enough host capacity for emulator and interrupt work.

GPU tenancy adds scheduler and memory behavior specific to the selected mode. Time slicing can preserve functional sharing while producing queueing jitter; a partitioned mode can reserve defined resources yet still share power, PCIe, copy engines, or host software according to the device. Track per-tenant queue time, active compute, memory use, copy throughput, throttling reasons, correctable errors, and reset events. Vendor counters need the exact driver and firmware version beside them.

_Replace BDF and QEMU_PID with inspected resources. A numa_node value of -1 means the kernel has no specific node for that device._

```shell
lspci -nnk -s BDF
cat /sys/bus/pci/devices/0000:BDF/numa_node
readlink /sys/bus/pci/devices/0000:BDF/iommu_group
lscpu -e=CPU,NODE,SOCKET,CORE
numastat -p QEMU_PID
```

### Name the partition profile

MIG support and profiles depend on the GPU generation, firmware, driver, and current configuration. Record the physical GPU identity, GPU instance profile, compute instance profile, and placement before comparing isolation or throughput.

[NVIDIA: MIG user guide](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/introduction.html)

## Nested virtualization adds an L1 hypervisor

The physical host hypervisor is L0. Its guest, L1, runs a hypervisor that presents virtual hardware to an L2 guest. Hardware and KVM cooperate to virtualize the privileged state L1 expects, including nested page translation and selected intercept controls.

Upstream x86 KVM has enabled its `nested` module parameter by default since Linux 4.20, but distributions and cloud platforms can override it or hide the required VMX/SVM features from L1. Treat the effective module parameter and L1 CPU model as evidence; the upstream default is not a promise from a VM provider.

Performance depends on VM-exit behavior, page-table pressure, interrupt and I/O paths, overcommit, and which nested features the CPU and kernel expose. Compatibility, live migration, observability, and the enlarged security boundary often matter more than a single throughput percentage.

_L0 owns the hardware even when L1 believes it controls virtualization._

```text
L0: physical host + KVM
  L1: guest OS running its own hypervisor
    L2: nested guest workload
```

## Verify acceleration at both levels before measuring overhead

L0 must enable nested virtualization in its KVM module and expose the required virtualization CPU features to L1. Distribution policy can override kernel defaults, while a migratable named CPU model may hide features that host passthrough would expose. Inside L1, confirm that /dev/kvm exists and that the L2 VMM selected KVM rather than software translation. QEMU running inside a VM does not by itself prove nested KVM.

Collect the L0 and L1 kernel, KVM module parameters, CPU models, QEMU or libvirt versions, full machine arguments, and dmesg before the test. Then run the same benchmark directly in L1 and again in L2, separating guest work, nested exits, second-stage translation misses, interrupt delivery, host scheduling, and I/O. A percentage without those layers cannot transfer to another CPU or machine type.

Migration rules vary by architecture, vendor path, kernel, QEMU release, CPU model, and whether L1 has running L2 guests. Current upstream x86 guidance supports migrating an Intel L1 with live L2 guests from Linux 5.3 and QEMU 4.2 onward. It warns that an AMD L1 must not be migrated or saved after it has started an L2 until that L2 shuts down; a migrated instance in that state is no longer considered stable or secure. Migrating the L2 itself is a separate operation and is expected to work. Platform support can be narrower, so test the exact source and destination pair, including rollback after a rejected migration.

_Run the first checks in L0 and the device plus VMM checks in L1. Read the effective VMM accelerator configuration instead of trusting a process name._

```shell
cat /sys/module/kvm_intel/parameters/nested 2>/dev/null
cat /sys/module/kvm_amd/parameters/nested 2>/dev/null
lscpu | grep -E 'Virtualization|Hypervisor'
test -r /dev/kvm && echo KVM-device-visible
ps -ef | grep '[q]emu'
```

### Keep all three levels in the incident record

A nested fault report needs L0, L1, and L2 identities plus both VMM command lines. CPU flags seen in L1 can differ from physical capability, and an L2 symptom can originate in either hypervisor or either host scheduler.

[Linux kernel: running nested guests with KVM](https://docs.kernel.org/virt/kvm/x86/running-nested-guests.html)

## Summary

Direct device assignment shortens the software path only after the host establishes DMA isolation, ownership, interrupt routing, and reset behavior. Nested virtualization similarly adds hardware help without removing the L0, L1, and L2 boundaries that must be configured and observed.

- An IOMMU domain maps device-visible addresses only to approved host pages. Inspect the whole IOMMU group, ACS topology, reset support, and current driver ownership before assignment.
- A PCIe function exposes control regions and queues to a driver. DMA moves data between the device and memory; interrupts report progress. Device assignment must preserve those operations while restricting reachable memory.
- Assignment changes the function from host driver → VFIO or IOMMUFD domain → guest driver. Teardown must stop DMA, remove mappings and interrupts, reset the device, then rebind if needed.
- Treat IOMMU faults as isolation events and retain requester ID, address, access type, domain, guest, driver, and recent mapping changes.
- Whole-device passthrough, SR-IOV virtual functions, mediated vGPU, time slicing, and MIG make different claims about memory, compute, scheduling, reset, and migration.
- Place device, guest memory, vCPU threads, and host interrupt work with NUMA topology in mind. Passthrough can still cross the socket interconnect.
- L0 owns physical hardware, L1 runs a nested hypervisor, and L2 is its guest. CPU exposure, nested page translation, exits, interrupts, scheduling, and I/O can all affect the result.
- Before benchmarking, confirm nested KVM is enabled at L0, required CPU features reach L1, the KVM device exists in L1, and the L2 VMM selected KVM rather than software translation.

## References

- [Linux kernel: VFIO](https://docs.kernel.org/driver-api/vfio.html)
- [QEMU: VFIO with IOMMUFD](https://www.qemu.org/docs/master/devel/vfio-iommufd.html)
- [Linux kernel: PCI Express I/O virtualization](https://docs.kernel.org/PCI/pci-iov-howto.html)
- [NVIDIA: MIG user guide](https://docs.nvidia.com/datacenter/tesla/mig-user-guide/introduction.html)
- [Linux kernel: running nested guests with KVM](https://docs.kernel.org/virt/kvm/x86/running-nested-guests.html)

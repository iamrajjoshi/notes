---
title: Low-level infrastructure
description: Linux boundaries, scheduling, memory, I/O, networking, containers, debugging, virtual machines, and assigned devices.
slug: low-level-infrastructure
order: 2
duration: 22–23 hours
---

## Scope

What sits below an application process: the Linux kernel, CPU scheduling, memory, storage, networking, containers, debugging, and virtual machines. The sequence starts with ordinary process behavior, defines each hardware or kernel term when it first matters, then follows failures through the same layers.

## Reading path

1. [The kernel boundary](01-kernel-boundary.md) separates programs, processes, threads, system calls, descriptors, credentials, and kernel policy.
2. [CPU scheduling and locality](02-cpu-scheduling-and-locality.md) follows a runnable task onto a CPU and then to cache and NUMA-resident data. Its final concurrency sections are optional.
3. [Virtual memory](03-virtual-memory.md) explains the address translation and page-fault path previewed by LL2, then follows allocation, reclaim, and memory pressure.
4. [Linux storage and I/O](04-storage-and-io.md) follows bytes through filesystems, the page cache, block devices, durability barriers, and asynchronous I/O.
5. [Linux networking](05-linux-networking-and-ebpf.md) follows a socket through DNS, routing, TCP, namespaces, Netfilter, and optional eBPF hooks.
6. [Containers and cgroups](06-containers-and-cgroups.md) assembles the earlier process, filesystem, network, and resource controls into a container runtime path.
7. [Observing and debugging a Linux workload](07-observability-and-debugging.md) is the synthesis checkpoint for LL1–LL6. It turns process identity, clocks, counters, profiles, traces, pressure, and crash state into one diagnostic method.
8. [KVM, QEMU, and virtio](08-kvm-qemu-and-virtio.md) starts the advanced virtualization track by adding a guest kernel, second-stage memory translation, and virtual devices.
9. [MicroVMs and Kata](09-microvms-and-kata.md) compares smaller VMMs and follows Kata's container-to-guest path after the general VM model is established.
10. [Devices and nested virtualization](10-device-assignment-and-nested-virtualization.md) contains two independent capstones: direct device and GPU assignment, then an L1 hypervisor running an L2 guest. Either half can be read first after LL8.

Cloud notes can be read before this collection because they define their service-level contracts locally. Use this collection as the under-the-hood path: LL5 deepens cloud networking, LL4 deepens cloud storage, LL6 deepens Kubernetes resource enforcement, and LL7 deepens observability and incident diagnosis.

## Useful background

- Comfort reading short shell transcripts and configuration snippets
- Experience writing or debugging an ordinary application
- Basic command-line use; process, TCP/IP, container, and virtualization terms are introduced here
- No kernel development or assembly experience required

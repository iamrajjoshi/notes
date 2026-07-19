---
title: Virtual memory and page faults
shortTitle: Virtual memory
description: Trace an address through page tables and the page cache, then decide when huge pages or user-space fault handling solve a real problem.
collection: low-level-infrastructure
slug: virtual-memory
order: 3
number: LL3
duration: 140 min
difficulty: Core
tags:
  - memory
  - mmap
  - hugepages
  - userfaultfd
---

## Working model

A virtual address is a claim, not a resident byte. Page tables describe where that claim currently points; faults give the kernel, or an authorized user-space handler, a chance to supply or reject the page.

## Questions this note answers

- Trace a virtual address through a TLB lookup, page table, and page fault
- Separate reserved address space, mapped pages, resident frames, page cache, and swap
- Explain anonymous, file-backed, shared, private, and copy-on-write mappings
- Compare HugeTLB and transparent huge pages without assuming either is always faster
- Describe how userfaultfd moves selected page-fault handling into user space

## Translate one memory access before discussing pressure

Application instructions read and write numeric **virtual addresses**. Each process has its own virtual address space, so two processes can use the same number without referring to the same memory. The CPU's memory management unit (MMU) translates that virtual address to physical RAM according to page tables maintained by the kernel.

Memory is managed in fixed-size units. A virtual **page** is a range in an address space; a physical **page frame** is a range in RAM. A page-table entry can map the virtual page to a frame and record permissions such as readable, writable, or executable. A Translation Lookaside Buffer (TLB) caches recent translations so the CPU does not walk the page-table hierarchy for every load.

If no permitted translation exists, the CPU raises a page fault and enters the kernel. The fault can be normal: the kernel may allocate a zero-filled frame for the heap, bring file data into memory, or copy a shared frame before a write. An invalid access instead ends in an error such as SIGSEGV or SIGBUS.

The stack usually holds call frames and local state, while the heap serves dynamic allocation. Both are virtual ranges whose pages become resident as they are used. **Resident** means backed by physical RAM now. A large reserved range can have a small resident set, and resident file data may be reclaimable because the file still owns a copy.

```text
instruction uses virtual address
  -> TLB hit: cached translation
  -> TLB miss: page-table walk
      -> permitted mapping: physical frame
      -> absent or disallowed mapping: page fault into kernel
```

## Allocation can precede physical memory

A process issues virtual addresses. The CPU checks its TLB for a cached translation and otherwise walks page tables that the kernel prepared. A missing or disallowed translation raises a page fault; the kernel may map a zero-filled page, load file data, copy a shared page, or deliver a signal.

A minor fault needs no storage read, while a major fault waits for backing storage. Both can be expensive at scale because they interrupt normal execution and may take memory-management locks.

## mmap connects address ranges to backing objects

Anonymous mappings back heaps and large runtime allocations. File mappings let loads and stores reach pages associated with a file, but mmap does not promise that data stays resident or that every path avoids copying.

MAP_SHARED writes can become visible through the shared mapping and eventually reach the file, but visibility does not establish crash durability; use the file and filesystem synchronization contract for that. MAP_PRIVATE starts from the file but uses copy-on-write for modified pages. Reclaim may discard clean file-backed pages or swap eligible anonymous pages; an out-of-memory (OOM) path appears when reclaim cannot satisfy demand under policy and limits.

A mapping also inherits the file's lifetime hazards. Access beyond the current end of the mapped object can raise SIGBUS, and another process can truncate the file while pointers into the old range still exist. Code that treats `mmap` as a forever-valid byte array needs an ownership rule for resize and replacement.

_One mapping can move through several states over its lifetime._

```text
virtual range -> page-table entry -> physical frame
              \-> absent: fault -> zero page, file page, COW copy, or signal
```

## fork turns one anonymous page into two possible histories

A parent writes an anonymous heap page, then calls fork. Parent and child initially map the same physical frame, while their page-table entries prevent ordinary writes. The kernel also tracks the frame as shared. A read by either process can continue through that mapping without copying the page.

When the child writes, the write-protection fault reaches the copy-on-write path. The kernel allocates a frame allowed by the child's memory and NUMA policy, copies the old contents, maps the new frame writable in the child, and leaves the parent's mapping on the original frame. If allocation or a cgroup charge fails, the write need not complete merely because fork succeeded. Later writes can skip another copy once a process owns an exclusive writable page.

_The virtual addresses may match across processes, but each address space owns its page-table entry._

```text
before fork: parent VA -> frame X
after fork:  parent VA -read-only-> frame X <-read-only- child VA
child write: child VA -> new frame Y; parent VA -> frame X
```

## Bigger pages trade translation work for coarser allocation

Huge pages cover more memory with each TLB entry and reduce page-table size. HugeTLB uses a reserved pool with explicit semantics; those pages cannot swap. Transparent huge pages let the kernel form larger mappings automatically. Modern kernels can expose multi-size THP for supported anonymous-memory sizes between the base page and the traditional PMD-sized page; available sizes, defaults, and shmem support depend on the architecture and kernel.

The trade is real. Larger pages can waste memory, lengthen allocation or compaction work, and create latency spikes.

## Reclaim chooses pages; policy decides where failure lands

Under pressure, the kernel can drop clean file-backed pages and read them again later. Dirty file pages need writeback before reuse. Anonymous pages need swap space or another reclaim mechanism if their contents must survive, so a swapless host can reach an allocation failure while much of its memory belongs to active anonymous mappings.

A control group (cgroup) places a set of processes inside a kernel-managed resource-accounting boundary; [LL6](06-containers-and-cgroups.md) explains how the hierarchy is created and populated. Inside that boundary, `memory.high` asks allocating tasks to help reclaim and can produce long stalls without killing them. `memory.max` sets a hard boundary; if reclaim cannot bring usage below it, the cgroup out-of-memory (OOM) path can kill a task according to current policy. Host-wide OOM is a different scope. Read `memory.events`, pressure stall data, swap activity, and the kernel log together before blaming a process with the largest resident set.

### A free-memory snapshot cannot explain a stall

Page cache, reclaimable slab, dirty limits, cgroup protection, swap state, and allocation order all affect whether the next request can proceed. Capture the allocation scope and pressure timeline rather than treating MemFree as available capacity.

[Linux kernel: memory management concepts](https://docs.kernel.org/admin-guide/mm/concepts.html)

## userfaultfd turns selected faults into a negotiated protocol

A monitor opens userfaultfd, negotiates UFFDIO_API features, and registers an address range in modes the running kernel and mapping type support. MISSING reports access to absent pages, MINOR reports a supported page that exists in backing storage or cache but lacks this process's page-table entry, and WP reports writes to pages protected through userfaultfd.

The monitor polls the descriptor for UFFD_EVENT_PAGEFAULT, reads the fault address and flags, then resolves that event with an operation that matches its mode. UFFDIO_COPY or UFFDIO_ZEROPAGE supplies a missing page, UFFDIO_CONTINUE completes a minor fault, and UFFDIO_WRITEPROTECT changes write protection. The faulting thread stays blocked until the monitor resolves or wakes it.

> **Security boundary.** With the `userfaultfd` syscall, an unprivileged caller can request user-mode faults by passing UFFD_USER_MODE_ONLY. Handling faults triggered from kernel mode requires CAP_SYS_PTRACE or `vm.unprivileged_userfaultfd=1`, whose upstream default is 0. Opening `/dev/userfaultfd` follows that device's filesystem permissions and is not governed by the sysctl. Negotiate features as well as permissions because registration modes still depend on the mapping type and running kernel.

### Resolution can race with the mapping

Another thread can populate, unmap, remove, or remap the range while the monitor fetches data. Request the relevant UFFD feature events, attach a generation to the registered range, revalidate the address before copying, and handle an already-populated result without overwriting newer state.

[Linux kernel: userfaultfd API and events](https://docs.kernel.org/admin-guide/mm/userfaultfd.html)

### Post-copy moves failure into the page server

Post-copy resumes execution before all memory arrives, so a missing page can block on the source, transport, decompressor, and handler. Keep the source or a recoverable checkpoint until transfer finishes, bound handler queues, and define what happens when the source disappears mid-restore.

## Read mappings, faults, and pressure as one timeline

`/proc/<pid>/maps` shows ranges and permissions, while `smaps` or `smaps_rollup` adds resident, proportional, anonymous, file, swap, and huge-page accounting supported by the running kernel. Those files are observations, not an allocation ledger: a reserved virtual range can have little resident memory, and shared pages can appear in several processes.

Minor and major fault counters accumulate over a task's life. Measure their change during a bounded workload, record whether file data was already cached, and pair the result with latency. System-wide `/proc/vmstat` and PSI show reclaim, compaction, swap, and time stalled under pressure; a container also needs its cgroup's memory.current, memory.events, and pressure file. One counter rising near the incident does not prove causation, so align samples on a monotonic clock and retain the workload phase.

_Field availability and performance-counter names vary. Record the kernel and tool versions with the sample._

```shell
cat /proc/PID/maps
cat /proc/PID/smaps_rollup
awk '{print $10, $12}' /proc/PID/stat
cat /proc/vmstat
cat /proc/pressure/memory
perf stat -e page-faults,minor-faults,major-faults -- ./workload
```

## Summary

Virtual memory separates an address-space promise from physical residency. A page fault may allocate, load, copy, wait, or reject, so a large mapping, high resident set, and memory-pressure stall describe different states rather than one measure of “memory use.”

- The CPU checks the TLB, then page tables. A missing or disallowed translation faults into a path that can supply a zero page, file page, copy-on-write page, or signal.
- Virtual address space, mappings, and resident RAM are different quantities. A page is a virtual-memory unit; a frame is its possible backing in physical memory.
- Anonymous and file-backed mappings have different reclaim paths. Private file mappings copy modified pages; shared mappings can expose changes through the shared backing.
- After fork, parent and child may read one physical frame. The first write can allocate and map a private copy, and that allocation can still fail under NUMA or cgroup policy.
- Huge pages reduce TLB and page-table work but coarsen allocation, increase waste, and can add compaction latency. HugeTLB reserves explicit non-swappable pages; transparent huge pages are formed by the kernel, with multi-size anonymous THP available only where the running kernel and architecture expose it.
- Clean file pages can be dropped; dirty pages need writeback; anonymous pages need swap or another recovery path. Memory high can stall tasks in reclaim, while memory max can lead to cgroup OOM.
- Userfaultfd requires negotiated features and mode-specific resolution. The faulting thread remains blocked until the monitor resolves or wakes it, and mapping changes can race with that resolution.
- Read maps, resident accounting, fault deltas, reclaim, swap, pressure stalls, cgroup events, and kernel logs on one timeline. Free-memory snapshots alone do not identify the blocked allocation.

## References

- [Linux kernel: memory management concepts](https://docs.kernel.org/admin-guide/mm/concepts.html)
- [Linux kernel: page tables](https://docs.kernel.org/mm/page_tables.html)
- [Linux man-pages: mmap(2)](https://man7.org/linux/man-pages/man2/mmap.2.html)
- [Linux man-pages: msync(2)](https://man7.org/linux/man-pages/man2/msync.2.html)
- [Linux kernel: HugeTLB pages](https://docs.kernel.org/admin-guide/mm/hugetlbpage.html)
- [Linux kernel: transparent huge pages](https://docs.kernel.org/admin-guide/mm/transhuge.html)
- [Linux kernel: userfaultfd](https://docs.kernel.org/admin-guide/mm/userfaultfd.html): Covers API negotiation, registration modes, events, resolution ioctls, and security controls.

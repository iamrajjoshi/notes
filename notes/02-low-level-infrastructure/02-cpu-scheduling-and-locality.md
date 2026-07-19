---
title: CPU scheduling, caches, and lock-free code
shortTitle: CPU and locality
description: Connect CPU topology, run queues, power states, caches, NUMA, and memory ordering to the progress of runnable code.
collection: low-level-infrastructure
slug: cpu-scheduling-and-locality
order: 2
number: LL2
duration: 150 min
difficulty: Core
tags:
  - scheduler
  - CPU cache
  - NUMA
  - lock-free
---

## Working model

A runnable thread competes twice: first for CPU time, then for nearby data. Scheduling decides when and where it runs; cache coherence and NUMA placement decide how expensive its memory accesses become.

## Questions this note answers

- Explain the job of Linux's fair scheduler without treating CFS documentation as the complete current implementation
- Trace a load through address translation, the cache hierarchy, and local or remote memory; recognize false sharing
- Explain why utilization, frequency, power, energy, and completed work are different measurements
- Distinguish lock-free, wait-free, and obstruction-free progress claims
- Identify why atomics still need memory ordering and safe reclamation

## Begin with CPU topology and task states

A physical machine can contain one or more central processing unit (CPU) **sockets**. Each socket contains cores, and a core may expose more than one hardware thread as separate **logical CPUs**. Linux numbers those logical CPUs and can run one task on each at a time. A network socket is unrelated; the word is overloaded.

A task that currently owns a logical CPU is **running**. A **runnable** task could execute but is waiting for an eligible CPU. A sleeping task waits for an event such as a timer, socket, futex, page, or device completion and does not compete on a run queue until it wakes. The scheduler chooses among runnable tasks and can preempt one so another runs.

A context switch saves one task's register state and restores another's. It costs kernel work and can disturb caches, but the larger cost may come from waiting in the run queue or returning to data that is no longer near the chosen core. Count and time those effects instead of declaring every context switch a problem.

```text
sleeping --event--> runnable --scheduler chooses it--> running
running --preemption--> runnable
running --wait or exit--> sleeping or finished
```

## The scheduler allocates a contended processor

Linux tracks runnable tasks on CPU run queues and chooses when each may execute. Affinity, CPU sets, priority policy, wakeups, and load balancing shape that choice; a runnable task can still wait behind other eligible work.

The older Completely Fair Scheduler (CFS) explanation remains useful because virtual runtime describes proportional fairness well. Linux began moving the fair scheduling class to Earliest Eligible Virtual Deadline First (EEVDF) in 6.6: a task with nonnegative lag is eligible, and the scheduler selects the eligible task with the earliest virtual deadline. Check the deployed kernel and vendor patches instead of projecting the newest upstream description onto an older host.

EEVDF applies to fair-class tasks. SCHED_FIFO and SCHED_RR use real-time rules, while SCHED_DEADLINE uses runtime, deadline, and period reservations. Those classes can delay ordinary fair work. A **control group (cgroup)** is a kernel hierarchy that groups processes for resource accounting and control; a cgroup CPU quota can throttle a task even when an allowed CPU looks idle. [Containers and cgroups](06-containers-and-cgroups.md) builds that mechanism in full. Record the scheduling policy, nice value, affinity, cgroup, and quota before explaining a delay with one run-queue diagram.

### Measure before pinning

CPU affinity can preserve warm caches, but a bad pin can strand idle capacity or force remote NUMA access. Inspect the workload and topology first.

## Read the cache hierarchy before tuning it

Cache organization varies by processor, but a common hierarchy has a split level-one instruction cache (L1I) and data cache (L1D), a larger level-two cache (L2), and a still larger last-level cache (LLC). L1 and often L2 belong to one physical core; logical CPUs created by simultaneous multithreading share those core resources. The LLC commonly serves several cores, sometimes an entire socket. A shared cache gives those cores a common pool of capacity and bandwidth, so one core's workload can evict another's data.

Caches hold copies of memory in fixed-size **cache lines**. Current x86 processors commonly use 64-byte lines, but software should query or measure the target rather than assume that size for every architecture. An 8-byte load can therefore fetch the surrounding line. A miss causes a **line fill** from a lower cache, another core, or memory. When the destination cache needs space, it **evicts** a victim line; a clean line can be discarded, while a modified line in a write-back cache must eventually be written to the next level.

### Locality and the working set

**Temporal locality** means reusing the same address soon enough that its line remains cached. **Spatial locality** means using nearby addresses so the rest of a fetched line does useful work. For a C array `double a[R][C]` on a machine with 64-byte lines, a row-major loop that advances the column index in its inner loop can consume eight adjacent doubles from one fill. A linked-list walk such as `p = p->next` may touch one useful field in each scattered line, and the processor cannot issue the next dependent node load until it learns the pointer from the current one.

A **working set** is the code and data actively used during an interval, not the process's total allocation. Reuse tends to hit when that set fits in the available cache. If it exceeds the cache, or other cores compete for a shared LLC, useful lines may be evicted before reuse.

### Trace one load from a virtual address to memory

Suppose a thread loads `x` through a virtual address and the corresponding data is not already cached. A useful conceptual path is:

```text
virtual address
  -> data TLB (page-table walk on a miss)
  -> L1D -> L2 -> LLC
  -> local DRAM
     or socket interconnect -> remote DRAM
```

The data Translation Lookaside Buffer (TLB) caches virtual-page-to-physical-frame translations, not application bytes. A TLB hit supplies the translation; a miss requires an architecture-specific page-table walk, and an absent mapping can cause a page fault. The translated load checks L1D, then progressively larger caches. If the LLC also misses, the memory controller fetches the line from local Dynamic Random-Access Memory (DRAM) or, on a Non-Uniform Memory Access (NUMA) machine, across the socket interconnect from remote DRAM. The returning line fills one or more caches, and the requested bytes satisfy the load.

Real processors can overlap translation with an L1 lookup, fetch a modified line from another core, or use a hierarchy that does not fill every level. The diagram is a dependency model, not a required bus route. Huge pages let each TLB entry cover more memory, while Linux memory policy and first touch influence which NUMA node owns the physical pages. CPU affinity alone does not move existing pages.

### False sharing is contention over a line

Assume a 64-byte-aligned line contains `requests` at byte offset 0 and `errors` at offset 8. Thread A increments `requests`; thread B increments `errors`. The fields are distinct objects, but each writer must obtain the line in a writable coherence state, invalidating the other core's copy. If updates alternate between cores, the line can move on every handoff. Separating the counters onto different lines can remove that traffic, at the cost of padding and only after confirming the platform's line size and the compiled layout.

> **Common bad fix.** Pinning every worker does not guarantee locality. Its memory may still live on another NUMA node, and the pinned set may be oversubscribed.

## Power and energy depend on work, time, and machine state

Power is the rate of energy use; energy accumulates over time. A device drawing 100 watts for 10 seconds uses 1,000 joules. Finishing sooner can use less total energy even at higher instantaneous power, while slowing a task can save power but keep the machine active longer.

Modern CPUs change performance states rather than run every core at one fixed frequency. Linux CPUFreq policy or hardware-controlled performance states influence frequency and voltage within platform limits. Idle CPUs can enter sleep states; deeper idle states generally save more power but take longer to leave. Thermal and package-power limits can reduce frequency even when software requests more performance.

Utilization says how much measured time a CPU stayed busy. It does not say how many instructions completed, how much time those instructions waited on memory, or how much power the whole server drew. Likewise, a reported frequency is not a throughput number. Compare completed workload units, latency, CPU time, wall time, and energy from a documented counter or external meter. Processor package counters omit some combination of memory, storage, networking, power conversion, and cooling, depending on the platform.

For a server experiment, report useful work per joule beside latency and error rate. Batching, vectorization, locality, and fewer wasted retries can improve both performance and energy efficiency. Driving a shared host to saturation can instead increase queueing and failed work.

## A wakeup can trade queueing delay for colder data

A worker sleeps in a futex wait after finding its queue empty. A futex, short for fast user-space locking, lets uncontended synchronization stay in user space and gives the kernel a wait-and-wake path when threads contend. A producer on CPU 3 appends work, publishes the queue state, and wakes the worker. The scheduler marks the worker runnable and selects an allowed run queue; if CPU 3 is busy, another eligible CPU may run it sooner. That choice removes run-queue wait but can discard the worker's useful cache state.

The worker then reads a buffer first faulted by a thread on NUMA node 0. Running on a CPU from node 1 can turn each cache miss into a remote access. Pinning the worker to node 0 might restore locality, yet it can also lengthen scheduler delay when those CPUs are full. Measure both intervals: wakeup-to-run time and run-to-completion time. A lower value for one can accompany a higher value for the other.

_Scheduler delay and memory-access delay belong to different parts of the trace._

```text
producer publishes work -> futex wake -> task becomes runnable
  -> chosen CPU run queue -> task starts -> cache/TLB refill
  -> local or remote NUMA access -> work completes
```

## Atomic access still needs an ordering contract

Shared mutable data needs a synchronization rule. A **critical section** is code that must not overlap unsafely with another thread. A mutex allows one owner at a time and can put waiters to sleep. An atomic operation updates or reads one supported value without another thread observing a torn intermediate operation. A data race occurs when threads access the same location concurrently, at least one access writes, and the language supplies no required synchronization.

Removing a mutex does not remove coordination. Lock-free code moves coordination into atomic operations, retry loops, memory-order rules, and object-lifetime management; use it only after a measured contention problem and a review against the language memory model.

An atomic operation prevents a torn update, but it does not automatically publish surrounding data in the intended order. Acquire and release edges tell the compiler and CPU which earlier writes a reader must observe.

_The release/acquire pair publishes payload when the reader observes ready._

```c
// Writer
payload = 42;
atomic_store_explicit(&ready, true, memory_order_release);

// Reader
if (atomic_load_explicit(&ready, memory_order_acquire)) {
  consume(payload);
}
```

## Lock-free is a progress claim, not a memory manager

Obstruction-free means an operation finishes if it eventually runs without interference, so contending threads can still livelock. Lock-free means the system as a whole keeps making progress, though an unlucky thread may starve. Wait-free gives every operation a bounded-progress guarantee. The implication runs from wait-free to lock-free to obstruction-free, not the other way around.

The source type alone does not prove that an atomic operation uses lock-free machine instructions on every target. C and C++ expose implementation checks for that question, and a library may use an internal lock for an atomic width the processor cannot handle directly.

Real structures also need to handle ABA and prevent readers from following reclaimed nodes. Epochs, hazard pointers, and reference counting solve different versions of that lifetime problem, and each adds its own stalls or metadata.

## A successful compare-and-swap can still accept stale history

Thread A reads stack head A and next pointer B, then pauses. Thread B removes A, removes B, and later allocates a new node at A's old address before publishing that address as the head. A plain pointer comparison now tells thread A that the head still equals A, so its compare-and-swap can install the stale B pointer even though the stack changed twice. This is the ABA problem.

A generation tag can distinguish reuse until its counter wraps, but it does not keep the old node readable. Hazard pointers publish which nodes readers may dereference; epoch schemes delay reclamation until old readers pass a quiescent point. A stalled reader can delay either scheme in a different way. The algorithm needs separate arguments for linearization, progress, memory order, and reclamation before a stress test means much.

### Stress creates evidence, not a proof

Vary thread count, CPU placement, allocator reuse, pauses, and memory pressure, then run race detectors supported by the language. A clean run can expose no counterexample; it cannot establish a lock-free algorithm's correctness on every allowed execution.

## Separate waiting for a CPU from wasting cycles on one

Start with wall time and per-thread CPU time. If wall time rises while CPU time stays flat, inspect runnable delay, blocking, and throttling before collecting cache counters. `perf sched` can record scheduling events for a controlled run; `/proc/<pid>/sched` and scheduler tracepoints expose task-level evidence, subject to kernel configuration and access policy.

When the thread gets CPU time but retires less work, compare cycles, instructions, cache misses, and context switches under the same input. Then record CPU affinity, the machine topology, `/proc/<pid>/numa_maps`, and per-node allocation with `numastat -p`. Change one placement variable at a time. Counter names, precision, and availability depend on the processor, so retain `perf list`, kernel version, and the exact command with the result.

_Use a repeatable workload and compare distributions, not one fast run._

```shell
lscpu -e=CPU,NODE,SOCKET,CORE
taskset -cp PID
numastat -p PID
perf sched record -- ./workload
perf sched timehist
perf stat -e cycles,instructions,context-switches,cache-misses -- ./workload
```

### First touch can outlive the thread that caused it

NUMA policy usually affects later allocations, while pages already faulted can remain on their original nodes. Record who first touched the buffer before concluding that current CPU affinity controls its placement.

[Linux kernel: NUMA memory policy](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html)

## Summary

CPU performance has two separate delays: waiting to run and waiting on data after the thread runs. Affinity or pinning can improve one while hurting the other, so scheduling delay, cache behavior, and NUMA placement need measurements from the same workload interval.

- Linux keeps runnable tasks on CPU run queues; affinity, CPU sets, priority, wakeups, and balancing constrain where and when each task runs.
- A socket contains cores, and cores expose logical CPUs. Running, runnable, and sleeping are different task states; a context switch can add direct kernel cost and indirect cache cost.
- L1D, L2, and LLC retain recently used cache lines. A miss fills a line from farther away, and an eviction removes a line to make room; exact sizes and sharing boundaries depend on the processor.
- Temporal locality reuses a line before eviction, spatial locality uses neighboring bytes from the same fill, and a working set that exceeds available cache capacity causes more misses.
- False sharing occurs when independent writes share a cache line and force ownership traffic between cores; distinct source-level fields do not prevent it.
- CPU utilization, frequency, power, energy, and completed work are different measurements. Compare useful work per joule only with a named energy source and the same latency and correctness contract.
- A faster wakeup on another CPU can reduce run-queue delay while losing warm cache state or accessing memory on a remote NUMA node.
- Atomics prevent torn operations but do not publish surrounding data without a memory-order contract. A release store paired with an observing acquire load can publish earlier writes.
- Obstruction-free guarantees progress in isolation, lock-free guarantees system-wide progress, and wait-free guarantees bounded progress per operation. None solves memory reclamation, and only wait-free rules out starvation for an operation covered by the proof.
- ABA protection and object lifetime are separate. Generation tags distinguish some reuse; hazard pointers, epochs, or reference counts keep readers from dereferencing reclaimed nodes.
- If wall time rises while thread CPU time stays flat, inspect runnable delay, blocking, and throttling first. If CPU time rises without useful work, compare instructions, cycles, cache misses, affinity, topology, and NUMA placement.

## References

- [Linux kernel: scheduler documentation](https://www.kernel.org/doc/html/latest/scheduler/)
- [Linux kernel: EEVDF scheduler](https://www.kernel.org/doc/html/latest/scheduler/sched-eevdf.html)
- [Linux kernel: deadline scheduler](https://docs.kernel.org/scheduler/sched-deadline.html)
- [Linux kernel: NUMA memory policy](https://docs.kernel.org/admin-guide/mm/numa_memory_policy.html)
- [Linux kernel: CPU frequency and voltage scaling](https://docs.kernel.org/admin-guide/pm/cpufreq.html)
- [Linux kernel: CPU idle time management](https://docs.kernel.org/admin-guide/pm/cpuidle.html)
- [Linux kernel: power capping framework](https://docs.kernel.org/power/powercap/powercap.html)
- [Linux kernel: memory barriers](https://docs.kernel.org/core-api/wrappers/memory-barriers.html)
- [Linux kernel: lockless ring buffer](https://docs.kernel.org/trace/ring-buffer-design.html)
- [Intel 64 and IA-32 Architectures Optimization Reference Manual, Volume 1](https://www.intel.com/content/www/us/en/content-details/821612/intel-64-and-ia-32-architectures-optimization-reference-manual-volume-1.html)
- [WG14 C11 draft: atomics and memory order](https://www.open-std.org/jtc1/sc22/wg14/www/docs/n1570.pdf)

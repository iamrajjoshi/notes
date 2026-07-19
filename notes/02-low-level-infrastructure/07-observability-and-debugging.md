---
title: Observing and debugging a Linux workload
shortTitle: Linux debugging
description: Turn a service symptom into a bounded Linux experiment using stable identity, counters, profiles, traces, pressure data, and crash evidence.
collection: low-level-infrastructure
slug: observability-and-debugging
order: 7
number: LL7
duration: 100 min
difficulty: Core
tags:
  - observability
  - procfs
  - perf
  - tracing
  - PSI
---

## Working model

An observation is a measurement made through one interface during one interval. It becomes evidence only after you can name the process instance, clock, scope, unit, and failure theory it tests.

## Questions this note answers

- Preserve process, boot, namespace, cgroup, executable, and time identity during an incident
- Distinguish snapshots, counter deltas, sampled profiles, and event traces
- Split on-CPU execution from runnable delay, blocking, cgroup throttling, and resource pressure
- Choose among procfs, `strace`, `perf`, ftrace, and eBPF for a stated question
- Collect a useful core dump without losing symbols or leaking its contents

## Freeze identity before the subject changes

A numeric PID can be reused after exit, and the same container process can have different PIDs in nested PID namespaces. Record the host PID, `/proc/<pid>/stat` start time, boot ID, namespace links, cgroup path, executable, and build identifier before restarting anything. A pidfd retained by a supervisor is a stable process reference; a PID copied from an old log is not.

Time needs the same care. Wall-clock timestamps connect service logs to people and external systems, but Network Time Protocol (NTP) adjustments can move that clock. Monotonic time is the right basis for durations and ordering events on one host. Keep both when evidence crosses machines.

_These reads describe one process instance. Repeat them if the process can exec or move cgroups during capture._

```shell
cat /proc/sys/kernel/random/boot_id
cat /proc/PID/stat
cat /proc/PID/cgroup
readlink /proc/PID/exe
readlink /proc/PID/ns/{pid,mnt,net,user}
ps -L -p PID -o pid,tid,psr,stat,time,comm
```

Do not parse `/proc/<pid>/stat` with a naive whitespace split: the parenthesized command field can contain spaces. Use a parser that understands its format when extracting field 22, the start time in clock ticks since boot.

[Linux man-pages: proc_pid_stat(5)](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)

## Different questions need different evidence shapes

A snapshot shows state at one instant, such as a thread state or open descriptor. A counter accumulates events or time, so its delta over a named interval matters more than its raw value. A sampled profile estimates where execution spent time. An event trace records selected transitions and their ordering, subject to buffer loss and clock choice.

Each can mislead on its own. A task seen in state D waited in an uninterruptible sleep at that instant, but the state does not name a disk or prove that the task spent most of the incident there. A large lifetime context-switch counter may have grown months earlier. A profile can miss a rare stall, while a full trace can perturb the workload or overflow its buffer.

Write the expected observation before collecting it. “If CPU quota causes the tail, `cpu.stat` throttling and runnable delay will rise during the same requests” can fail a test. “The host is slow” cannot.

## First split elapsed time from CPU time

For one request or workload phase, compare elapsed time with user and system CPU time. If CPU time grows with elapsed time, profile on-CPU execution and count instructions, cycles, cache behavior, and faults. If elapsed time grows while CPU time stays nearly flat, inspect four off-CPU branches: runnable but not scheduled, sleeping on a kernel or user-space wait, cgroup throttling, and resource pressure.

Thread state is only the start. A runnable thread can wait behind other tasks, affinity constraints, a higher scheduling class, or a quota. A sleeping thread can wait on a futex, socket, pipe, timer, page fault, or device. Read per-thread state under `/proc/<pid>/task/<tid>`, then use scheduler or syscall events to observe the transition rather than assigning a cause from `STAT` or `wchan` alone.

Cgroup v2 adds scoped evidence. `cpu.stat` reports usage and throttling fields supported by the kernel; `memory.events` reports events such as high-boundary pressure and OOM activity. CPU, memory, and I/O pressure files report stall time for tasks in that cgroup.

```shell
cat /sys/fs/cgroup/PATH/cpu.stat
cat /sys/fs/cgroup/PATH/cpu.pressure
cat /sys/fs/cgroup/PATH/memory.events
cat /sys/fs/cgroup/PATH/memory.pressure
cat /sys/fs/cgroup/PATH/io.pressure
```

## A syscall trace shows the interface, not the whole cause

`strace` can show arguments, return values, signals, and time spent between syscall entry and return. With `-f` it follows created processes; timestamp and duration options help align the trace with application events. This makes it useful for a failing `openat`, a blocking `futex`, repeated connection attempts, or a shutdown signal that never reaches an eligible thread.

It cannot see application queueing before the syscall, and one slow syscall does not identify the internal kernel wait. A long `read` might wait for a socket, pipe, terminal, device, or file data. Asynchronous APIs also separate submission from completion. Trace only the syscall families needed for the hypothesis because argument capture, stack collection, and high event rates add cost and can expose secrets.

_Attach only to a process you own, write output to protected storage, and rehearse the filter away from production._

```shell
strace -ff -ttt -T -e trace=%file,%network -p PID -o /protected/path/trace
```

## Use profiles for distribution and traces for sequence

`perf stat` counts selected software or hardware events during an interval. `perf record` samples execution and can build an on-CPU profile. Hardware events vary by processor, can be multiplexed when too many are requested, and may require privilege. Keep `perf list`, processor identity, kernel, event list, duration, and workload input beside the result.

Call graphs also need unwind information and matching symbols. Frame pointers, DWARF data, JIT symbol maps, stripped binaries, and container mount views affect what the profile can name. An unresolved stack is a symbolization problem before it is an application conclusion.

Ftrace exposes static kernel events through tracefs. Tracepoint events are better version boundaries than attaching to an arbitrary internal function, though event names and fields can still change. Kprobes and many BPF tracing programs can attach to internal functions; those attachments need a kernel-specific compatibility check.

eBPF can filter and aggregate close to the event source, but it does not make measurement free. Verifier limits, permissions, map contention, ring-buffer loss, stack-capture cost, and program runtime all affect the observation. Count dropped events, narrow the PID/cgroup and time window, and remove the attachment when the experiment ends.

[Linux kernel: ftrace](https://docs.kernel.org/trace/ftrace.html)

## PSI measures stalled work, not utilization

Pressure Stall Information reports time tasks could not make progress because CPU, memory, or I/O was contended. `some` means at least one task was stalled; `full` means every non-idle task in the measured scope was stalled at once. The totals support interval deltas, and the averages describe recent windows.

CPU `full` has no useful system-wide meaning and is reported as zero there for compatibility; read it at cgroup scope. Memory and I/O `full` remain meaningful at both supported scopes.

High CPU utilization with low CPU pressure can mean the machine stayed busy without much runnable delay. Low utilization can coexist with memory or I/O pressure when tasks sleep waiting for reclaim or completion. PSI says that work stalled in a resource category; it does not name the code, device, page, or tenant responsible. Join it with cgroup counters and a narrower event trace.

[Linux kernel: Pressure Stall Information](https://docs.kernel.org/accounting/psi.html)

## A crash needs the matching program, not only a stack screenshot

A core dump captures selected memory and register state at failure. Whether one exists depends on `RLIMIT_CORE`, dumpability, `/proc/sys/kernel/core_pattern`, storage policy, and the process's filesystem and namespace context. On a systemd host, `systemd-coredump` may retain the core and metadata for `coredumpctl` instead of leaving a `core` file in the working directory.

Preserve the exact executable, build ID, shared libraries, debug information, command line, environment policy, kernel, container image, and signal metadata. A core can contain credentials, customer data, encryption material, and request bodies, so restrict access and deletion just as you would for a production data export.

Do not run the crashed process's signal handler as proof of memory safety. Heap or stack corruption may already have broken the handler's assumptions. Keep crash-path code small and rely on an external collector where possible.

[Linux man-pages: core(5)](https://man7.org/linux/man-pages/man5/core.5.html)

## Worked case: low host CPU, slow requests

Suppose the 99th-percentile request latency (p99) rises from 40 ms to 380 ms while the host dashboard shows 48 percent CPU. That graph cannot distinguish spare host capacity from a throttled service cgroup.

During one 60-second reproduction, record request latency, per-thread CPU-time deltas, the service cgroup's `cpu.stat` and `cpu.pressure` deltas, and scheduler events for the affected thread IDs. If wall time rises while thread CPU stays flat, `nr_throttled` and throttled time grow, and scheduler evidence shows runnable gaps inside the same request windows, CPU quota is a supported explanation. Host-wide idle time does not refute it because the quota belongs to the cgroup.

Now test the claim. Raise or remove `cpu.max` in an isolated copy of the workload, keep input and CPU placement fixed, and repeat the interval. The diagnosis survives only if throttling and tail latency fall together without moving the delay into another resource. If they do not, return to the off-CPU branches.

## Summary

Linux diagnosis works when identity, scope, interval, and expected evidence stay attached to every measurement. Tool output without those fields is a clue that may belong to another process or another minute.

- Preserve boot ID, process start time, pidfd where available, namespace links, cgroup path, executable build, and both wall and monotonic time before restarting.
- Use snapshots for current state, counter deltas for bounded totals, profiles for where CPU time is distributed, and traces for selected event order.
- Split elapsed time into on-CPU work, runnable delay, blocking, quota throttling, and resource pressure before choosing a tool.
- `strace` exposes syscall contracts; `perf` counts and samples; ftrace and eBPF observe kernel events. None proves causation without a prediction and controlled change.
- PSI measures stalled work in a resource scope, not utilization or ownership. Join it with cgroup counters and task-level events.
- Retain matching binaries and symbols with a core dump, and protect the dump because it can contain production data and secrets.

## References

- [Linux man-pages: proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html)
- [Linux man-pages: proc_pid_stat(5)](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html)
- [Linux man-pages: pidfd_open(2)](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
- [strace manual](https://man7.org/linux/man-pages/man1/strace.1.html)
- [Linux perf tutorial](https://perf.wiki.kernel.org/index.php/Tutorial)
- [Linux kernel: ftrace](https://docs.kernel.org/trace/ftrace.html)
- [Linux kernel: event tracing](https://docs.kernel.org/trace/events.html)
- [Linux kernel: Pressure Stall Information](https://docs.kernel.org/accounting/psi.html)
- [Linux man-pages: core(5)](https://man7.org/linux/man-pages/man5/core.5.html)

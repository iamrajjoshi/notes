---
title: The kernel boundary
description: Build a usable map of user space, syscalls, processes, file descriptors, and the privilege checks that sit beneath every service.
slug: kernel-boundary
order: 1
identifier: LL1
duration: 125 min
difficulty: Foundation
tags:
  - kernel
  - syscalls
  - processes
  - security
---

## Working model

Treat the kernel as a shared switchboard with guarded entry points. A process asks through a syscall; the kernel checks identity and policy, finds an object such as a file or socket, then performs work on the process's behalf.

## Name the layers before tracing them

A **program** is executable code and data stored in a file. A **process** is one running instance with its own virtual address space, credentials, open descriptors, and one or more execution threads. A **thread** is an execution stream with registers and a stack; Linux schedules threads as tasks.

The processor, RAM, storage, and network devices are hardware. The **kernel** is the privileged software that schedules CPU time, manages memory, talks to devices, implements filesystems and network protocols, and checks access. **User space** contains ordinary processes such as an application server, shell, database, and service manager. People often use “operating system” for the kernel plus those user-space tools.

Each process receives a virtual address space so the same numeric address can refer to different memory in different processes. It cannot ordinarily read another process's memory or program a device directly. Instead it asks the kernel through system calls.

```text
program file --exec--> process
process contains one or more threads
thread runs application instructions in user space
system call asks the kernel to act on a file, socket, memory range, or process
kernel checks policy, touches hardware or kernel state, then returns a result
```

## A syscall is a controlled entry, not a library call

Application code usually calls a language runtime or a standard C library (`libc`) wrapper. When the operation needs kernel authority, the wrapper places a syscall number and arguments where the processor architecture expects them, changes privilege level through a syscall instruction, and waits for a result.

The kernel validates user pointers and permissions before touching a file, socket, process, mapping, or device. A context switch may happen during that work, but entering the kernel does not automatically mean the scheduler switched to another process.

A syscall can return immediately, fail with an error, or block the calling thread until progress becomes possible. For example, `read` from a regular cached file may copy bytes at once, while `read` from an empty pipe or socket may sleep until data arrives. Blocking one thread does not automatically stop the other threads in that process.

## A descriptor connects application code to a kernel object

On a successful `open`, `socket`, or similar call, the kernel returns a file descriptor: a small nonnegative integer in that process. Descriptors 0, 1, and 2 conventionally begin as standard input, standard output, and standard error. The integer is meaningful only through that process's descriptor table.

Suppose a server calls `recv` on descriptor 7. The runtime enters the kernel, the kernel resolves 7 to an open socket description, checks the socket state, and either copies available bytes or sleeps the thread. A readiness API such as `epoll` can let one thread wait for many descriptors instead of assigning a blocked thread to each connection. Later notes follow the scheduler and network queues below this boundary.

A pathname and an open descriptor have different lifetimes. `unlink` removes one directory entry for a file; an already-open descriptor still refers to the open file description and underlying object until the final reference closes. This is why a process can keep reading a file whose old pathname no longer resolves.

> **Keep the boundaries straight.** A function call stays within one address space. A syscall crosses into the host kernel. A hypercall, covered later, comes from a guest kernel to a hypervisor interface.

## A process is a group of tasks that share selected state

Linux schedules tasks. A conventional multithreaded process is a thread group whose tasks share an address space, file-descriptor table, signal dispositions, and other state selected when the tasks are created. The thread-group leader's ID is the process ID shown by most tools; every thread also has its own task ID, register state, stack, scheduling state, and signal mask.

This distinction matters during an incident. `/proc/<pid>/status` mostly describes the thread-group leader, while `/proc/<pid>/task/<tid>/status`, `sched`, and `stack` expose a specific thread where permissions and kernel configuration allow it. A process can look idle even though one thread spins, blocks every shutdown signal, or owns the descriptor another thread is waiting on.

A descriptor is a small integer that points through the process table to an open file description. Duplicated descriptors can share the same file offset and status flags. Sockets, pipes, terminals, event queues, and ordinary files all fit this descriptor model, which is why Unix tools compose so well.

The proc filesystem exposes a live view of much of this state. Inspecting /proc/<pid>/fd, status, maps, mountinfo, and cgroup often answers more than a generic process list.

_Run only in a disposable Linux environment after replacing PID with a process you own._

```shell
readlink /proc/$PID/fd/3
sed -n '1,24p' /proc/$PID/status
sed -n '1,20p' /proc/$PID/maps
```

## A process starts, replaces its program, and leaves a result

A parent creates a child with fork or clone, and exec replaces that process's program image while preserving selected state such as open descriptors. When the child exits, the kernel retains its PID and status until the parent calls wait. That small retained record is a zombie; it consumes no ordinary user-space memory, but an unreaped stream can exhaust process identifiers.

Signals are asynchronous notifications, not remote function calls. A signal's disposition is shared by the process, but each thread has its own mask and thread-pending set. `kill` normally sends a process-directed signal, which the kernel delivers to one eligible thread that has not blocked it. `pthread_kill` or `tgkill` targets one thread. SIGTERM can start an orderly shutdown when the program handles it; SIGKILL and SIGSTOP cannot be caught, blocked, or ignored.

Signal handlers interrupt ordinary control flow, so only async-signal-safe operations belong in a handler. A common server design blocks shutdown signals in worker threads and has one thread consume them with `sigwaitinfo` or `signalfd`, then coordinates shutdown through normal synchronization. After `execve`, dispositions for caught signals return to default while ignored dispositions remain ignored.

### Follow signal delivery instead of guessing

Read SigBlk, SigIgn, and SigCgt in /proc/<pid>/status, then inspect every thread under /proc/<pid>/task before blaming a missing handler. A blocked signal can remain pending until an eligible thread accepts it.

[Linux man-pages: signal(7)](https://man7.org/linux/man-pages/man7/signal.7.html)

### A zombie needs a waiter, not more CPU

The parent must collect child state with wait or arrange a supervisor that does. Killing a zombie cannot remove it because the child has already exited; repair the parent or let its parent adopt and reap the record.

[Linux man-pages: wait(2)](https://man7.org/linux/man-pages/man2/wait.2.html)

### A PID is a reusable number; a pidfd is a reference

A PID can name a different process after the original process exits and its status is reaped. That makes a delayed `kill(pid, sig)` vulnerable to a lookup race. A PID file descriptor obtained with `clone`/`clone3` or `pidfd_open` refers to that process instance and can be polled for exit or passed to `pidfd_send_signal`. A supervisor should retain the pidfd it received at process creation rather than repeatedly rediscovering a worker by numeric PID.

[Linux man-pages: pidfd_open(2)](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)

## The kernel starts PID 1; a service manager builds the running system

Firmware and a boot loader select a kernel and often an initramfs. The kernel initializes memory, scheduling, and device support, mounts an initial root, then starts its first user-space process as PID 1. Early /init code can find and switch to the final root before it execs a service manager. systemd commonly becomes that manager, but Linux does not require it.

A systemd unit declares dependencies, startup commands, restart policy, credentials, and resource settings. PID 1 starts the service in a cgroup and records its state, while journald can retain stdout, stderr, and service metadata. A restart loop may hide the first failure, so inspect the exit status and the current boot's logs before changing policy.

_Replace UNIT and PID with a service you own. These read-only checks connect supervision state to the kernel's process view._

```shell
systemctl show -p ActiveState -p SubState -p MainPID -p ExecMainStatus UNIT
journalctl -b -u UNIT --no-pager
cat /proc/$PID/status
cat /proc/$PID/cgroup
```

### Separate an early-boot failure from a service failure

If PID 1 never ran, service logs cannot explain the outage. Check the boot loader, kernel command line, initramfs, root mount, and kernel log first; use the unit dependency graph only after the service manager is alive.

[systemd: bootup sequence](https://github.com/systemd/systemd/blob/main/man/bootup.xml)

### Read the unit's process contract

Type= changes when systemd considers startup complete, and KillMode= changes which processes receive stop signals. Inspect the loaded unit and runtime properties rather than inferring them from the main command alone.

[systemd.service manual](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)

### Keep one diagnostic loop across layers

Reproduce the symptom, name the process and its namespace, cgroup, mount, and boot view, capture current state plus a bounded event timeline, then state one hypothesis and a check that could disprove it. Make one reversible change, verify the original symptom, and retain enough evidence to roll back.

## Root was split into checks that compose

Linux capabilities divide many traditional root powers into named checks such as CAP_NET_ADMIN. Capability sets belong to a thread, and the relevant user namespace changes what a capability authorizes. UID 0 inside a user namespace therefore does not carry every capability in the initial user namespace.

Seccomp filters which syscalls a thread may attempt; it does not decide whether an allowed syscall should succeed. An unprivileged task must set `no_new_privs` before installing a filter. That bit is inherited across fork, clone, and exec, cannot be cleared, and prevents exec from gaining privilege through set-user-ID bits or file capabilities. Linux security modules such as SELinux or AppArmor add policy checks around kernel objects.

Namespaces change which resources a process can see, but they do not create a second kernel. PID 1 inside a PID namespace also inherits special signal and child-reaping behavior, so an application that ignores orphaned children can slowly fill the namespace's process table.

- Capabilities answer which privileged operation a credential may request.
- Seccomp narrows the syscall surface.
- An LSM evaluates policy around operations on kernel objects.
- Namespaces change a process's view and identity inside selected subsystems.

These controls are independent. A namespace does not grant filesystem access, seccomp does not replace a capability check, and `no_new_privs` does not prevent a process that already holds authority from using it without exec.

## Trace a denied open from return value to enforcement point

Suppose openat returns -1 with EACCES. The syscall number only identifies the requested operation; it does not identify the rejecting check. Resolve the path in the target process's mount namespace, inspect search permission on every directory component, then compare the process's real and effective IDs, supplementary groups, capabilities, and current LSM label with the file and mount policy.

A seccomp rejection looks different. Depending on the filter action, the task can receive an errno, a signal, a notification to a supervisor, or termination. Kernel audit records and the process's Seccomp field can narrow that branch, while a syscall trace confirms the arguments and return without proving which policy made the decision. Keep the PID, boot ID, namespace identifiers, executable, and timestamp beside the trace so a restart does not silently replace the subject under investigation.

_Run tracing only on a process you own. Enter the target mount namespace before interpreting its pathname._

```shell
strace -f -e trace=openat,openat2 -p PID
cat /proc/PID/status
readlink /proc/PID/ns/{mnt,user,pid}
namei -l /path/seen/by/process
findmnt -T /path/seen/by/process
```

### Do not turn errno into a policy name

Several permission paths can return the same errno, and policy can change between observation and retry. First capture the failing arguments and process identity; then test each applicable check against that same process view.

[Linux man-pages: syscalls(2)](https://man7.org/linux/man-pages/man2/syscalls.2.html)

## Summary

The kernel boundary explains why a service can see one path, hold another object open, and still fail an operation after entering the same syscall. Diagnose the specific process view, referenced kernel object, credentials, and policy check rather than treating “permission denied” or “the process is running” as a complete explanation.

- A library call stays in the process; a syscall enters the host kernel through an architecture-defined interface. Entering the kernel does not imply that the scheduler switched processes.
- A program is stored code; a process is a running instance with an address space and descriptors; a thread is the schedulable execution stream inside it. User-space processes ask the privileged kernel to operate on shared hardware and kernel objects.
- Linux schedules tasks. Threads in one process share the address space, descriptor table, and signal dispositions but keep task IDs, registers, stacks, scheduling state, and signal masks.
- A file descriptor names an open file description. Duplicated descriptors can share offsets and status flags, and unlinking a pathname does not close an already-open object.
- Fork or clone creates a child, exec replaces its program, exit retains status, and wait reaps it. A zombie needs its parent or a supervisor to wait, not more CPU or another kill. A retained pidfd avoids signaling a different process after PID reuse.
- PID 1 starts and supervises user space, and PID 1 inside a PID namespace has special signal and child-reaping duties.
- Capabilities gate privileged operations, seccomp filters attempted syscalls, LSMs apply object policy, and namespaces alter the process view. These checks compose.
- For EACCES, capture the failing arguments and process identity, then inspect mount namespace, path-component permissions, IDs and groups, capabilities, mount flags, and LSM records against the same process instance.

## References

- [Linux man-pages: syscalls(2)](https://man7.org/linux/man-pages/man2/syscalls.2.html)
- [Linux man-pages: intro(2)](https://man7.org/linux/man-pages/man2/intro.2.html)
- [Linux man-pages: open(2)](https://man7.org/linux/man-pages/man2/open.2.html)
- [Linux man-pages: epoll(7)](https://man7.org/linux/man-pages/man7/epoll.7.html)
- [Linux man-pages: proc(5)](https://man7.org/linux/man-pages/man5/proc.5.html)
- [Linux man-pages: clone(2)](https://man7.org/linux/man-pages/man2/clone.2.html)
- [Linux man-pages: signal(7)](https://man7.org/linux/man-pages/man7/signal.7.html)
- [Linux man-pages: pidfd_open(2)](https://man7.org/linux/man-pages/man2/pidfd_open.2.html)
- [Linux man-pages: capabilities(7)](https://man7.org/linux/man-pages/man7/capabilities.7.html)
- [Linux kernel: no new privileges](https://docs.kernel.org/userspace-api/no_new_privs.html)
- [Linux kernel: seccomp filter](https://docs.kernel.org/userspace-api/seccomp_filter.html)
- [Linux kernel: LSM development](https://docs.kernel.org/security/lsm-development.html)

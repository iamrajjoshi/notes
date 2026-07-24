---
title: Linux storage and I/O
description: Separate block devices, filesystems, caches, and completion APIs so storage latency stops looking like one opaque number.
slug: storage-and-io
order: 4
identifier: LL4
duration: 145 min
difficulty: Core
tags:
  - block devices
  - filesystems
  - page cache
  - io_uring
---

## Working model

Storage is a stack of queues and caches. An application operation may finish after a memory copy, after filesystem metadata work, or only after a device reports durable completion; the API and flags decide which milestone counts.

## Start with the persistence promise

Random-access memory (RAM) is volatile: its ordinary contents disappear when power or the machine fails. Storage devices retain data, but an application still has to name the failure it cares about. Data copied into a process buffer, accepted into the kernel page cache, acknowledged by a device cache, and stored on nonvolatile media are different completion points.

A **file** is a named byte sequence plus metadata under a filesystem contract. A **block device** exposes numbered fixed-size storage ranges to a filesystem, database, or another block user. A solid-state drive (SSD) or disk has internal controllers, queues, caches, and failure behavior below the operating-system block interface. “The write returned” is therefore incomplete unless the application programming interface (API), flags, filesystem, and device durability contract are known.

```text
application bytes
  -> kernel file API and page cache
  -> filesystem metadata and allocation
  -> block request queue
  -> device controller and media
```

## A block device is not a filesystem

A block device exposes addressable blocks and request queues. A filesystem assigns names, directories, permissions, allocation metadata, and crash-recovery rules to data stored on that device. The Virtual Filesystem (VFS) layer gives applications a shared file API across different filesystems.

Buffered file I/O normally interacts with the page cache. The kernel can merge writes and schedule writeback later, which helps throughput but separates write() completion from durable media. Filesystem journaling protects selected metadata or data invariants; it is not a universal promise that every recent application write survived.

## Build the block stack from media to application

Several storage words answer different questions. A **solid-state drive (SSD)** is a storage-device implementation, usually combining nonvolatile flash media with a controller that performs logical-to-physical mapping, error correction, wear leveling, garbage collection, command scheduling, and cache management. Those internals can change latency even when the host sends the same logical block request.

**NVMe** is a host-controller protocol and command model for nonvolatile storage, not a synonym for SSD media. An NVMe controller exposes one or more **namespaces**. A namespace is a logical collection of block addresses visible to host software; it is not necessarily a physically isolated set of flash chips. Linux can expose namespace 1 behind controller 0 as `/dev/nvme0n1`, but applications above the block layer should not infer physical NAND placement from that name.

A **block device** is the operating-system abstraction presented upward. It might be backed by an NVMe namespace, a SATA SSD, an HDD, a SCSI logical unit, a virtual machine's virtio device, a network volume, a RAID array, or another mapped block device. A cloud volume can therefore look like a local block device while its service implements remote queues, replicas, burst credits, and failure boundaries outside the guest. “NVMe,” “SSD,” “local,” and “durable” are not interchangeable promises.

### Trace one common Linux stack

One common path is shown below. It is illustrative rather than mandatory: systems can assemble RAID from partitions, partition an array, put RAID below or above selected device-mapper targets, or let a database use a block device without a filesystem. Inspect the deployed major/minor mappings rather than guessing from one `/dev` name.

```text
physical SSDs or HDDs / cloud block volumes
  -> controller protocol and host driver
  -> NVMe namespaces, SCSI LUNs, or virtual block devices
  -> optional MD RAID or hardware/provider RAID
  -> optional partition table and partitions
  -> optional device-mapper mappings managed directly or through LVM
       (linear volumes, encryption, RAID, cache, thin volumes, snapshots)
  -> filesystem and mount
  -> VFS, page cache or direct-I/O path
  -> application
```

A partition describes a bounded range of sectors on a lower block device. Device-mapper creates a new virtual block device by mapping its logical sectors to one or more lower devices; LVM is a userspace volume manager that commonly builds logical volumes through device-mapper. Each layer adds its own identity, metadata, limits, queueing, flush behavior, monitoring, and recovery path. `lsblk`, `findmnt`, `/sys/dev/block`, `dmsetup ls --tree`, `lvs`, and `/proc/mdstat` reveal different parts of the graph.

### NBD lets userspace implement a block device

The Linux Network Block Device (NBD) driver exposes devices such as `/dev/nbd7` while forwarding block requests to a userspace process. The backend may contact a remote server, but the word “network” does not require that. A local daemon can receive NBD commands over a Unix socket and satisfy them from files, caches, or an object store.

```text
application file read
  -> VFS and ext4
  -> logical block read on /dev/nbd7
  -> kernel NBD driver
  -> Unix socket
  -> userspace dispatcher
  -> private cache, shared cache, or object-store range read
```

A Go NBD dispatcher is the request loop that decodes commands such as READ, WRITE, and FLUSH, checks ranges, performs the backend operation, and sends a completion. It is unrelated to a Kubernetes scheduler or application-work dispatcher. Several socket connections may serve one device so independent block requests can proceed concurrently.

The filesystem still belongs above NBD. ext4 interprets the virtual device's raw blocks as directories, inodes, extents, data, and journal records. If the userspace backend dies or loses its device connection, the mounted filesystem can receive I/O errors even though the mount point remains visible. Monitor the NBD device, daemon, cache, object store, filesystem, and application as separate layers.

### RAID trades capacity and write work for a failure model

RAID combines devices below the filesystem. It can preserve availability through selected device failures, but it does not undo deletion, repair application corruption, stop ransomware, preserve an older logical version, or survive every controller, software, rack, or site failure. State the layout and the exact failures it tolerates instead of saying only “the disk is redundant.”

| Layout  | Placement and usable capacity                                                                                                  | Failure contract and write cost                                                                                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAID 0  | Stripes data across all members; approximate usable capacity is the sum of member contributions.                               | No redundancy. Losing any required member loses the array. Parallel devices can raise throughput for a suitable workload, but the array also depends on every member.                                                                                |
| RAID 1  | Stores mirrored copies; a two-member mirror has about one member's usable capacity.                                            | Reads can use either copy, while writes reach every required copy. It survives a member loss while at least one complete in-sync copy remains; the common two-member case tolerates one device failure.                                              |
| RAID 10 | Stripes across mirrored groups; a common two-copy layout uses about half of raw capacity.                                      | Combines parallel stripes with mirrors. It may survive more than one device loss only when the failed members do not remove every copy from the same mirror group. The exact MD layout and copy count matter.                                        |
| RAID 5  | Stripes data with one distributed parity contribution; approximate usable capacity is `N - 1` members for equal-sized devices. | Tolerates one member failure. Small writes can require old-data or old-parity reads plus parity calculation and multiple writes. After one failure, the array is degraded with no remaining device-failure tolerance until reconstruction completes. |
| RAID 6  | Stripes data with two independent parity contributions; approximate usable capacity is `N - 2` members.                        | Tolerates two member failures, with more parity calculation and write traffic than RAID 5. After one failure it retains one-device fault tolerance, but degraded reads and rebuild still consume surviving capacity.                                 |

A rebuild writes a replacement by reading surviving data and reconstructing missing blocks. That raises load and latency precisely when redundancy is reduced; a second failure, an unreadable sector, a link problem, or an operator mistake can turn a recoverable event into data loss according to the layout. Larger devices, slow replacement media, throttled rebuilds, and foreground traffic lengthen the exposure window. Monitor degraded state and rebuild progress, test replacement procedures, scrub where the stack supports it, and keep an independent backup.

### Snapshots and thin volumes share lower failure domains

A snapshot records a point-in-time logical view, commonly by sharing unchanged blocks and storing changed chunks through copy-on-write metadata. It is not automatically application-consistent: buffered writes and in-flight database transactions may require a filesystem freeze, application checkpoint, or database-native backup protocol before the snapshot. A device-mapper snapshot can also become unusable if its copy-on-write store fills.

Thin provisioning presents a logical device whose full address space is not allocated from the physical pool up front. Writes allocate data blocks and update mapping metadata later. This improves utilization and makes snapshots efficient, but the sum of advertised logical sizes can exceed real capacity. Exhausting the thin data pool or its metadata can stop writes or fail the mapped device according to the configured target and recovery policy, so monitor both data and metadata headroom.

Neither mechanism is an independent backup by definition. A snapshot that depends on the same origin, pool metadata, credentials, account, controller, or region can disappear with that failure domain. A backup plan identifies an independently retained copy, protects it from ordinary mutation, records consistency and encryption requirements, and proves restore within a recovery-time target. A provider snapshot may participate in that plan only when its documented storage, retention, access, and regional failure contract meets those requirements.

### Convert latency and queue depth into an I/O ceiling

**IOPS** counts completed input/output operations per second. **Throughput** counts completed bytes per second. For a fixed request size, their unit relationship is direct:

```text
throughput in bytes/s = IOPS x bytes/operation
```

Concurrency connects latency and completion rate. In a stable interval, Little's Law gives average outstanding operations as the completion rate multiplied by average time in the measured system:

```text
average outstanding operations ~= IOPS x average latency in seconds
IOPS ~= average outstanding operations / average latency in seconds
```

Suppose 32 requests remain outstanding, each completion takes 4 ms on average at the declared boundary, and every operation transfers 4 KiB or 4,096 bytes. If the workload remains stable and has enough work to keep that concurrency active:

```text
IOPS ~= 32 operations / 0.004 s = 8,000 operations/s

throughput = 8,000 operations/s x 4,096 bytes/operation
           = 32,768,000 bytes/s
           = 32.768 MB/s decimal
           = 31.25 MiB/s binary
```

This is a relationship among measured averages, not a device guarantee. A configured queue depth of 32 does not prove that 32 operations are always active; application think time, dependencies, filesystem locks, merging, and queue limits can reduce actual concurrency. A mixed-size workload needs byte-weighted calculation rather than multiplying one nominal size, and reads plus writes may have different service times and device costs.

### Queue depth can buy throughput while destroying a deadline

Deeper queues let controllers and devices reorder work and keep parallel resources busy. Throughput can rise until some layer saturates. Beyond that point, added work mostly waits: average latency grows, and p95 or p99 can rise much faster when garbage collection, writeback, parity work, cache misses, cloud throttling, or a slow member creates a long service-time tail. Report queueing time separately from device service time when the tools allow it.

A benchmark result belongs to its boundary. Record whether the clock starts in the application, filesystem, kernel block layer, guest device, or provider; whether data is cache-hot or exceeds every relevant cache; buffered versus direct I/O; read/write ratio; random or sequential addresses; request-size distribution; jobs and actual outstanding operations; sync, `fsync`, flush, or Force Unit Access (FUA) behavior, which asks a supporting device to place that command's data on non-volatile media before completing it; dataset size and preconditioning; test duration and warm-up; device fill level; CPU and NUMA placement; RAID degraded state; and cloud volume limits or credits. Report throughput, IOPS, mean latency, and latency percentiles together. A single peak IOPS number cannot be transferred to a different request shape or durability contract.

## The page cache is indexed by file and offset

For ordinary files, cached pages or larger groups called folios belong to the file's address-space object and cover byte offsets in that file. A buffered read can copy from existing cached data or trigger readahead and I/O to fill it. A file-backed `mmap` fault can map the same cached data into a process, while a buffered or mapped write marks cache state dirty for later writeback.

The dentry and inode caches solve different problems: dentries cache pathname components, and inodes cache file identity plus metadata. Dropping clean file data under pressure does not imply that every pathname or inode object disappears at the same time. Dirty data must reach writeback or report an error before the kernel can reclaim it safely.

Direct I/O bypasses the data page cache for the request, not VFS, permissions, allocation metadata, or every device cache. Mixing direct I/O with buffered access or writable mappings needs the filesystem's alignment and coherency rules; “O_DIRECT means raw disk” is false.

## A pathname resolves through mounts to an inode

Path lookup walks one component at a time from the process's root or current directory. The process needs search permission on each directory, and its mount namespace decides which filesystem appears at each mount point. A dentry associates a name with an inode; the inode stores object metadata and points toward file data, but it does not store the pathname used to reach it.

Hard links give one inode more than one name. unlink removes one name, while an already-open file description can keep the inode alive until the last descriptor and mapping release it. Mode bits, ACLs, mount flags, capabilities, and LSM policy can all affect access, so a numeric permission string alone cannot explain every denial.

### Debug lookup in the process's own view

Use namei -l or stat to inspect components, findmnt -T to identify the covering mount, /proc/<pid>/mountinfo for the target process's view, and /proc/<pid>/fd for already-open objects. A path that exists in your shell may be absent behind another mount namespace.

[Linux man-pages: path_resolution(7)](https://man7.org/linux/man-pages/man7/path_resolution.7.html)

### Mount propagation changes who sees a later mount

Shared, private, slave, and unbindable propagation control whether mount and unmount events cross peer boundaries. Inspect propagation before assuming a host mount should appear inside a container.

[Linux man-pages: mount_namespaces(7)](https://www.man7.org/linux/man-pages/man7/mount_namespaces.7.html)

### A filesystem mount and a bind mount do different jobs

A filesystem mount attaches a filesystem implementation to a directory. For example, mounting `/dev/nbd7` as ext4 at `/mnt/workspaces/volume-42` makes the device's ext4 directory tree visible there.

A bind mount exposes an existing mounted file or directory tree at another pathname. Binding `/mnt/workspaces/volume-42` to a kubelet publish target does not copy the bytes, format another filesystem, or create a second set of files. Both paths reach the same mounted objects while namespace, propagation, and mount flags decide which processes can see and modify them.

```text
/dev/nbd7
  -> ext4 filesystem mount at /mnt/workspaces/volume-42
  -> bind mount at kubelet's CSI target
  -> container mount path
```

This two-step pattern lets a node storage daemon own one real filesystem mount while kubelet and the container runtime publish the already-mounted tree into a Pod's mount namespace.

## Direct, buffered, and mapped I/O pay different costs

Buffered I/O benefits from caching and readahead. Direct I/O bypasses the page cache for file data but adds alignment and coordination constraints; metadata and filesystem work still exist. mmap turns file access into memory loads and faults, which can simplify random reads but makes I/O latency appear at access sites.

The right path depends on reuse, record size, alignment, working-set pressure, durability, and the application's own cache. Running two caches for the same data can waste memory, while bypassing a useful page cache can make small reads worse.

> **Durability check.** A successful write usually means the kernel accepted bytes. If the design needs crash durability, state which file and directory metadata must reach storage and where fsync belongs.

## A durable file replacement has more than one commit point

Suppose a service replaces config.json without exposing a half-written file. It creates a temporary file in the same directory, loops until every byte has been written, then calls fsync on that file. A successful fsync establishes the file's required data and associated metadata under the filesystem and device contract; the program must still check the return value because writeback errors can surface here rather than at write time.

rename then atomically changes which name resolves to the file for concurrent lookups on the same filesystem. That namespace update belongs to the directory, so the service opens the containing directory and fsyncs it before reporting durable completion. A crash between these steps can leave the old name, the new name, or filesystem-specific recovery state. Test the protocol on the deployed filesystem and storage stack instead of inferring power-loss behavior from a successful process restart.

_Each arrow has an error path. Cleanup must not delete the last known-good file._

```text
create temp in target directory
  -> write loop handles partial writes and EINTR
  -> fsync(temp fd)
  -> rename(temp, final)
  -> fsync(directory fd)
  -> report durable replacement
```

### write success and fsync failure can coexist

Buffered writes can be accepted before allocation or device errors appear. Preserve the first write error, check close where the program's API requires it, and treat fsync failure as a failed durability transaction.

[Linux man-pages: fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html)

## io_uring reduces crossings for the right workload

A blocking `read` or `write` can put its calling thread to sleep. A program can use multiple threads, readiness APIs such as `epoll`, or an asynchronous completion API so other work continues. Readiness means an operation is likely to make progress without blocking; completion means the requested operation has finished with a result.

io_uring is a completion API. It shares submission and completion rings with the kernel so applications can batch work and reduce some syscall crossings. It does not make the filesystem or device intrinsically faster, and some operations can still use kernel worker threads. The benefit depends on operation mix, queue depth, batching, registered resources, kernel support, and the application's lifetime bookkeeping.

io_uring maps a submission queue and completion queue between user space and the kernel. The application obtains a submission queue entry (SQE), writes the opcode and arguments, assigns stable user_data, publishes the entry, and submits work. Each ordinary completion queue entry (CQE) returns that identifier plus res, which contains a nonnegative operation result or a negative error value. Buffers, descriptors, and request state must remain valid until the application consumes the matching completion.

The basic one-SQE/one-CQE model has explicit exceptions. A multishot request can emit several CQEs while IORING_CQE_F_MORE remains set, and IOSQE_CQE_SKIP_SUCCESS can suppress a successful completion. Code that enables either feature must express lifetime and shutdown in terms of its negotiated completion contract instead of counting one CQE per SQE.

Cancellation is another request, not a time machine. An IORING_OP_ASYNC_CANCEL SQE gets its own CQE, while the target request may finish before cancellation wins. The cancel CQE can report that it canceled work, found no matching request, or raced with work already completing. Correct teardown drains the applicable outcomes and accepts that the original CQE may report success, -ECANCELED, or another operation result. Linked timeouts can express a common operation-plus-deadline pair.

Setup flags, registered resources, and supported opcodes vary by kernel and policy. Probe the running ring with IORING_REGISTER_PROBE or liburing's probe helpers, keep a synchronous or older asynchronous fallback, and benchmark tail latency and CPU cost with the exact filesystem, queue depth, and operations in use.

_Every submitted request reaches a completion path, including cancellation and timeout requests._

```text
get SQE -> prepare opcode + user_data -> publish SQ tail -> submit
                                                        |
consume CQE <- inspect cqe->res + user_data <- kernel completes request

cancel SQE -> cancel CQE
         \-> target CQE may already have won the race
```

### Probe operations before enabling the fast path

A kernel can create a ring yet reject a newer opcode or setup mode. Query supported operations, check returned feature flags, and exercise the fallback during tests; startup success alone does not prove the production request mix is supported.

[Linux man-pages: io_uring_register(2)](https://man7.org/linux/man-pages/man2/io_uring_register.2.html)

### Treat cancellation as a two-completion race

Give the original request and its cancel request different user_data values, consume both CQEs, and release the target buffer only after the original request has reached a terminal result.

[Linux man-pages: io_uring cancellation overview](https://man7.org/linux/man-pages/man7/io_uring_cancelation.7.html)

## Locate storage delay before changing the I/O API

Measure the application's operation latency first, including queueing before it calls the kernel. A slow request with little block-device activity can be waiting on a filesystem lock, dirty-page limits, memory reclaim, an io_uring worker, or a remote filesystem. Conversely, a busy device does not prove that one request waited there; correlate the process, file, block device, and time window.

`pidstat -d` gives process-level I/O rates, `/proc/diskstats` and `iostat -x` summarize device queues, and `/proc/pressure/io` reports time tasks lost to I/O pressure. Kernel tracepoints or block tracing can connect issue and completion when access policy permits it. For io_uring, count submissions, CQEs, negative results, queue depth, worker creation, and time from application enqueue to completion. A lower syscall count is useful only if CPU cost or latency improves for the target distribution.

_Collect a short synchronized interval. Some tools need extra privileges and can add measurable overhead._

```shell
pidstat -d -p PID 1
iostat -x 1
cat /proc/pressure/io
cat /proc/diskstats
perf trace -p PID
```

### Reproduce with the same cache and durability state

A cache-hot read, a cold read, a buffered write, and an fsync-heavy transaction exercise different paths. State which one the test represents; dropping host caches changes the whole machine and is unsafe on a shared system.

[Linux kernel: block subsystem](https://docs.kernel.org/block/index.html)

## Summary

Storage APIs expose different completion points across the page cache, filesystem, block layer, and device. Correctness starts by naming whether an operation only copied bytes into memory, made a namespace change visible, or reached the durability boundary promised by the deployed stack.

- A block device supplies addressed blocks and queues; a filesystem supplies names, permissions, allocation, and recovery rules; VFS presents a common file API.
- An SSD is media plus a controller, NVMe is a host-controller protocol, an NVMe namespace is a logical block-address space, and a Linux block device is the generic interface exposed upward. None of those words alone proves physical isolation or durability.
- Trace the real device graph: physical or cloud device → controller-facing block device → optional RAID → partition → device-mapper or LVM → filesystem → application. Alternate compositions exist, so inspect mappings and failure domains rather than inferring them from a path name.
- NBD can expose a userspace-backed `/dev/nbdN`; a dispatcher serves logical block commands from local or remote storage. Backend failure can surface as filesystem I/O errors above a still-visible mount.
- RAID 0 has no redundancy; RAID 1 mirrors; RAID 10 stripes mirrored groups; RAID 5 survives one member failure; RAID 6 survives two. Rebuild consumes surviving capacity while redundancy is reduced, and RAID does not replace an independent, restorable backup.
- Snapshots share blocks and thin volumes allocate later. Both depend on mapping metadata and pool headroom, and neither is automatically application-consistent or independent of its origin's failure domain.
- I/O units must balance. With 32 average outstanding 4 KiB operations and 4 ms average latency, the stable ceiling is about 8,000 IOPS and 32.768 MB/s. Deeper queues can raise throughput until saturation while worsening tail latency.
- Volatile process memory, dirty page-cache data, filesystem-visible names, device acknowledgement, and durable media are different completion points.
- Path lookup uses the process's root, current directory, mount namespace, and search permission on every component. A dentry maps a name to an inode; an inode does not own one permanent pathname.
- A filesystem mount interprets a device at one directory. A bind mount republishes that existing tree at another path without copying bytes or creating another filesystem.
- Buffered I/O uses the page cache, direct I/O adds alignment and coordination constraints, and mmap moves latency into page faults. Select from reuse, working set, record shape, and durability needs.
- A durable same-filesystem replacement is write temp completely → fsync temp → rename → fsync containing directory. Check every return value because writeback failures can appear at fsync.
- Each io_uring request needs stable request identity and live resources until its completion contract ends. Ordinary requests yield one CQE, multishot requests may yield several, and skip-success can suppress a successful CQE. Cancellation adds another completion and can lose a race to normal completion.
- Blocking calls, readiness notification, thread pools, and completion APIs move waiting and bookkeeping to different places. io_uring can batch submissions and completions; it does not remove filesystem or device latency.
- Probe supported io_uring operations and features on the running kernel and keep the fallback tested; successful ring creation does not prove every opcode is available.
- Correlate application queueing, filesystem locks, writeback, reclaim, worker queues, block issue and completion, device pressure, and requested durability before changing the I/O API.

## References

Version-sensitive NVMe and Linux block-stack documentation was reviewed on 18 July 2026. Recheck the live documentation for the deployed kernel, device, and provider.

- [NVM Express: specifications](https://nvmexpress.org/specifications/)
- [NVM Express: namespaces](https://nvmexpress.org/resource/nvme-namespaces/)
- [Linux kernel: NVMe multipath and namespace block devices](https://docs.kernel.org/admin-guide/nvme-multipath.html)
- [Linux kernel: block subsystem](https://docs.kernel.org/block/index.html)
- [Linux kernel: Network Block Device](https://docs.kernel.org/admin-guide/blockdev/nbd.html)
- [Linux kernel: MD RAID arrays](https://docs.kernel.org/admin-guide/md.html)
- [Linux kernel: device-mapper](https://docs.kernel.org/admin-guide/device-mapper/index.html)
- [Linux kernel: device-mapper RAID](https://docs.kernel.org/admin-guide/device-mapper/dm-raid.html)
- [Linux kernel: device-mapper snapshots](https://docs.kernel.org/admin-guide/device-mapper/snapshot.html)
- [Linux kernel: device-mapper thin provisioning](https://docs.kernel.org/admin-guide/device-mapper/thin-provisioning.html)
- [Linux kernel: iomap operations](https://docs.kernel.org/filesystems/iomap/operations.html)
- [Linux kernel: page cache](https://docs.kernel.org/mm/page_cache.html)
- [Linux man-pages: mount and bind mounts](https://man7.org/linux/man-pages/man8/mount.8.html)
- [Linux man-pages: fsync(2)](https://man7.org/linux/man-pages/man2/fsync.2.html)
- [Linux man-pages: io_uring(7)](https://www.man7.org/linux/man-pages/man7/io_uring.7.html): Introduces SQEs, CQEs, shared ring mappings, submission, and completion handling.

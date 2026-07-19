---
title: Filesystems, Shared Memory, and Edge Systems
shortTitle: Filesystems, memory, and edge
description: Trace state through file metadata, client caches, distributed blocks, page coherence, remote memory, and battery-powered devices without confusing a convenient abstraction with its failure behavior.
collection: distributed-systems
slug: filesystems-shared-memory-and-edge
order: 9
number: DS9
duration: 3.5 hours
difficulty: Intermediate
tags:
  - distributed-filesystems
  - NFS
  - HDFS
  - shared-memory
  - RDMA
  - edge-computing
---

## Working model

A shared file, memory page, or sensor reading looks local only because another layer translates names and operations into network messages. Read the metadata authority, cache rule, write-visibility point, retry identity, and recovery path before trusting that abstraction.

## Questions this note answers

- Define file data, metadata, directories, file descriptors, links, offsets, and cache entries
- Follow one remote file read through the virtual filesystem and an NFS server
- Separate historical stateless NFS from current NFSv4 state, locking, and delegations
- Compare AFS, GFS, HDFS, object storage, block storage, and a shared POSIX filesystem
- Follow an HDFS write through NameNode allocation, the DataNode packet pipeline, acknowledgement, recovery, and later replication repair
- Explain why client caching creates a consistency contract rather than free speed
- Trace a distributed shared-memory read miss and write invalidation
- State what RDMA does and what coherence, ordering, and durability it does not supply
- Build an edge telemetry path and calculate a one-year device energy budget

## Begin with an ordinary file

A file contains bytes plus metadata. Metadata includes ownership, permissions, timestamps, size, link count, and a filesystem-level type such as regular file, directory, symbolic link, or device. An extension such as `.c` or `.java` is part of the name; Unix does not store it as the inode's file type.

A directory maps names to filesystem objects. A hard link adds another directory entry for the same underlying object and increases its link count. Removing one name does not delete the data while another hard link remains. If the last name disappears while a process still holds the file open, Unix normally retains the object until the final open reference closes. A symbolic link is a separate file whose contents name another path, so it can become dangling.

`open` resolves a path and returns a process-local file descriptor. That descriptor refers to an open-file description containing flags and a current offset. `read(fd, buffer, n)` may return fewer than `n` bytes, zero at end of file, or `-1` for an error. `write` can also complete partially. `lseek` changes the logical offset; it does not promise that a disk head physically seeks at that moment, and storage may not contain a moving head at all.

These details matter once the server moves across a network. A process-local descriptor and mutable offset create server state if the remote server owns them. A client can instead send a stable file identifier plus an absolute byte offset, making `read(file=81, offset=4096, length=4096)` safe to retry after losing a reply. Retrying `append these bytes` needs an operation ID or another deduplication rule because a lost response does not reveal whether the append happened.

## A distributed filesystem composes namespace, data, and RPC

A distributed filesystem lets a client use files whose authoritative metadata or contents live on other machines. The pleasant path resembles local I/O, but the implementation must answer harder questions:

- Which service maps `/team/report` to a stable object identifier?
- Where do replicas or erasure-coded fragments live?
- What does a successful write acknowledge: client memory, server memory, a journal, one disk, or several durable copies?
- When may another client see that write?
- Which operations can be retried after an ambiguous RPC result?
- What happens to open files, locks, and cached data after client or server restart?

The CS 425 “vanilla DFS” separates a directory service from a flat-file service. The directory service maps names to file IDs. The flat-file API reads and writes absolute positions. This is a useful derivation because stable IDs and explicit offsets reduce per-client server state. It is not a complete production filesystem: concurrent create, rename, append, lock, permission, replica repair, and crash recovery still require protocols.

Transparency also has a limit. A remote read may block during failover or return a stale cached block under the filesystem's documented rules. Pretending that a network partition is merely a slow local function can cause an application to hold threads, retry writes twice, or assume a lock still exists after its lease expired.

## Follow one NFS open, then one read

Suppose a process opens and then reads `"/mnt/team/a.txt"` on a path mounted from a Network File System (NFS) server. Opening a file and fetching its contents are separate protocol actions.

1. The kernel's virtual filesystem resolves path components until it reaches the NFS mount.
2. The NFS client uses `LOOKUP` operations to resolve the remaining names to an opaque remote file handle. Cached attributes or name lookups can avoid some network calls when their validation rules allow it.
3. In NFSv4, the client sends `OPEN` with an open owner, sequence information, and requested share access. A successful response supplies the file handle, state ID, and attributes needed to install a local file descriptor and open-file description. It need not return any file data.
4. When the process later calls `read(fd, buffer, count)`, the kernel checks the client's page cache for the requested offset.
5. On a data-cache miss, the client sends `READ` with the file handle or associated state, the state ID where required, an absolute offset, and a byte count.
6. The server checks the handle, credentials, and open or lock state, then obtains those bytes from its backing cache or filesystem and returns the data.
7. The reply fills the relevant page-cache pages, copies the available bytes to the process, and advances the local file offset by the number of bytes actually read. Later reads can hit that cache until validation, invalidation, or another coherence rule requires server contact.

Mounting does not clone a directory. It attaches a remote namespace at a local path. The same underlying file can therefore appear under different client paths.

The lecture's stateless description matches early NFS designs and remains useful for understanding stable file handles and retryable absolute operations. It is not a description of current NFSv4. NFSv4 integrates open state, share reservations, byte-range locking, client identity, state IDs, delegations, and recovery. A **delegation** lets a client cache with temporary authority until the server recalls it. That improves local access while introducing state-recovery and recall behavior.

Modern NFS file handles are opaque and not universally fixed at the lecture's 32-byte size. The old Solaris freshness intervals are historical implementation examples, not current cross-platform defaults. And “write-through equals consistent” is too broad: persisting one write before acknowledgment does not by itself define concurrent read visibility, lock behavior, metadata ordering, or replica failure semantics.

## Caches trade communication for a staleness rule

Server caching avoids repeated storage reads; client caching avoids repeated network calls. Both exploit locality. The bill arrives when another client changes the same object.

Imagine client A caches block 4 at version 18. Client B writes version 19 and receives success. If A trusts a ten-second freshness interval, a read during that interval may return version 18. Shortening the interval lowers the stale window but increases metadata traffic. A callback or delegation lets the server tell A that its cached authority has ended, though lost connections and restart recovery still need handling.

Andrew File System (AFS) chose a different historical point in this design space. AFS clients, called Venus, cached whole files on local storage; servers, called Vice, issued callback promises. Work happened on the local copy, and close propagated changes to the server. The design fit small files, read-heavy personal workloads, and clients with useful local disks. Whole-file transfer and close-time visibility fit poorly when several writers edit a large file concurrently.

AFS and NFS should remain contrasting case studies, not templates to reproduce without a workload. Ask how often files change, whether access is sequential or random, how large objects are, how many writers overlap, and whether POSIX close, rename, append, or locking semantics are required.

## GFS and HDFS split metadata from bulk data

Google File System (GFS) and Hadoop Distributed File System (HDFS) target large files and streaming data access on clusters where machine failure is expected. A metadata authority tracks the namespace and block placement; storage workers hold large chunks or blocks; clients obtain locations from metadata and transfer file data directly with workers.

That split keeps bulk bytes away from the metadata path, but metadata still needs durable journals, snapshots, failover, and memory capacity. Current HDFS documentation describes a NameNode as the metadata center and DataNodes as block stores. High-availability arrangements protect the NameNode role; federation can split namespaces. Calling this “multiple NameNodes” without distinguishing standby high availability from independent federated namespaces causes confusion.

HDFS traditionally replicated blocks, commonly three copies under a configurable policy. It also supports erasure-coded files, which trade storage overhead against extra fragments, network reads, CPU work, and a different small-I/O profile. Erasure coding did not replace replication for every file.

A MapReduce client asks HDFS for input block locations and tries to run each map near a replica. That is data locality: moving a small program is cheaper than moving a large block. Cloud object stores and fast disaggregated networks can shift the tradeoff, but shuffle and scan bytes still cross finite links.

GFS and HDFS do not promise every ordinary POSIX behavior. Their original design assumptions favor large sequential reads, append-oriented writes, and controlled writer patterns. A team editing source files over a mounted namespace and a data pipeline scanning terabytes need different filesystems.

## Follow one HDFS write through the replica pipeline

Suppose a client creates `/logs/2026-07-18/events` with a target replication factor of three. The NameNode handles names and placement; the file bytes take a different path.

1. **Create the file metadata.** The client sends `create` to the active NameNode. The NameNode checks the path, permissions, quota, and create flags, records an under-construction file with its writer lease, and persists the namespace change through the EditLog path. The NameNode does not receive the event bytes.
2. **Allocate a block and pipeline.** When the client needs the first block, it asks the NameNode for a new block. The NameNode chooses eligible DataNodes using health, storage policy, load, and rack-aware placement, then returns a block identity, generation stamp, access token, and an ordered pipeline such as `DN-A -> DN-B -> DN-C`.
3. **Build packets and checksums.** The client buffers bytes, divides them into checksum chunks, and groups chunks into numbered packets containing data plus checksums. Sequence numbers let the client match acknowledgements and replay only packets whose outcome is not complete.
4. **Stream down the chain.** The client sends each packet to DN-A. DN-A verifies and writes its local replica while forwarding the packet to DN-B; DN-B does the same toward DN-C. The client does not upload three independent copies. Pipelining lets every DataNode receive, store, and forward different portions concurrently.
5. **Return the acknowledgement chain.** DN-C sends a packet response upstream. DN-B adds its local status and passes the combined result to DN-A, which returns the pipeline acknowledgement to the client. The client removes a packet from its acknowledgement queue only after every current pipeline member reports success. A plain `write()` may have returned earlier after copying bytes into client-side buffers.
6. **Finish the block and file.** The client repeats allocation for later blocks. On close, it drains buffered packets, waits for the required pipeline responses, and asks the NameNode to complete the file. The NameNode persists the metadata transition from under construction to complete after HDFS's configured completion conditions hold.

Checksums detect a corrupted transfer or stored chunk; replication makes another copy available. They solve different failures. A checksum is not a replica, and three identically corrupted application records still pass their storage checksums.

Now suppose DN-B fails while packets 81 through 85 are outstanding. The client sees an error or missing acknowledgement, stops the old pipeline, and identifies the failed member. Pipeline recovery coordinates a new generation for the block, removes the bad DataNode, and, according to the replacement policy and available targets, may add DN-D. The surviving replicas and any replacement form a new chain, such as `DN-A -> DN-C -> DN-D`. Outstanding packets move back to the send queue and replay by sequence; packets already acknowledged by the full old pipeline do not need blind application-level rewrites.

Recovery may continue temporarily with fewer replicas. Current HDFS exposes the actual replication of the open block because it can differ from the file's target after a pipeline failure. That is why “the packet was acknowledged” and “the block has reached its final replication target” are separate statements.

File completion uses HDFS's configured minimum-replication condition; it need not wait for every block to return to the file's higher target after a failure. Background repair closes that gap. A successful close therefore has a stronger meaning than one packet acknowledgement but can still precede restoration of all desired replicas.

DataNodes send heartbeats for liveness and block reports that inventory the replicas they store; incremental reports communicate received or deleted blocks between full reports. The NameNode uses this information to maintain its in-memory location map. If a DataNode stops heartbeating, reports a corrupt replica, or no longer lists a block, the NameNode marks affected blocks under-replicated and schedules a healthy DataNode to copy each block to a new target. This repair occurs after the client pipeline and may finish after file close. Block reports do not carry the file namespace; the NameNode's file-to-block metadata tells it which file owns each block.

Name the acknowledgement boundary when durability matters:

| Boundary                          | What success establishes                                                                                       | What it does not establish                                                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `write()` returns                 | The output stream accepted bytes into its client-side path                                                     | DataNodes received the bytes or another reader can see them                                                                   |
| Packet acknowledgement            | Every member of the current pipeline reported success for that packet                                          | NameNode metadata durability, the configured final replica count, or disk-device persistence beyond the call's sync semantics |
| `hflush()` returns                | Buffered data reached the replicas sufficiently for new readers to see it under the HDFS contract              | The `hsync()` disk-device persistence boundary                                                                                |
| `hsync()` returns                 | Buffered data was flushed to the disk devices of the current replicas, with the documented device-cache caveat | Future survival of every replica, target-count repair, or backup                                                              |
| NameNode metadata edit is durable | The namespace and file-to-block transition can recover through the EditLog or HA shared-edits path             | The block bytes exist on every intended DataNode                                                                              |
| File completion and later repair  | The file met HDFS's completion condition; background repair can bring blocks to the desired replication factor | Protection from a bad delete, bad overwrite, or correlated failure outside the placement policy                               |

Do not reduce all six rows to “HDFS acknowledged the write.” For a write-ahead log, the application may need `hsync()` and must measure the current pipeline replication. For a large rebuildable intermediate file, close plus asynchronous repair may be the right boundary. The caller chooses based on the loss contract.

## File, object, and block storage expose different contracts

A shared filesystem exposes directories and file operations through a mounted namespace. Object storage exposes whole objects under bucket and object names through an API. Block storage exposes addressable blocks to one or more hosts under attachment rules; a filesystem or database usually sits above it.

Suppose an application stores three things:

| State                                             | Natural starting point                   | Reason                                                                                                     |
| ------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| User-uploaded 600 MiB video                       | Object storage                           | Whole-object API, independent durability, range reads, lifecycle policy, no need for shared POSIX mutation |
| PostgreSQL data directory                         | Attached block volume                    | Database owns page format, write ordering, cache, and recovery                                             |
| Shared build tree used through ordinary file APIs | Managed NFS or another shared filesystem | Directory, permissions, rename, and mounted access matter                                                  |

Amazon S3 currently provides strong read-after-write behavior for successful object PUT and DELETE operations, including overwrite and list behavior documented by S3. It still is not a POSIX filesystem: object replacement is an API operation, directories are name prefixes, and applications should not assume file locks or in-place page writes. Amazon EBS provides block volumes in an Availability Zone; EBS replication below the volume does not remove the database's need for transactions, backups, and tested restore.

Replication is not backup. A mistaken delete or corrupt write can replicate perfectly. Keep versioned or immutable recovery copies under separate credentials and test restoration against a stated recovery point.

## Distributed shared memory turns page faults into messages

Distributed shared memory (DSM) gives processes on different machines the illusion of shared virtual-memory pages. Each process caches pages. A local access hits that cache; a missing page triggers a fault handler that asks the DSM protocol for data and permission.

The lecture uses a simple invalidate protocol with read and write states. Several processes may hold read copies, but only one owner may hold a writable copy. Work two cases:

**Read miss while P4 has write ownership.** P1 requests the page. P4 cannot merely send bytes and remain the sole writable owner; it must finish or order its writes, downgrade to a shared read state, and provide the current data. P1 installs a read copy. Both can now read.

**Write while P1, P3, and P4 hold read copies.** P1 requests exclusive ownership. The protocol invalidates P3 and P4, waits for the required acknowledgments, advances an ownership version or epoch, then lets P1 write. The crossed-out copies on lecture pages 20, 22, and 24 are important; plain text extraction makes them look as if they remain valid.

A real protocol needs more than those pictures. Simultaneous writers require one serialized ownership decision. A directory or home node tracks sharers instead of broadcasting every miss. Messages need epochs and request IDs. A writer normally waits for invalidation evidence before exposing a conflicting change. Recovery must handle a holder that paused, lost its lease, and later resumed.

**False sharing** occurs when unrelated variables occupy one coherence unit. If P1 updates `x` and P2 updates `y` on the same 4 KiB page, each write can invalidate the other's page even though the program shares no logical variable. Smaller units reduce false sharing but increase metadata and transfer count. Update protocols send new values to sharers instead of invalidating them; they help some frequently shared read patterns but waste bandwidth when most holders do not need every change.

DSM remains a useful way to connect virtual memory, cache coherence, and distributed consistency. It is not the ordinary application model for datacenter services, where explicit storage and messages make ownership and failure easier to see.

## RDMA removes CPU work from a path, not the protocol

Remote direct memory access (RDMA) lets a network adapter move data between registered memory regions with less remote CPU involvement. One-sided reads and writes can avoid an application-level handler for each transfer; send and receive operations still support message-style exchange.

RDMA does not automatically make remote memory act like a coherent local cache. The application must manage registered memory, permissions, queue pairs, completion, buffer lifetime, concurrency, and transport errors. It also needs a rule for visibility to remote CPUs and devices. A completed network write does not, by itself, prove that a storage device made the data durable. Ordering and persistence depend on the chosen verbs, hardware, memory placement, and higher-level protocol.

Keep RDMA distinct from CXL-style coherent memory fabrics. Both can support memory disaggregation, but they expose different reach, coherence, failure, and software assumptions. Neither makes a rack or region one failure-free machine.

## An edge node has a power budget before it has a software stack

A sensor node combines one or more sensors, a processor, memory, a communication link, and a power source. I²C and SPI connect components inside a device; they are not wide-area network protocols. BLE, IEEE 802.15.4/Thread, Wi-Fi, and LoRaWAN solve different range, bitrate, topology, and energy problems. CoAP and MQTT sit higher in the stack and define application exchange patterns.

TinyOS and NesC are useful historical examples of event-driven software built for kilobytes of memory and bursty hardware events. Current embedded systems may use Zephyr, FreeRTOS, RIOT, Contiki-NG, or vendor runtimes. Raspberry Pi is a board family capable of running Linux distributions, while modern Arduino-class boards may run an RTOS and several tasks. “Arduino runs one process” is not a safe current rule.

Power determines what the node can do. Two AA cells in series might provide roughly 2,000 mAh at their rated conditions; series raises voltage but does not double amp-hours. Ignoring regulator loss, temperature, aging, and self-discharge, a one-year average-current budget is:

```text
2,000 mAh / (365 * 24 h) = 228 microamps average
```

Assume a radio draws 12 mA while transmitting and transmits 1 percent of the time. Its average is `12 mA * 0.01 = 120 microamps`, already more than half the ideal budget. Suppose sleep current is 8 microamps, sensing and CPU average 35 microamps, and receive/listen time averages 25 microamps. The planned total is 188 microamps, leaving only 40 microamps for retransmissions, cold weather, regulator loss, battery variation, and aging. That margin is too small without measurement.

Change the design before buying batteries: sample less often, batch readings, shorten radio-on time, use event-triggered reporting, aggregate nearby measurements, or provide a larger energy source. “Compute rather than transmit” is only a starting hypothesis because an expensive model, flash write, or always-listening receiver can reverse the comparison.

## Follow one reading to the cloud and back

Suppose a soil sensor samples every minute but uploads every fifteen minutes.

1. A hardware timer wakes the MCU, which reads the sensor over I²C.
2. The device validates range and stores a timestamped record in a bounded local log.
3. Every fifteenth sample, it opens or reuses a radio session and sends a batch with device identity and sequence numbers.
4. A gateway authenticates the device, deduplicates records, and forwards them to a retained cloud stream.
5. Stream processing calculates event-time windows. A delayed batch keeps original sample timestamps rather than gateway arrival time.
6. Storage retains raw readings and derived summaries under different lifecycle rules.
7. A control service sends a signed configuration update through the gateway. The device verifies version, authorization, signature, and rollback policy before applying it.

The device must tolerate an offline gateway, duplicate upload, partial batch acknowledgment, clock drift, full local storage, and power loss during an update. Fleet security adds unique device identity, restricted interfaces, protected credentials, secure boot, signed software updates, key rotation, inventory, vulnerability response, and a supported end-of-life path. Physical capture belongs in the threat model.

In-network aggregation can reduce traffic by sending `(sum, count)` up a tree instead of every temperature reading. Failure complicates it: duplicate child reports can inflate a sum, a missing child changes coverage, and a parent loss requires rerouting. Carry interval, contributor identity or count, and deduplication information so the root can tell a real average from a partial one.

## Inspect the abstraction beneath the symptom

For a distributed file complaint, collect path resolution, mount, stable file handle, client cache status, validation or delegation state, server identity, operation ID, byte range, write acknowledgment point, and backing-storage evidence. “The file was stale” is incomplete until the reader's permitted cache rule and the writer's completed boundary are known.

For DSM or RDMA, inspect page or region owner, epoch, sharer set, invalidation acknowledgments, queue-pair state, completion status, and remote CPU visibility. A process holding old bytes is different from one still allowed to write.

For edge fleets, graph battery voltage, radio-on time, retries, wake causes, queue depth, clock offset, firmware version, update result, gateway availability, and oldest unsent event time by hardware revision. A device may look healthy while silently spending its remaining battery on a retry loop.

## Summary

Filesystems, shared memory, and edge runtimes hide network exchange behind familiar operations. That convenience is safe only when the application understands the identity, cache, write, failure, and recovery contract below it.

- **Local file semantics come first.** Metadata type differs from a filename extension; links, open references, offsets, partial I/O, and stable object identity affect remote behavior.
- **Current NFSv4 is stateful.** Early NFS explains stable handles and retryable offsets, while NFSv4 adds open state, locking, delegations, state IDs, and recovery.
- **Caching chooses a stale-read and invalidation rule.** Polling, freshness intervals, callbacks, and delegations cut communication in different ways; none provides free consistency.
- **Storage interfaces are not interchangeable.** Shared filesystems expose mounted file operations, object stores expose object APIs, and block volumes sit below a filesystem or database.
- **GFS and HDFS separate metadata from bulk transfer.** NameNode or master authority, worker-held blocks, placement, locality, replication, and erasure coding create distinct failure and cost paths.
- **An HDFS write has several completion boundaries.** The NameNode allocates metadata and a DataNode pipeline; packets and checksums travel down the chain while acknowledgements return upstream. Pipeline recovery replays unacknowledged packets, and block reports drive later replication repair. Packet acknowledgement, EditLog durability, `hflush()`, `hsync()`, file completion, and final target replication do not mean the same thing.
- **DSM needs a coherence protocol.** Ownership, invalidations, acknowledgments, epochs, directory state, and false sharing remain even when code appears to load and store ordinary memory.
- **RDMA moves bytes without inventing coherence or durability.** Registration, permissions, completion, ordering, remote visibility, and recovery still belong to a higher-level protocol.
- **Edge design starts with joules and offline behavior.** A one-year two-AA budget is only about 228 microamps average under ideal assumptions; radio duty cycle, retries, updates, and cold batteries quickly consume it.

## References

- [CS 425 Fall 2025 L4: MapReduce, Hadoop, and HDFS locality](https://courses.grainger.illinois.edu/cs425/fa2025/L4.FA25.pdf)
- [CS 425 Fall 2025 L24A: distributed file systems](https://courses.grainger.illinois.edu/cs425/fa2025/L24.A.FA25.pdf)
- [CS 425 Fall 2025 L24B: consistency models](https://courses.grainger.illinois.edu/cs425/fa2025/L24.B.FA25.pdf)
- [CS 425 Fall 2025 L25A: distributed shared memory](https://courses.grainger.illinois.edu/cs425/fa2025/L25.A.FA25.pdf)
- [CS 425 Fall 2025 L25B: sensors and sensor networks](https://courses.grainger.illinois.edu/cs425/fa2025/L25.B.FA25.pdf)
- [RFC 8881: Network File System version 4.1](https://www.rfc-editor.org/rfc/rfc8881.html)
- [RFC 9754: extensions for opening and delegating files in NFSv4.2](https://www.rfc-editor.org/rfc/rfc9754.html)
- [Howard et al.: Scale and Performance in a Distributed File System](https://www.cs.cmu.edu/~15712/papers/howard88.pdf)
- [Google: The Google File System](https://research.google/pubs/the-google-file-system/)
- [Apache Hadoop: HDFS Users Guide](https://hadoop.apache.org/docs/current3/hadoop-project-dist/hadoop-hdfs/HdfsUserGuide.html)
- [Apache Hadoop 3.5: HDFS Architecture](https://hadoop.apache.org/docs/current/hadoop-project-dist/hadoop-hdfs/HdfsDesign.html): Documents NameNode and DataNode roles, EditLog metadata, placement, the replicated write pipeline, heartbeats, block reports, checksums, and re-replication.
- [Apache Hadoop 3.5 API: `Syncable`](https://hadoop.apache.org/docs/current/api/org/apache/hadoop/fs/Syncable.html): Defines the visibility boundary of `hflush()` and the disk-device boundary of `hsync()`.
- [Apache Hadoop 3.5 API: `HdfsDataOutputStream`](https://hadoop.apache.org/docs/current/api/org/apache/hadoop/hdfs/client/HdfsDataOutputStream.html): Documents current-block replication after pipeline failure and the stream's sync operation.
- [Apache Hadoop 3.5 source: `DataStreamer`](https://github.com/apache/hadoop/blob/rel/release-3.5.0/hadoop-hdfs-project/hadoop-hdfs-client/src/main/java/org/apache/hadoop/hdfs/DataStreamer.java): Shows packet sequence and acknowledgement queues plus pipeline reconstruction and replay after a DataNode error.
- [Apache Hadoop: HDFS erasure coding](https://hadoop.apache.org/docs/stable/hadoop-project-dist/hadoop-hdfs/HDFSErasureCoding.html)
- [Amazon S3: data consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)
- [Amazon EBS: block storage concepts](https://docs.aws.amazon.com/ebs/latest/userguide/what-is-ebs.html)
- [Linux kernel documentation: userspace RDMA access](https://docs.kernel.org/infiniband/user_verbs.html)
- [RFC 7252: The Constrained Application Protocol](https://www.rfc-editor.org/rfc/rfc7252.html)
- [OASIS: MQTT version 5.0 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html)
- [NIST IR 8259A: IoT Device Cybersecurity Capability Core Baseline](https://csrc.nist.gov/pubs/ir/8259/a/final)

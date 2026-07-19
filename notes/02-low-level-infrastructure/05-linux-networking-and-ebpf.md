---
title: Linux networking, Netfilter, and eBPF
shortTitle: Packet path
description: Walk a packet through namespaces, virtual links, routing, connection tracking, filtering, and application-layer proxies.
collection: low-level-infrastructure
slug: linux-networking-and-ebpf
order: 5
number: LL5
duration: 180 min
difficulty: Core
tags:
  - network namespaces
  - nftables
  - iptables
  - eBPF
---

## Working model

A packet never travels through a generic networking box. It crosses named hooks and routing decisions inside one or more network namespaces; each data-plane implementation chooses which of those points to program.

## Questions this note answers

- Trace a client request through the Domain Name System (DNS), a socket, Transmission Control Protocol (TCP) or QUIC, Transport Layer Security (TLS), Internet Protocol (IP) routing, and a link
- Follow TCP setup, sequence and acknowledgment state, retransmission, flow control, congestion control, and close
- Diagnose listener queues, ephemeral-port or Network Address Translation (NAT) exhaustion, and a Path Maximum Transmission Unit (MTU) Discovery black hole from read-only evidence
- Connect network namespaces with virtual Ethernet (veth) pairs, bridges, and routes
- Place Netfilter hooks and conntrack beneath nftables, legacy xtables, or the nf_tables iptables compatibility path
- Distinguish transport-layer (Layer 4) connection handling from application-layer (Layer 7) protocol-aware routing
- Trace an extended Berkeley Packet Filter (eBPF) object through loading, Compile Once Run Everywhere (CO-RE) relocation, verification, map creation, and attachment

## Start at the application socket

A networked application sends through a **socket**, the kernel interface between a process and a network protocol. An Internet endpoint combines an Internet Protocol (IP) address with a transport port. The IP address gets packets to a network interface; the Transmission Control Protocol (TCP) or User Datagram Protocol (UDP) port lets the destination kernel choose the receiving socket. A server usually binds a local address and port, listens, then accepts connections. A client usually receives a temporary local port when it connects.

A hostname is not an address. The Domain Name System (DNS) maps a name such as `api.example.com` to records that can contain IP version 4 (IPv4) or IP version 6 (IPv6) addresses. The client chooses an answer and transport, then asks its kernel to connect. Caches and time-to-live (TTL) values mean two clients can receive different valid answers during a change.

Keep four protocol layers separate:

| Layer                  | Job                                                                | Example                                                                      |
| ---------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Application            | Defines request and response meaning                               | Hypertext Transfer Protocol (HTTP), DNS                                      |
| Security and transport | Protects application data and carries it between process endpoints | Transport Layer Security (TLS) over TCP; QUIC includes TLS and runs over UDP |
| Network                | Carries packets across routed IP networks                          | IPv4, IPv6                                                                   |
| Link                   | Carries frames across one local link                               | Ethernet, Wi-Fi, a virtual Ethernet pair                                     |

TCP supplies a reliable ordered byte stream and retransmits lost data; it does not preserve application message boundaries. UDP sends separate datagrams without TCP's delivery and ordering contract. QUIC builds reliable encrypted connections and streams over UDP. HTTP/1.1 and HTTP/2 commonly use TLS over TCP for HTTPS, while HTTP/3 uses QUIC.

As bytes move down the stack, each layer adds headers. A TCP segment or UDP datagram sits inside an IP packet, which sits inside a link-layer frame for the next local hop. Routers remove the incoming link frame and create another for the next link; the IP packet continues toward its destination unless routing or policy changes it.

## A route chooses the next hop

An IP prefix such as `10.20.4.0/24` describes a range. A route table maps destination prefixes to an outgoing interface and possibly a next-hop router. The most specific matching prefix wins; a default route covers destinations with no more specific entry. If the destination is on the local link, IPv4 ARP or IPv6 Neighbor Discovery resolves the next-hop IP address to link-layer delivery information. Otherwise the machine resolves and sends to its router.

Now trace an HTTPS request over TCP:

1. DNS returns an address.
2. The client route table chooses an interface and next hop.
3. Address Resolution Protocol (ARP) for IPv4 or Neighbor Discovery for IPv6 finds link delivery for that next hop.
4. TCP exchanges a packet with the synchronize (SYN) flag, a reply with both SYN and acknowledgement (ACK), then an ACK to establish connection state.
5. TLS authenticates the server name and negotiates protected keys.
6. The connection request reaches the listening socket. After acceptance, the client sends HTTP bytes to that connection's socket queue, and the server thread must run and read them.

Every stage can fail independently. A successful DNS answer does not prove a route. A completed TCP handshake does not prove certificate acceptance. Valid TLS does not prove the application will answer before its deadline.

```text
process -> socket -> TCP or QUIC -> IP route -> local frame -> router(s)
  -> destination frame -> IP -> transport socket queue -> server process
```

## Trace one TCP connection before tracing namespaces

Suppose `10.0.0.7` opens an HTTPS connection from local port `49152` to `203.0.113.20:443`. Within TCP, the source address, source port, destination address, and destination port form the **four-tuple** that identifies the connection. If several transport protocols share the same table, add the protocol name to form a five-tuple. Client and server each keep their own TCP state for that connection.

### The handshake creates state before `accept` returns

The three-way handshake synchronizes both directions:

1. The client sends `SYN`, chooses initial sequence number `x`, and can advertise options such as Maximum Segment Size (MSS), window scaling, and Selective Acknowledgment (SACK).
2. The server stores an incomplete request and replies `SYN-ACK` with its own sequence number `y` and acknowledgment `x + 1`. A SYN consumes one sequence number even though it carries no application byte.
3. The client replies with `ACK y + 1`. The connection is established, and Linux can place it on the listener's queue of completed connections until the server calls `accept()` and receives a new connected socket.

Linux maintains distinct pressure points for incomplete and completed connections. The SYN backlog contains requests in `SYN_RECV` that have not finished the handshake; `tcp_max_syn_backlog` bounds remembered requests per listener when SYN cookies do not replace that state. The `listen(backlog)` value controls completely established sockets waiting for `accept()`, capped by `net.core.somaxconn`. A server can therefore complete handshakes while an application thread stalls and lets the accept queue fill. Raising a queue hides a short burst; it does not make a slow handler accept faster.

### Sequence numbers order bytes; acknowledgments move the edge

TCP numbers bytes, not packets. If a segment begins at sequence 1,001 and carries 500 bytes, the next contiguous byte is 1,501. A cumulative `ACK 1501` says the receiver's TCP stack has accepted every byte before 1,501 in order. It does not say that the server process has read, committed, or acted on those bytes.

Packets can arrive out of order or twice. The receiver keeps the next expected sequence number, may report later blocks with SACK, and presents an ordered byte stream to the application. The sender retains unacknowledged bytes for possible retransmission. A retransmission timeout derived from measured round-trip time (RTT), or earlier loss evidence such as duplicate acknowledgments, can cause the sender to transmit missing bytes again. Application protocols still need operation IDs for uncertain outcomes: a lost connection after an acknowledged request does not tell the client whether the server committed the request.

Loss and delay leave different evidence. Rising RTT can mean packets are waiting in a queue even before loss occurs. Repeated sequence ranges and an increasing retransmission counter show that the sender did not receive timely acknowledgment, but they do not locate the drop. Capture both ends or combine a capture with interface and socket counters before blaming the remote host.

### The receiver window and congestion window protect different things

The receiver advertises a **receiver window** (`rwnd`) based on buffer space and how quickly its application reads. This prevents a fast sender from overrunning the destination. The sender maintains a **congestion window** (`cwnd`) based on its congestion-control algorithm and path feedback; this limits pressure on the network. The amount of unacknowledged data in flight cannot exceed `min(rwnd, cwnd)`.

RTT determines how quickly acknowledgments free that in-flight allowance. A 1 gigabit-per-second path with a 40 millisecond RTT has a bandwidth-delay product (BDP) of `1,000,000,000 × 0.040 / 8 = 5,000,000` bytes, about 4.77 MiB. Keeping that path full requires roughly 5 MB in flight. If either window is only 1 MB, the rough ceiling is `1 MB / 0.040 s = 25 MB/s`, or 200 megabits per second, before protocol overhead. More bandwidth alone will not lift that ceiling.

Loss, Explicit Congestion Notification (ECN), and ACK timing feed congestion control according to the selected algorithm. A full receive buffer instead shrinks `rwnd`, possibly to zero, until the application reads. Both conditions can stop new sends, but only one points to a slow receiver application.

### Ephemeral ports and `TIME_WAIT` keep old connections distinct

The client usually lets Linux choose an **ephemeral port** from its configured local range. That port need not be globally unique: the whole four-tuple must be unique. Connections from one local port to different destination endpoints may coexist when the operating system's rules permit it, while simultaneous connections to the same destination need distinguishable local tuples.

The endpoint that actively closes a connection usually enters `TIME_WAIT`. It retains enough tuple state to handle a delayed duplicate and retransmit the final ACK if the peer repeats its FIN. `TIME_WAIT` is therefore protocol correctness state, not a leaked application socket. High churn to one destination can consume usable ephemeral tuples even after application file descriptors close. Inspect the tuple distribution and reuse policy before changing TIME-WAIT settings.

Network Address Translation (NAT) creates another finite port space. A source NAT gateway replaces the internal source address and often the source port with a public mapping, then reverses that mapping for replies. Imagine one public address has a policy-usable pool of 20,000 TCP source ports and each internal client holds 40 simultaneous connections to the same external endpoint. Ignoring other traffic and retained mappings, the hard arithmetic ceiling is `20,000 / 40 = 500` clients. Real capacity is lower because some ports are reserved, in use, or retained for connection state. Port exhaustion makes new connections fail while existing flows can continue; connection reuse, protocol multiplexing, more public addresses, or a larger verified pool address the actual constraint.

### A smaller path MTU can break only the large packets

The **Maximum Transmission Unit** (MTU) is the largest IP packet a link can carry without fragmentation at that link. The **path MTU** is the smallest link MTU along one route. TCP's MSS limits TCP payload and leaves room for IP and TCP headers; tunnels and options can reduce the safe payload further.

Classical **Path MTU Discovery** (PMTUD) learns this limit from the network. With Internet Protocol version 4 (IPv4), a sender can set the Don't Fragment (DF) bit. A router that cannot forward the packet on a smaller link drops it and returns an Internet Control Message Protocol (ICMP) Destination Unreachable message whose code says fragmentation is needed. The sender lowers its assumed path MTU and retransmits smaller segments. IPv4 packets without DF may instead be fragmented, but fragmentation adds loss and reassembly costs. Internet Protocol version 6 (IPv6) routers do not fragment forwarded packets; they return an ICMPv6 Packet Too Big message and the source adjusts.

A PMTUD **black hole** appears when the oversized packet is dropped and the ICMP error never reaches the sender, often because a firewall treats all ICMP as disposable. The small SYN, SYN-ACK, ACK, and perhaps a short request cross successfully. A larger TLS or application record then disappears, the sender retransmits the same sequence range, and the connection stalls. A successful ping or TCP handshake does not disprove this failure. Packetization-layer probing can recover in some stacks, but the network fix is to carry the required ICMP errors and account for tunnel overhead.

### Gather read-only evidence before changing the stack

Run these commands in the network namespace that owns the socket. They do not intentionally change network state, although packet capture usually needs elevated capability and can expose credentials or user data. Bound the packet count and filter tightly.

| Evidence                               | Read-only command                                                                 | What it proves                                                                                                   | What it does not prove                                                                                   |
| -------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Listener and completed queue           | `ss -lnt`                                                                         | A local address is listening; queue columns show current and configured listener pressure                        | That a SYN reached this namespace or the application accepts promptly                                    |
| One TCP's transport state              | `ss -tin dst 203.0.113.20`                                                        | Four-tuples plus available RTT, retransmission timeout, MSS, path MTU, windows, congestion algorithm, and `cwnd` | Where a packet was dropped or whether the application committed work                                     |
| Handshake and close states             | `ss -tan state syn-recv`; `ss -tan state time-wait`                               | Current incomplete requests and retained TIME-WAIT tuples                                                        | Historical peaks without sampled or exported counters                                                    |
| Selected route                         | `ip route get 203.0.113.20 from 10.0.0.7`                                         | The route lookup's chosen source, next hop, and interface for those inputs                                       | Delivery, neighbor success, firewall acceptance, or the return route                                     |
| Local link                             | `ip -s link show dev eth0`                                                        | Configured interface MTU and local packet, byte, error, and drop counters                                        | The minimum MTU or loss point across the complete path                                                   |
| Packets at one observation point       | `tcpdump -ni eth0 -c 100 'host 203.0.113.20 and (tcp port 443 or icmp or icmp6)'` | Visible flags, sequence and ACK progress, repeated ranges, and returned ICMP errors                              | Packets dropped before capture, another namespace's path, or exact wire segmentation when offloads apply |
| Host-wide socket and protocol pressure | `ss -s`; `cat /proc/net/sockstat`; `nstat -az`                                    | Counts of socket states, memory pressure, retransmissions, and protocol errors available on this host            | Which individual flow caused a global counter to move                                                    |
| Local ephemeral-port policy            | `cat /proc/sys/net/ipv4/ip_local_port_range`                                      | The configured automatic IPv4 port-selection interval in this namespace                                          | NAT's public pool, current occupancy, or safe tuple reuse                                                |

## A network namespace owns a network view

A network namespace has its own devices, addresses, routes, port space, firewall state, and many protocol settings. A veth pair acts like a cable with two software endpoints; sending into one delivers the packet to the peer, which may live in another namespace.

Bridges switch frames among attached interfaces, while routing selects a next hop between networks. Container networking often combines veth, a host bridge or routed interface, and namespace-specific routes, though a CNI plugin may choose another data path.

_Names vary by runtime. Resolve actual interfaces and routes before assuming this shape._

```text
[namespace A: eth0] <-> [veth-host] -> route/bridge -> [veth-peer] <-> [namespace B: eth0]
```

## The NIC, CPU, and socket each have a queue

On receive, a physical network interface controller (NIC) commonly uses direct memory access (DMA) to place frames into a receive ring. Linux's NAPI event mechanism lets the driver process a bounded batch, and the networking stack turns packets into kernel socket-buffer state before protocol processing queues data to a socket. Receive Side Scaling (RSS) can choose a hardware receive queue and CPU; Receive Packet Steering (RPS) can redirect later protocol work in software. The application still waits until its thread runs and reads the socket.

Transmit has its own queueing. A successful `send` may only mean that the kernel accepted bytes into socket memory. TCP, queueing disciplines (qdiscs), pacing, neighbor resolution, driver rings, and the NIC can delay later transmission. Backpressure can appear as a short write, EAGAIN, a blocking call, or growing socket memory depending on the API and configuration.

Generic Receive Offload (GRO) can combine received packets for stack processing, while Generic Segmentation Offload (GSO) or TCP Segmentation Offload (TSO) can defer segmentation of a large buffer. Checksum offload can leave capture-visible checksums apparently unfinished before hardware fills them. Packet counts, sizes, and checksums observed on the host therefore need the interface and offload settings that produced them.

[Linux kernel: scaling in the networking stack](https://docs.kernel.org/networking/scaling.html)

## One SYN can cross two routing and policy domains

The hook names in the next path are Linux terms. eXpress Data Path (XDP) can run before the kernel creates its ordinary packet buffer. Traffic control (`tc`) provides later interface hooks. Netfilter exposes hooks before and after routing. Connection tracking, shortened to conntrack, remembers flow state; network address translation (NAT) can rewrite addresses or ports. Destination NAT (DNAT) changes the destination before the next route lookup.

`PREROUTING` runs before the main route decision. `INPUT` handles packets delivered to the local host, `FORWARD` handles packets routed through it, `OUTPUT` handles locally generated packets, and `POSTROUTING` runs after the outbound route decision. nftables chain names can differ, so the actual hook and priority matter more than a familiar label.

Consider a SYN that enters a host NIC and targets a service address behind a veth. A native XDP program, if attached, can act before the driver builds the ordinary skb seen by later hooks. Traffic control ingress and Netfilter then get their configured opportunities. DNAT in PREROUTING can change the destination before the host routing decision selects forwarding toward the host-side veth.

A forwarded packet crosses the host's FORWARD and later POSTROUTING path, enters the veth, and appears as ingress on the peer inside the service namespace. That namespace runs its own policy and route lookup before local delivery reaches the listening socket. Conntrack and NAT state belong to the namespace that created them. Replies must find a valid reverse route and the matching translation state; seeing the SYN at the host interface proves only the first segment.

_The exact hooks depend on packet direction, attachment points, and whether a local proxy terminates the first connection._

```text
host NIC -> optional XDP -> tc ingress -> PREROUTING/conntrack
  -> route -> FORWARD -> POSTROUTING -> host veth
  -> peer ingress in service netns -> PREROUTING -> route -> INPUT -> socket
```

### A proxy creates a second transport path

If the host accepts the client connection in a local proxy, the first packet follows local-delivery hooks. The proxy's upstream socket then creates a separate OUTPUT path with its own source address, conntrack entry, timeout, and failure state.

## Netfilter supplies hooks; rules systems program them

Netfilter exposes hook points around ingress, routing, local delivery, forwarding, and egress. Connection tracking records flow state used by stateful filtering and NAT. nftables is the current rules framework and user-space interface for new deployments; iptables remains common and may use compatibility layers.

The iptables command name does not identify its kernel backend. iptables-legacy uses the older xtables interface, while iptables-nft accepts familiar syntax and programs nf_tables through a compatibility layer. `iptables -V` reports the selected backend, and the executable symlink or distribution alternatives setting shows which frontend runs. `iptables-save` and `nft list ruleset` may then expose overlapping views of one nf_tables ruleset.

Calling iptables the kernel firewall hides the frontend, backend, table, chain type, hook priority, conntrack state, and network namespace that decide a packet's path. Translation tools help with migration, but extensions do not all map one-for-one; compare the rendered rules and test traffic before removing the old path.

> **Debug in the right namespace.** A correct host rule can coexist with a conflicting rule or route inside another namespace. Inspect both ends of the veth pair.

### Inspect the backend before editing a rule

Record `iptables -V`, resolve the iptables executable, capture `iptables-save`, and capture `nft list ruleset` in the same namespace. If the version names nf_tables, do not count iptables-nft and native nft output as two independent firewalls.

[Linux man-pages: xtables-nft(8)](https://www.man7.org/linux/man-pages/man8/xtables-nft.8.html)

### Hook priority can beat a familiar chain name

Native nftables base chains declare a hook and priority. List the complete ruleset and follow the registered hook order; a rule in a differently named chain can run before the chain an incident note calls primary.

[nftables wiki: Netfilter hooks](https://wiki.nftables.org/wiki-nftables/index.php/Netfilter_hooks)

## L4 and L7 balancing inspect different information

An L4 balancer chooses with transport information such as addresses, ports, and connection state. An L7 proxy parses an application protocol such as HTTP, so it can route by host, path, header, or method while paying parsing and proxying costs.

An L4 design can preserve one transport connection and often keep the original payload opaque, but it cannot route on an encrypted HTTP path it never decrypts. An L7 proxy terminates the downstream protocol state, applies timeouts and retry rules, then opens or reuses upstream connections. A successful downstream handshake therefore does not prove that an upstream connection, TLS policy, or backend request succeeded.

Health checks also observe the layer they exercise. A TCP connect can prove that a port accepted a handshake while the HTTP handler returns errors; an HTTP check can pass while a specific tenant route fails. Match the check's namespace, address family, protocol, host header, and credentials to the failure under study.

## An eBPF loader builds kernel objects before anything runs

Extended Berkeley Packet Filter (eBPF) lets an authorized user-space loader submit restricted programs that the kernel verifies and attaches to supported hooks. Networking programs can inspect, count, redirect, or reject traffic at points such as XDP, traffic control, sockets, and cgroups. Other eBPF program types observe tracing or security hooks. Maps hold shared state between programs or user space.

The appeal is placement: a small program can filter or aggregate near an event instead of copying every event to a daemon. That placement also makes permissions, verifier behavior, attachment identity, runtime cost, and cleanup part of the operating contract.

A typical libbpf loader reads an Executable and Linkable Format (ELF) object, creates maps, resolves externals, and applies Compile Once Run Everywhere (CO-RE) relocations. CO-RE compares the object's BPF Type Format (BTF) information with BTF from the target kernel so field offsets can change without rebuilding the source. It does not make a missing helper, map type, hook, or kernel feature appear; probe those separately.

The loader calls the bpf syscall to create maps and submit each program. The verifier explores reachable control flow, tracks register and pointer types, checks helper contracts and bounded resource use, then returns a program file descriptor if the load succeeds. Passing verification proves those kernel checks for that program type, not the intended packet policy.

Attachment is a separate step. XDP, traffic control, cgroup, socket, and tracing programs use hook-specific attachment APIs; where supported, a bpf_link gives that attachment an explicit lifetime. Maps exchange state with user space, but key/value layout, synchronization, pinning, and cleanup remain application contracts.

Load permission is another boundary. Kernel version, `unprivileged_bpf_disabled`, lockdown, LSM policy, program type, and capabilities such as CAP_BPF, CAP_PERFMON, or CAP_NET_ADMIN can all affect the result. A verifier rejection and a permission rejection need different fixes.

_Loading, verification, attachment, and state ownership fail at different boundaries._

```text
ELF + BTF -> libbpf loader -> CO-RE relocations -> map creation
          -> verifier -> program fd -> hook-specific attach / bpf_link
          -> map reads and updates <-> user space
```

### Test supported program types before attachment

BPF_PROG_RUN can execute supported program types against a controlled context and buffer, returning the program result and output without attaching the program to the production hook. Keep fixture tests alongside the object, then test the actual attachment path in an isolated network namespace.

[Linux kernel: running BPF programs from user space](https://docs.kernel.org/bpf/bpf_prog_run.html)

### CO-RE solves layout drift, not behavioral drift

A relocation can find the target kernel's field offset while a helper, attach type, verifier rule, or semantic assumption still differs. Record the kernel BTF identity and feature probe with each test result.

[Linux kernel: libbpf overview](https://docs.kernel.org/bpf/libbpf/libbpf_overview.html)

## Prove the last point that saw the packet

Start with the packet tuple and the network namespace at each hop. Record interface counters, addresses, route lookup, neighbor state, conntrack entry, ruleset generation, listening sockets, and attached BPF links from that namespace. `ip route get` tests one lookup with stated inputs; it does not send a packet or prove that policy before and after routing will accept it.

Capture on both veth endpoints with synchronized clocks, then use rule counters or narrowly enable nftables tracing in a disposable namespace to identify the matching chain. `tc -s` and `bpftool net show` expose other attachment points. XDP can drop a packet before a normal packet capture sees an skb, and hardware-offloaded policy can run before host software, so pair captures with driver, hardware, XDP, and tc counters. A capture on `any` can show the same packet more than once as it crosses software interfaces.

_Use a disposable namespace for active tests. Ruleset tracing and BPF inspection may require elevated access._

```shell
nsenter -t PID -n ip -s link
nsenter -t PID -n ip route get DEST from SOURCE
nsenter -t PID -n ss -lntp
nsenter -t PID -n nft list ruleset
nsenter -t PID -n nft monitor trace
bpftool net show
bpftool link show
tc -s filter show dev IFACE ingress
```

### Keep BPF identity with its map state

Record program ID, tag, attach point, link ID, loaded object metadata, pinned maps, and map schema. Reusing a pinned map with a changed key or value layout can corrupt policy even when the new program loads and attaches.

[Linux kernel: BPF program types and ELF sections](https://docs.kernel.org/bpf/libbpf/program_types.html)

## Summary

A Linux packet path is a sequence of namespace-local devices, routes, hooks, state tables, and sockets. The most reliable network diagnosis states the tuple and namespace at every hop, then finds the last boundary that observed or transformed the packet.

- A network namespace owns devices, addresses, routes, port space, firewall state, and protocol settings. A veth pair carries a packet between two such views.
- A socket binds process I/O to a transport endpoint. DNS supplies candidate IP addresses; routing chooses a next hop; TCP's three-way handshake creates two sequence spaces and a completed listener-queue entry; TLS protects the application exchange; HTTP supplies request meaning.
- TCP is an ordered byte stream whose sender retransmits unacknowledged ranges and limits in-flight data by the smaller of `rwnd` and `cwnd`. Ephemeral ports, four-tuples, `TIME_WAIT`, and NAT mappings keep concurrent and delayed traffic distinct; UDP carries datagrams without the same delivery contract, while QUIC builds encrypted connections over UDP.
- Path MTU Discovery depends on IPv4 fragmentation-needed or IPv6 Packet Too Big errors. Blocking those ICMP messages can leave a connection whose handshake works but larger transfers repeatedly stall.
- Receive work can cross NIC rings, NAPI, RSS or RPS, protocol processing, socket queues, and application scheduling. GRO, GSO, TSO, and checksum offload can make a host capture differ from physical wire packets.
- A forwarded request can cross host XDP or traffic control, Netfilter and conntrack, routing, veth, then a second namespace's policy and local-delivery path.
- A local proxy terminates the first transport connection and creates a second outbound path with its own source address, timeout, conntrack entry, TLS state, and failure.
- Netfilter supplies hooks; nftables or an iptables frontend programs them. Identify whether iptables uses legacy xtables or the nf_tables compatibility backend before interpreting duplicate-looking rules.
- L4 balancing uses transport metadata; L7 balancing parses application protocol and can route by HTTP fields. Health evidence is only as strong as the layer and request shape it tests.
- Loading eBPF requires object parsing, CO-RE relocation, map creation, verification, and hook-specific attachment. CO-RE handles type-layout drift, not missing helpers, hooks, or changed behavior.
- Record `ss` transport state, listener and TIME-WAIT counts, interface and rule counters, route and neighbor state, conntrack, BPF links, and bounded captures on both veth ends. A route lookup does not send a packet, global counters do not identify one flow, and XDP or hardware can drop before an ordinary capture sees it.

## References

- [Linux man-pages: network_namespaces(7)](https://www.man7.org/linux/man-pages/man7/network_namespaces.7.html)
- [Linux man-pages: socket(7)](https://man7.org/linux/man-pages/man7/socket.7.html)
- [Linux man-pages: ip(7)](https://man7.org/linux/man-pages/man7/ip.7.html)
- [Transmission Control Protocol, RFC 9293](https://www.rfc-editor.org/rfc/rfc9293.html)
- [TCP Congestion Control, RFC 5681](https://www.rfc-editor.org/rfc/rfc5681.html): Defines the receiver window, congestion window, flight size, and loss response used in the worked path.
- [Linux man-pages: listen(2)](https://man7.org/linux/man-pages/man2/listen.2.html): Separates the completed accept queue from incomplete TCP requests on current Linux.
- [Linux kernel: IP sysctl](https://docs.kernel.org/networking/ip-sysctl.html): Documents listener limits, TCP state, congestion control, PMTU settings, and ephemeral-port policy.
- [Recommendations for Transport-Protocol Port Randomization, RFC 6056](https://www.rfc-editor.org/rfc/rfc6056.html)
- [NAT Behavioral Requirements for TCP, RFC 5382](https://www.rfc-editor.org/rfc/rfc5382.html)
- [Path MTU Discovery for IPv4, RFC 1191](https://www.rfc-editor.org/rfc/rfc1191.html)
- [Path MTU Discovery for IPv6, RFC 8201](https://www.rfc-editor.org/rfc/rfc8201.html)
- [TCP Problems with Path MTU Discovery, RFC 2923](https://www.rfc-editor.org/rfc/rfc2923.html): Describes the small-packet success and bulk-transfer stall of an ICMP black hole.
- [Linux man-pages: ss(8)](https://man7.org/linux/man-pages/man8/ss.8.html)
- [Linux man-pages: ip-route(8)](https://man7.org/linux/man-pages/man8/ip-route.8.html)
- [Linux man-pages: ip-link(8)](https://man7.org/linux/man-pages/man8/ip-link.8.html)
- [Linux man-pages: tcpdump(8)](https://man7.org/linux/man-pages/man8/tcpdump.8.html)
- [User Datagram Protocol, RFC 768](https://www.rfc-editor.org/rfc/rfc768.html)
- [QUIC transport, RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html)
- [TLS 1.3, RFC 9846](https://www.rfc-editor.org/rfc/rfc9846.html)
- [DNS concepts, RFC 1034](https://www.rfc-editor.org/rfc/rfc1034.html)
- [Linux kernel: network-stack scaling](https://docs.kernel.org/networking/scaling.html)
- [Linux kernel: segmentation offloads](https://docs.kernel.org/networking/segmentation-offloads.html)
- [Linux kernel: checksum offloads](https://docs.kernel.org/networking/checksum-offloads.html)
- [Netfilter project: nftables](https://netfilter.org/projects/nftables/)
- [Linux man-pages: xtables-nft(8)](https://www.man7.org/linux/man-pages/man8/xtables-nft.8.html): Explains the iptables-nft compatibility frontend and how to identify the selected backend.
- [Linux kernel: BPF program types and ELF sections](https://docs.kernel.org/bpf/libbpf/program_types.html): Maps program types to libbpf ELF section names and attachment expectations.
- [Linux kernel: eBPF verifier](https://docs.kernel.org/bpf/verifier.html): Describes register, pointer, control-flow, and helper checks performed during load.
- [IETF: HTTP Semantics, RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html)

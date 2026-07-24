---
title: Tools, MCP, environments, and sandboxes
description: Treat every tool and MCP server as a capability boundary, then make schema, transport, retry, permission, and isolation semantics explicit.
slug: tools-environments-and-sandboxes
order: 4
identifier: HE4
duration: 155 min
difficulty: Core
tags:
  - tools
  - MCP
  - sandbox
  - idempotency
  - prompt injection
  - permissions
---

## Working model

A tool is a narrow capability lent to a run. Its schema describes the request; its executor controls identity, isolation, time, network, side effects, and the evidence returned.

## Expose the smallest action the task needs

A shell tool can express almost any host action, which also makes its policy difficult to inspect. Prefer task-shaped tools with typed arguments, bounded output, known identity, deadlines, and structured errors. Separate reads from writes so ordinary diagnosis does not carry mutation authority.

Validate arguments again in the executor; model-generated JSON is still untrusted input. Normalize paths, resolve the final target, constrain resource identifiers, cap output, and return a receipt that can be checked independently. A friendly tool description guides selection but is not an authorization control.

> **Effective reach.** Ask what the call can reach if every argument is adversarial. The answer should be narrower than the executor's host identity.

## Separate selection, authorization, execution, and receipt

The model selects a named capability and proposes arguments. Policy decides whether this task, caller, and run may request it. The executor validates normalized arguments and performs the action with a scoped identity inside the selected environment. The receipt reports what happened in terms another component can verify. Combining those steps in one opaque tool wrapper makes it hard to tell a poor choice from a policy defect or executor failure.

A receipt for a read should name the source revision, resolved target, truncation or pagination, and content digest. A write receipt should also carry the logical operation ID, prior and resulting state identifiers, external resource identifier, and whether the result is committed, rejected, partial, or uncertain. The harness must not convert an uncertain result into failure merely because the executor lost its response channel.

- Selection asks which capability fits the next decision
- Authorization checks the declared task against policy and approval
- Execution applies identity, sandbox, deadline, and side-effect rules
- Reconciliation compares the receipt with the system that owns the state

## MCP standardizes discovery and calls, not trust

The Model Context Protocol gives a host a common JSON-RPC interface to external context and actions. JSON-RPC supplies request, response, error, and notification envelopes encoded as JSON; MCP defines the methods and lifecycle carried in those envelopes. In the current final specification, dated 2025-11-25, a client starts with `initialize`; both sides choose a protocol version and declare capabilities, then the client sends `notifications/initialized`. Either side should use only the capabilities negotiated for that connection. Over HTTP, later requests also carry the negotiated version in `MCP-Protocol-Version`.

MCP names several feature families, but three server features matter most when reading an integration:

- **Prompts** are server-provided message templates that a client can present for explicit user selection.
- **Resources** are application-selected context objects addressed by URI. A server may also expose parameterized resource templates, subscriptions, and change notifications.
- **Tools** are model-selectable operations discovered with `tools/list` and invoked with `tools/call`.

The interaction labels describe the protocol's intended use, not an authorization system. A client may build a different interface, and the host still decides which server, resource, prompt, or tool reaches the model. Client features travel in the other direction: roots expose bounded filesystem locations, sampling asks the client to perform model generation, and elicitation asks the client to obtain more information. Each one needs its own policy because an MCP server is an active peer, not a passive schema file.

_Initialization fixes the vocabulary for one connection; host policy fixes the authority._

```text
client -> initialize(version, client capabilities)
server -> chosen version + server capabilities
client -> notifications/initialized
operation -> only negotiated methods
host policy -> still authorizes every exposed capability
```

## Validate MCP input and output separately

An MCP tool declares an `inputSchema`; the 2025-11-25 specification uses JSON Schema 2020-12 when `$schema` is absent. A tool can also declare `outputSchema` and return a JSON object in `structuredContent`. When an output schema exists, the server must return conforming structured data and the client should validate it. That catches shape errors, not false facts or unauthorized effects, so the receipt and independent verification rules still apply.

Keep protocol errors separate from execution errors. An unknown tool or malformed JSON-RPC request returns a protocol error. A tool that ran but rejected a date, hit a downstream API failure, or failed a business rule returns a normal tool result with `isError: true`; the model may be able to repair that call. Do not retry either class until the tool's effect contract says a retry is safe.

Descriptions and metadata also cross a trust boundary. The MCP specification explicitly says clients must treat tool annotations as untrusted unless they came from a trusted server. Apply the same host policy to tool descriptions, prompt contents, resource bodies, embedded links, and result text because each can influence the next model action. Read-only hints such as `readOnlyHint` remain hints; the executor's policy decides whether the call can mutate anything.

## Choose stdio or Streamable HTTP from the process boundary

With `stdio`, the client launches the server as a child process and exchanges newline-delimited JSON-RPC over standard input and output. The server may log to standard error but must not mix logs into standard output. This is a good local boundary only when the launch command, package, working directory, environment, and child-process privileges are trusted and constrained. The MCP authorization specification does not apply its OAuth flow to stdio; local credentials normally come from the process environment.

Streamable HTTP runs the server independently behind one endpoint that accepts POST and GET. It may use Server-Sent Events for multiple server messages, notifications, and resumable streams. A server can serve many clients, so it needs normal service controls: TLS, authentication when protected, request limits, tenant isolation, and per-request authorization. It must validate `Origin` when present and reject an invalid value with HTTP 403; a local server should bind to loopback rather than every interface. Streamable HTTP replaced the older HTTP+SSE transport from the 2024-11-05 protocol version.

> **Transport boundary.** A local child process and a remote multi-tenant service can expose the same tool list while requiring completely different identity, isolation, lifecycle, and incident controls.

## Treat MCP tasks as an experimental handle, not a workflow guarantee

The 2025-11-25 specification introduced tasks as an experimental capability. When both parties declare support for a request type, a request may return a task handle first; the requestor can inspect status, retrieve the eventual result, list or cancel tasks when supported, and handle `working`, `input_required`, `completed`, `failed`, or `cancelled` states.

That handle does not promise exactly-once effects, checkpoint compatibility, worker recovery, or safe replay. Those remain application contracts. Pin the protocol version, test the exact task methods your client and server implement, and expect this experimental surface to change. For long-lived business work, keep the durable workflow and idempotency design described in [Durable state, continuity, and handoffs](./05-durable-state-continuity-and-handoffs.md); an MCP task may expose that work without replacing it.

## A retry is safe only when the effect contract says so

A timeout creates uncertainty: the caller may not know whether an external write committed. Blindly repeating the call can create two tickets, charges, or messages. Give each logical effect a stable idempotency key, store the outcome at the effect boundary, and let a retry return the prior result.

Same input does not always mean same operation. A deliberate second notification may be valid, so deduplication needs a clear scope such as task, turn, recipient, and operation. For systems without native idempotency, write a reconciliation path that checks the authoritative state before deciding whether to retry or compensate.

> **Toy comparison.** A host may cache repeated `read_service` calls for one turn, but a write needs a caller-chosen operation ID and a receipt from the system that owns the change. Reusing read output and proving a write committed solve different problems.

### Worked trace: distinguish result caching from effect idempotency

In [minimal-harness.mjs](examples/minimal-harness.mjs), `setMaintenance` stores the input digest and result under `operationId`. A repeated ID with changed arguments fails, while a repeated ID with the same arguments returns the recorded result. The uncertain-response branch reaches `reconcileWrite`, which reads committed state before the run continues.

A turn-local cache around `readService` would use the current turn, tool name, and normalized arguments as its key, then clear before the next model call. Such a cache may avoid a repeated read, but deleting it must not change write safety. The repeated-read test should depend on the cache; the lost-write-response test should depend on the operation record and reconciliation. If both depend on the same cache entry, the design has mixed two contracts.

## Recover a timed-out pull-request draft safely

A run receives approval to create one draft pull request from branch patch-42. The harness derives operation ID task-42:draft-pr, binds it to repository, base branch, head branch, title, and draft status, then calls the forge adapter. The adapter sends the create request, but its connection closes before a response arrives. The result is uncertain, not failed.

The retry path first queries the forge with the same operation record and branch pair. If the draft exists with matching parameters, the adapter returns its identifier as the prior result. If nothing exists and the original operation remains safe to repeat under the forge contract, it retries with the same ID. A matching ID attached to different parameters causes a conflict. A second notification requested later needs a new logical operation because deduplication should not erase intentional work.

_The operation identity remains fixed across transport attempts._

```text
operation = task-42:draft-pr
effect = create draft for base=main, head=patch-42
response channel closes -> state=uncertain
reconcile by operation record and branch pair
existing match -> return receipt; mismatch -> conflict
```

## Isolation, policy, and prompt handling cover different threats

A sandbox limits damage after a bad decision; it does not make external text trustworthy. Treat retrieved pages, issue comments, documents, and tool output as data that cannot grant new permissions. Keep secrets out of model context when a broker can inject them only into the authorized call.

Choose the execution boundary from the workload and threat model. A user-space kernel such as gVisor intercepts many application syscalls before they reach the host kernel. Kubernetes policy can pair that runtime with dedicated nodes, scoped service accounts, read-only or disposable storage, and explicit egress rules. Warm pools reduce allocation delay, but pooled environments still need reset and ownership checks before reuse.

- Filesystem policy controls which paths exist and whether writes persist.
- Network policy controls destinations, ports, DNS behavior, and default deny.
- Identity and secret brokers control which external principals the run can use.
- Approval policy gates effects whose consequence exceeds autonomous authority.

> **Toy sandbox.** Give a parser-repair run one disposable workspace, read access to the checkout, write access only to `packages/parser`, no outbound network, and a 15-minute deadline. The sandbox limits damage; the host still validates each proposed tool call and checks the resulting diff.

### A warm pool pre-creates idle sandboxes

A cold launch waits for Pod creation, scheduling, node capacity, image availability, volume setup, application initialization, and readiness. A warm-pool controller moves that work earlier by maintaining ready but unclaimed sandboxes.

```text
desired idle count = 3
  -> controller creates and warms 3 sandbox Pods
  -> a claim atomically adopts 1 existing Pod
  -> the run starts without another Pod launch
  -> controller creates and warms 1 replacement
```

The pool size normally describes idle inventory, not idle plus active work and not a concurrency limit. “Replenish the pool” means create and warm a replacement Pod. It does not necessarily mean create a node. The scheduler uses existing capacity when possible; otherwise the replacement stays Pending and may cause a node autoscaler to add supply.

Claiming should preserve the existing Pod, node, mounted filesystem, initialized processes, and node-local cache state when the controller supports adoption. It must still atomically assign one owner, prove that the sandbox is ready and clean, replace run-scoped credentials, and prevent one tenant from inheriting another tenant's writable state. Warm inventory and node supply are two separate control loops with separate limits and failure signals.

### Worked grant: follow launcher policy into the runner

The launcher owns this toy run grant:

```yaml
tools: [read_file, apply_patch, run_test]
read_paths: [packages/parser, tests/parser]
write_paths: [packages/parser]
network: deny
deadline_seconds: 900
workspace: disposable
```

Under this grant, the runner rejects an undeclared tool, a write under `tests/parser`, a network request, and a call after the deadline. A conflicting policy file inside the checkout cannot widen the launcher's grant. MCP discovery may add descriptions and schemas to the model's context, but the resulting calls still pass through the same host-owned policy.

## Diagnose a blocked call from policy toward the host

Record capability name, tool-contract version, policy decision, approval reference, normalized arguments, executor identity class, sandbox image, mount policy, egress decision, deadline, result class, and receipt ID. Redact sensitive values before storage. A permission denial should show which layer denied it; 'tool failed' is not enough to distinguish schema rejection, policy block, filesystem denial, DNS failure, network denial, remote authorization, or timeout.

Trend denied destinations, path escapes, approval mismatches, uncertain effects, sandbox reset failures, and repeated operation IDs. A spike in path rejection after a repository layout change may require a scoped policy update. A rise in unexpected outbound destinations may indicate injection or a compromised dependency and should stop the affected capability. Do not widen all egress or filesystem access to make one ambiguous failure disappear.

> **Takeaway.** Grant the run one task-shaped capability at a time, return a verifiable receipt, and reconcile uncertain writes before any retry.

## Summary

Tool safety comes from the whole execution boundary, not the argument schema alone. A useful adapter limits what can be requested, who performs it, where it runs, how uncertainty is reconciled, and what receipt another component can verify.

- Prefer task-shaped read and write capabilities over a broad shell when the action can be named directly.
- In MCP, negotiate the protocol version and capabilities before operation. Expose only the intended features, validate `inputSchema` before execution, and validate structured output on return.
- Use stdio for a constrained child process and Streamable HTTP for a separately operated service; neither transport grants trust by itself.
- Treat MCP annotations, descriptions, prompts, resources, links, and results as untrusted server content until host policy says otherwise.
- Keep proposal, policy decision, normalized execution, and receipt separate. Bind each effect to an operation ID, and reconcile a timed-out write before retrying.
- Treat 2025-11-25 MCP tasks as experimental deferred-result handles, not a substitute for durable execution or idempotency.
- Use sandboxes to limit damage, keep secrets outside model context when a broker can supply them to an approved call, and report the exact layer that denied a request.
- A warm-pool count normally means ready idle inventory. Claiming adopts one existing sandbox, while replenishment creates a replacement Pod and triggers node scaling only when current nodes cannot fit it.

## References

- [MCP 2025-11-25: Lifecycle and capability negotiation](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [MCP 2025-11-25: Tools and schemas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP 2025-11-25: Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [MCP 2025-11-25: Prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- [MCP 2025-11-25: stdio and Streamable HTTP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 2025-11-25: Experimental tasks](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/tasks)
- [RFC 9110: Idempotent methods](https://www.rfc-editor.org/rfc/rfc9110.html#name-idempotent-methods)
- [Stripe API: Idempotent requests](https://docs.stripe.com/api/idempotent_requests): A concrete API contract for replaying the same operation key and rejecting changed parameters.
- [gVisor architecture guide](https://gvisor.dev/docs/architecture_guide/intro/)
- [Minimal harness](examples/minimal-harness.mjs): Trace an uncertain write through operation storage and reconciliation.

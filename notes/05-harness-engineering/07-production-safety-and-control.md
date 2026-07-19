---
title: Production safety and control
description: Threat-model the full agent path, apply least privilege, contain prompt injection, and give operators audit, budget, and emergency controls.
slug: production-safety-and-control
order: 7
identifier: HE7
duration: 160 min
difficulty: Advanced
tags:
  - least privilege
  - prompt injection
  - audit
  - kill switch
  - budgets
  - MCP authorization
---

## Working model

Assume any decision can be wrong. Limit the authority available at that moment, make consequential effects interruptible, and preserve enough evidence for an operator to understand and contain the result.

## Prompt injection is one path through a larger system

Direct user input can ask for a forbidden action. Indirect input can hide the same request in a page, issue, document, dependency, image text, or tool result. The model may also invent a destination, expose a secret in an argument, or misread a policy. Threat modeling should follow data and authority across the whole path rather than treating one prompt as the security boundary.

List trust boundaries, assets, actors, entry points, effects, and detection paths. Pay special attention to transitions where untrusted content influences a privileged tool, where one tenant's artifacts could enter another run, or where an evaluator reads output produced by the system it is grading.

> **Injection rule.** Instruction wording can reduce accidental confusion, but it cannot grant security against hostile content. Enforce authority in code, identity, network, and storage policy.

## Least privilege is specific to a task and a moment

Give the run a scoped identity, narrow tools, a constrained filesystem, default-deny egress, short-lived credentials, and task-level quotas. Delay write authority until the contract and candidate are ready. Remove it after the effect rather than leaving a broad credential in context or process state.

Human approval should bind to a concrete preview: operation, target, important parameters, expected effect, evidence, and expiry. The executor must fail closed if approval is absent, denied, stale, or refers to a different action. Approval is not a permanent elevation and should not authorize follow-on actions that were not shown.

> **Toy approval gate.** The host pauses a selected write until it receives a decision bound to that exact call. Approval answers whether this effect may run; an operation ID answers whether the same effect already ran. One can't replace the other.

### Worked approval matrix: fail closed

Using the `call-17` record from [Intent and executable contracts](02-intent-and-executable-contracts.md), a fail-closed matrix contains five cases: no decision, explicit denial, changed arguments digest, expired approval, and an exact approval. The first four return a structured rejection while an executor counter stays at zero; only the exact approval may increment it once.

A retry of the accepted call with the same operation ID returns its stored receipt rather than performing the write again. That separate assertion proves the difference between permission and duplicate-effect control.

## Bind MCP tokens to one protected server

Name the OAuth parties before reading the MCP rule. The **client** wants to call a protected MCP server. An **authorization server** authenticates and authorizes the user, then issues an **access token**. The MCP server acts as the **resource server** that receives the token and decides whether the requested method and object are allowed. A bearer token grants its authority to whoever possesses it, so the client and server must keep it out of model context, logs, URLs, and tool results.

The token's target and its permitted actions answer different questions. A resource indicator or audience binds the token to the server that should accept it. Scopes describe the classes of action it may authorize there. The resource server still applies object-level and tenant-level policy on every request; possession of a valid token does not make every object visible.

MCP authorization is optional at the protocol level and applies to HTTP-based transports when implemented. The protected MCP server acts as an OAuth resource server. The client must include an RFC 8707 `resource` value in both authorization and token requests, identifying the canonical MCP server URI; the server must validate that each bearer token was issued for itself. Authorization belongs on every HTTP request, even when several requests share one MCP session.

Do not pass the client's MCP token through to an upstream API. The 2025-11-25 authorization specification forbids token passthrough because it breaks audience boundaries and makes the MCP server a confused deputy. If the MCP server calls another service, it acts as a separate OAuth client and uses a different token issued for that upstream resource. Start with narrow scopes and perform bounded step-up authorization only for the operation that needs more privilege.

The protocol does not apply this OAuth flow to stdio servers; their credentials normally enter through the child process environment. That makes the launch boundary part of the security model. A downloaded package or startup command runs with the client's OS privileges unless the host adds sandboxing, path limits, egress limits, and explicit installation consent.

_Each arrow needs its own audience and authorization decision._

```text
user -> MCP client
MCP client -> token audience: MCP server
MCP server -> validate token + authorize method and object
MCP server -> separate upstream credential, if needed
downstream API -> validate its own audience and scopes
```

## Sessions, discovery, and metadata add attack surfaces

An MCP session identifier coordinates protocol state; it is not proof of identity. Stateful HTTP servers must authorize every inbound request, generate unpredictable session IDs, and bind stored session state to the authenticated user so an injected event cannot cross tenants. Streamable HTTP servers also validate `Origin`; local HTTP endpoints should bind to loopback and require authentication when exposed beyond a private child-process boundary.

OAuth discovery makes the client fetch server-provided metadata URLs. A malicious server can aim those fetches at loopback, private networks, redirects, or cloud metadata services; this is a server-side request forgery (SSRF) path. Route discovery through an egress policy, require HTTPS outside loopback development, validate every redirect hop, and reject private or reserved destinations unless the deployment explicitly needs them. Avoid handwritten IP parsers that miss alternate encodings or DNS rebinding.

Treat MCP catalog data as hostile input too. Tool descriptions, annotations, prompts, resource bodies, URI templates, and tool results can all steer a model or a UI. Displaying them does not make them safe, and a `readOnlyHint` does not override executor policy. A client that offers one-click local server setup should show the exact command before launch and require consent; truncating the command hides the part that matters.

## Block an injected destination before a privileged effect

A maintenance run may update one staging webhook at api.staging.example. A retrieved issue comment tells the agent to verify the fix by sending credentials and payload samples to a different host. The context layer labels the comment as untrusted evidence. The model still proposes an HTTP tool call to that host, but policy denies it because the destination falls outside the task's egress allowlist and the tool lacks secret-read authority.

The run then prepares the allowed webhook change. The approval preview includes environment, resource ID, old and new destination, operation ID, expected effect, and expiry. Before execution, the adapter resolves the current resource version and confirms that the approval still matches. If the target changed, approval expired, or the preview differs from the call, it stops. After a valid update, the adapter returns an external receipt and the verifier reads the resource through a separate path before removing write authority.

_Content may influence a proposal; code and identity decide whether the effect can occur._

```text
untrusted comment -> proposed unapproved host
egress policy + absent secret capability -> deny
approved staging target -> bind preview to version and operation ID
execute with short-lived identity
read back state -> store receipt -> remove write authority
```

## Audit records should support review without becoming a secret dump

Record the task and policy versions, principal, approvals, model and tool spans, sanitized arguments and results, artifact digests, external receipts, budget changes, and termination reason. Use append-oriented storage and access controls appropriate to the data. Protect integrity so a compromised worker cannot quietly rewrite its history.

Replay is selective reconstruction, not blind re-execution. Read-only model and policy decisions can often be simulated from recorded inputs. External writes should be stubbed, reconciled, or replayed only in an isolated test system with new operation identities. Redaction must happen before export while preserving stable correlations for investigation.

> **Trace privacy.** Tool inputs and model context may contain credentials, personal data, or customer artifacts. Observability defaults must honor data classification instead of storing every value because tracing is enabled.

## Budgets and kill switches need an enforcement path outside the run

Set per-run and aggregate limits for model calls, tokens, cost, elapsed time, concurrent workers, tool calls, and external effects. Reserve enough budget for cleanup and evidence capture; a system that spends its last unit on a write may be unable to verify or compensate for it.

A kill switch should block new work, interrupt or quarantine active work, revoke credentials, and expose what remains uncertain. Test it under load and during partial failures. Pair the global stop with narrower controls for a tool, tenant, model version, policy version, or destination so operators can contain a fault without taking down unrelated work.

> **Toy containment stack.** Combine a disposable workspace, a per-run identity, default-deny network access, resource limits, and a hard deadline. Those controls reduce the effect of a bad call, while host policy still decides which calls may enter the sandbox.

### Worked policy boundary: permission stays outside the prompt

Suppose the toy launcher grant from [Tools, environments, and sandboxes](04-tools-environments-and-sandboxes.md) encounters an `agent-policy.yaml` file inside the checkout that claims the run may write anywhere and contact any host. The file is untrusted repository text, so the launcher grant remains unchanged.

An allowed source read passes. A write outside `packages/parser`, an outbound HTTP call, and an otherwise allowed test after the deadline fail at different policy layers and receive distinct rejection classes. A generic `tool failed` result would lose the evidence an operator needs.

## Incident containment starts with incomplete information

A safety incident begins with uncertainty about active workers and committed effects. The operator path should identify affected task, tenant, tool, model, policy, and destination versions; block new dispatch; revoke or disable scoped identities; cancel or quarantine active runs; and collect external receipts for reconciliation. Keep the stop service independent from the worker control loop so a stuck model call cannot prevent containment.

Measure policy denials, approval mismatches, secret-filter events, unexpected destinations, cross-tenant access attempts, uncertain effects, budget stops, kill-switch propagation time, credential revocation time, and reconciliation backlog. Test narrow and global stops in an isolated environment, including unavailable workers and delayed networks. Afterward, add the failure to a threat model, regression case, or runbook and review whether retained traces exposed more data than the investigation needed.

> **Takeaway.** Assume proposals can be hostile or wrong, bind authority to one reviewed effect, and keep an operator stop path outside the run being stopped.

## Summary

Production safety assumes untrusted inputs and fallible decisions. Keep authority narrow and temporary, place enforcement outside the model, and give operators a stop path that still works when a worker is stuck.

- Trace prompt injection through users, retrieved pages, issue text, documents, tool results, proposed arguments, and external destinations.
- Grant a scoped identity, constrained filesystem, narrow tools, default-deny egress, short-lived credentials, and task-level quotas.
- Delay mutation authority until the candidate is ready, bind approval to exact targets and parameters, and revoke that authority after the effect.
- For protected MCP over HTTP, bind tokens to the canonical server URI, validate the audience on every request, and use a separate credential for any downstream API.
- Authorize MCP sessions independently of session IDs, constrain OAuth discovery against SSRF, and treat server metadata as untrusted content.
- Store sanitized decisions and receipts without copying secrets into the audit record; reserve time and budget for verification, cleanup, and reconciliation.
- Keep dispatch blocking, credential revocation, run cancellation, and receipt collection independent from the worker being contained.

## References

- [NIST AI 600-1: Generative AI Profile](https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf)
- [OWASP Top 10 for LLM Applications 2025](https://owasp.org/www-project-top-10-for-large-language-model-applications/assets/PDF/OWASP-Top-10-for-LLMs-v2025.pdf)
- [OWASP Top 10 for Agentic Applications 2026](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)
- [MCP 2025-11-25: Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP 2025-11-25: Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Model Context Protocol: Security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- [gVisor architecture guide](https://gvisor.dev/docs/architecture_guide/intro/)

---
title: Security, Failure Cascades, and a Worked Design
description: Protect identities, messages, state, and recovery paths, then use real datacenter failures to test whether a distributed design can contain damage and return to service.
slug: security-incidents-and-capstone
order: 10
identifier: DS10
duration: 4 hours
difficulty: Advanced
tags:
  - threat-modeling
  - TLS
  - IAM
  - incident-response
  - disaster-recovery
  - worked-case
---

## Working model

Security and reliability both ask which actions and states remain possible when assumptions fail. Define the actor, authority, protected state, dependency, failure boundary, and recovery evidence before choosing encryption, an identity and access management (IAM) policy, replica count, or failover automation.

## Start with an attacker model, not an algorithm name

“Encrypt it” is not a threat model. Begin with the system's assets, actors, interfaces, and trust boundaries. Assets may include customer records, signing keys, service availability, deployment authority, billing state, and audit evidence. Actors include users, workload processes, administrators, cloud providers, and outside attackers. A compromised workload or stolen administrator session often matters more than a stranger guessing ciphertext.

State the attacker's capabilities. Can the attacker observe traffic, change packets, replay an old request, call a public API, steal one service token, compromise one node, control DNS for a name, or exhaust a bounded resource? Can they read backups or only production endpoints? A crash-fault protocol does not remain correct when one participant lies about votes; a private subnet does not make every process in it trustworthy.

Then name the objective. The familiar **CIA** properties provide a start:

| Property        | Concrete question                                                                    |
| --------------- | ------------------------------------------------------------------------------------ |
| Confidentiality | Which principals may read order 817 or its backups?                                  |
| Integrity       | Which principals may change its amount, and how can tampering be detected?           |
| Availability    | Which operations must meet which service objective under a stated attack or failure? |

Availability does not mean “always readable and writable.” Give it a scope and measurement, such as 99.95 percent successful authorized reads per region over 30 days, excluding no dependency by wishful thinking. Authenticity, accountability, privacy, and safety may add separate requirements.

Security **policy** states the permitted result. A **mechanism** enforces part of that policy. “Only the settlement service may mark an invoice paid” is policy. Workload identity, a signed token, an IAM rule, database permission, and audit logging are mechanisms. Several mechanisms usually compose one policy, and a bypass path can defeat all the others.

## Authentication establishes identity; authorization permits an action

**Authentication** answers which principal made a request. **Authorization** decides whether that principal may perform an action on a resource under current conditions. **Audit** preserves evidence of the decision and result. Logging a denied call does not authorize it, and possessing a valid identity does not grant every action.

Long-lived shared secrets make revocation and attribution difficult. Prefer short-lived, narrowly scoped workload credentials issued from an established identity. Rotate the underlying trust material, bind credentials to an audience, and reject expired or replayed assertions. Human administrator access needs phishing-resistant authentication, bounded elevation, and a separate emergency path whose use produces an alert.

Authorization models encode policy differently. An access-control list attaches principals and permissions to an object. A capability gives its holder authority described by the capability. Role-based access control groups permissions by job or workload role. Attribute-based policy evaluates principal, resource, action, and environmental attributes. Cloud IAM systems often combine these forms.

For an AWS-style request, write the decision tuple:

```text
principal = payments-worker role session
action    = kms:Decrypt
resource  = settlement-key ARN
condition = source account, encryption context, network or session constraints
```

Identity policy, resource policy, permission boundary, organization controls, session policy, and explicit deny may all affect the result. A broad allow in one place does not cancel an applicable explicit deny. Test the effective decision with the actual principal and context; reading one policy document alone can mislead.

Least privilege is a maintenance process. Start with the calls the workload actually makes, constrain resources and conditions, observe denials, and remove stale permission as software changes. A policy copied once and never reviewed drifts toward permanent excess authority.

## Use modern cryptographic constructions through maintained libraries

Symmetric encryption uses one secret key for protection and recovery. Modern applications normally need authenticated encryption with associated data (**AEAD**), which protects ciphertext confidentiality and integrity while authenticating selected unencrypted metadata. AES-GCM and ChaCha20-Poly1305 are common AEAD constructions. Their nonce rules are part of security; reusing a nonce with the same key can break the guarantee.

Do not present DES as an option, and do not recommend MD5 or SHA-1 for signatures. The lecture includes them as historical examples. Hash functions, message authentication codes, encryption, and signatures solve different problems.

Public-key cryptography separates public and private material, but the classroom phrase “encrypt with the private key and decrypt with the public key” is a poor model for signatures. A signature algorithm signs with a private key and verifies with a public key. Applications should use a specified signature scheme through a reviewed library rather than raw RSA arithmetic.

**Digital signatures** authenticate signed bytes and detect modification under assumptions about the private key and verification algorithm. They do not prove that a human understood a document, and “non-repudiation” depends on key custody, process, and law. Current NIST standards include classical digital signatures in FIPS 186-5 and post-quantum ML-DSA and SLH-DSA standards. Infrastructure needs crypto agility because algorithms, certificate profiles, and library support change over a system's lifetime.

**Envelope encryption** generates a data-encryption key for data, encrypts that data locally, then asks a key-management service (KMS), often backed by a hardware security module (HSM), to protect the data key under a longer-lived wrapping key. The ciphertext stores the protected data key and algorithm metadata. This limits the amount of data processed by the central key service and gives operators a policy and audit point, but plaintext data keys must have short, controlled lifetimes in memory.

## Transport Layer Security authenticates a channel under a trust decision

Transport Layer Security (TLS) 1.3 negotiates protocol parameters, establishes shared traffic secrets, authenticates the server under the selected mode, and protects records against eavesdropping, modification, and forgery. RFC 9846 is the current TLS 1.3 publication and obsoletes RFC 8446. Use a maintained TLS stack; protocol details are not application code exercises.

In an ordinary certificate handshake, the server presents a leaf certificate and often intermediate certificates. The client builds and validates a chain to a trust anchor in its local store. It verifies signatures, validity periods, name constraints and extensions, permitted usage, and whether the requested DNS name appears in the certificate's subject alternative names. A certificate chain is not simple transitivity, and a public key appearing in a certificate is not enough by itself.

Mutual TLS adds client certificate authentication, which can establish workload identity when certificate issuance, rotation, revocation, and name mapping are controlled. It does not decide business authorization. The server still needs a policy mapping that identity to an action.

TLS protects one connection. Data can appear in plaintext before encryption or after decryption, logs can leak fields, a compromised endpoint can make authorized calls, and DNS or routing can still deny service. TLS 1.3 early data also has replay considerations; do not allow a replayable request to perform an unprotected state-changing action.

## Work one service request across the controls

Suppose `payments-worker` reads an encrypted settlement file from object storage and writes a result to a database.

1. The workload obtains a short-lived role session through its platform identity rather than reading a static cloud secret from an image.
2. DNS and routing select service endpoints. TLS authenticates each endpoint and protects traffic.
3. Object storage authorizes `GetObject` for one prefix. An explicit deny blocks access outside the production account.
4. The worker asks KMS to decrypt the protected data key. The request includes an encryption context binding it to the settlement object.
5. The worker decrypts data in memory through an approved AEAD library and clears temporary key material when practical.
6. A database role authorizes only the required tables and statements. A transaction writes the result plus a stable operation ID.
7. Audit records identity, action, resource, decision, and request identity without copying settlement plaintext or credentials.

Now compromise the worker. Network encryption still works, but the attacker can call whatever the worker may call. Prefix restrictions, KMS context, short session life, database permissions, egress controls, anomaly detection, and operation-level invariants determine the remaining blast radius. Defense in depth means each boundary removes a specific capability.

## Outages usually grow through dependencies and recovery work

The 2011 Amazon EBS incident began with a network change in one Availability Zone. Traffic moved to a lower-capacity network, isolating many EBS nodes from replicas. When connectivity returned, a large set of volumes searched for replacement replica capacity at once. The resulting re-mirroring storm exhausted capacity. Long-running control-plane requests occupied a regional thread pool, and a race under unusual load caused more EBS node failures. Recovery work became a source of failure.

Several lessons follow. Rate-limit repair, reserve capacity for it, apply backoff with jitter, and isolate a damaged cell from a regional control plane. Bound queue time and shed requests before worker pools fill. Test rare concurrency paths under recovery load rather than only ordinary traffic. A Region is not one datacenter: it contains several Availability Zones, and an Availability Zone can contain one or more datacenters. Multi-AZ design reduces named failure modes but does not erase regional or shared-control dependencies.

Meta's [primary write-up of the 2010 Facebook configuration incident](https://engineering.fb.com/2010/09/23/uncategorized/more-details-on-today-s-outage/) describes a cache-repair mechanism that queried persistent storage when a cached value looked invalid. An invalid authoritative value made many clients query the database together. Database errors caused clients to discard cache entries and retry, increasing the load. Operators stopped site traffic, let storage recover, fixed the value, and restored traffic gradually. A repair path needs admission control, stale or last-known-good behavior where safe, and a failure mode different from “every client asks the authority now.”

The supplied L28 lecture reports that The Planet's 2008 datacenter fire exposed another boundary: backup generators could not run while the fire department controlled the building, even though servers survived. Treat those details as a lecture-reported case because this note does not have a preserved first-party incident report. The mechanism-level lesson remains sound: staff access, cooling, power, network, and available capacity at another site all matter, and replicas in the same building do not protect against losing the building.

Do not repeat the lecture's “70 percent of outages are human error” as a current general statistic. Classification methods differ, automation can encode a human mistake into rapid machine action, and published incidents are a biased sample. Study the mechanism, not a slogan.

## Trace the October 2025 AWS cascade

The October 19 to 20, 2025 AWS event offers a current dependency trace. DynamoDB used redundant DNS Enactors in three Availability Zones. A slow Enactor checked that its plan was fresh, then stalled. A faster Enactor applied a newer plan and deleted sufficiently old plan data. The slow Enactor later overwrote the active endpoint with its now-deleted older plan because it did not recheck freshness at the write. The public regional endpoint became empty, and automation could not repair the inconsistent state without operator intervention.

That initial race propagated:

```text
empty DynamoDB endpoint
  -> new DynamoDB connections fail
  -> EC2 management checks cannot renew leases
  -> many leases expire while DynamoDB is unavailable
  -> lease re-establishment overloads the workflow manager
  -> engineers throttle work and selectively restart managers
  -> delayed network-state changes form another backlog
  -> NLB health checks see partially configured new capacity
  -> health results alternate and remove usable capacity from DNS
  -> dependent AWS services experience later and different failures
```

Existing EC2 instances stayed healthy during the initial management-plane impairment. New launches and management workflows failed. That distinction matters: control-plane failure does not always stop an existing data plane, and recovery automation can damage healthy capacity if it assumes management state is current.

The direct fixes described by AWS include protecting DNS plan application, limiting how quickly NLB health automation can remove capacity, testing EC2 workflow recovery at scale, and rate-limiting incoming propagation work based on queue size. General controls include compare-and-set or fencing on plan versions, an invariant forbidding publication of an empty active endpoint set, safe separation of activation and cleanup, bounded retries, queue-aware admission, and a rehearsed manual recovery path.

## Design recovery objectives before the incident

**Recovery point objective (RPO)** is the maximum acceptable data-loss interval measured backward from disruption. **Recovery time objective (RTO)** is the maximum acceptable delay before service returns to the required level. They are targets, not averages.

Suppose order intake has `RPO = 0` for acknowledged orders and `RTO = 30 minutes` for a regional disaster. A nightly backup cannot meet that RPO. Synchronous multi-AZ storage may protect acknowledged writes against one site failure, but a regional objective needs another recovery copy and an application plan for routing, identity, secrets, streams, and reconciliation. `RPO = 0` across regions can add write latency or reduce write availability during lost communication, so the business contract must accept that cost.

Replication keeps a current service copy and can copy corruption or deletion immediately. A backup preserves a recovery point under a separate retention and access policy. Failover changes which deployment serves traffic. Restore reconstructs data and service state. Failback returns authority later and needs its own reconciliation plan.

A recovery plan should identify:

- The authoritative data and every derived store that can be rebuilt
- Backup frequency, immutability, credentials, retention, and restore test evidence
- Regional dependencies for DNS, identity, keys, artifact storage, control planes, and observability
- Capacity needed during failover and catch-up, not only quiet standby capacity
- The authority switch, fencing method, rollback condition, and data reconciliation owner
- What degraded service can operate safely when a dependency remains unavailable

Static stability means the surviving cells already have enough capacity and independent dependencies to serve the intended load. Depending on an impaired control plane to launch replacement capacity during the event is a weaker plan.

## Rehearse the failure and record what happened

A game day tests one stated hypothesis under controlled conditions. “Turn things off and see” is not a test plan. Define the failure injected, expected detection, operator action, safety guard, abort condition, customer impact limit, and evidence to collect.

For example, block one application's access to its primary object-store endpoint in a staging or isolated production cell. Expect clients to stop after their retry budget, a circuit breaker to open, a last-known-good configuration to remain available for fifteen minutes, and an alert to identify the dependency within five minutes. Measure queue growth and recovery traffic when access returns. If clients synchronize retries and overwhelm the store, the game day found a recovery defect before a real incident did.

An incident record should preserve impact, detection, a fact-based timeline, decision points, recovery actions, and unresolved uncertainty. The postmortem then explains triggering events, contributing conditions, why defenses did not contain the event, and which actions change the system. Each action needs an owner, due date, and verification method. “Be more careful” changes nothing.

Security incident response and reliability response overlap. Preserve evidence and access logs, control credentials, contain damage, restore service, and avoid destroying forensic material during cleanup. NIST SP 800-61 Revision 3 treats preparation and learning as part of ongoing risk management, not a binder opened only after compromise.

## Worked case: design an order-ingestion service

Assume a company needs an API that accepts orders, returns an order ID within 300 ms at the p99, handles 2,000 requests per second at peak, never acknowledges the same client operation as two orders, and keeps acknowledged-order RPO at zero for an Availability Zone failure. Regional recovery has a 30-minute RTO and a five-minute RPO. Analytics may lag by fifteen minutes.

Start with the path. A regional load balancer terminates or passes TLS to authenticated API workloads. The API verifies a user token, authorizes account access, and sends a stable client operation ID into a relational database transaction. A unique constraint on `(account_id, operation_id)` makes a retry return the original result. The same transaction writes an outbox row. A relay publishes the accepted-order event to a retained stream; fulfillment and analytics use separate consumer groups.

The database is the authority for current order state. Multi-AZ synchronous replication protects the named zone failure, while encrypted cross-region recovery copies and tested restore support the regional RPO. Object storage holds exports and backups, not the mutable transaction authority. KMS policies bind decryption to the workload and data class. Every service uses short-lived workload identity and narrower database or stream permissions.

Then test failure rather than drawing more boxes. If the reply disappears after commit, the operation ID recovers the result. If the stream is down, the outbox grows while order intake continues until a stated storage or age limit. If one zone fails, preprovisioned capacity in surviving zones handles peak traffic without asking the failed control path to scale it. If identity issuance fails, existing sessions have a bounded usable life and emergency operator access follows a separate audited path. If the region fails, the runbook restores or promotes authority, fences the old writer, updates routing, verifies order and outbox positions, and communicates the RPO actually achieved.

Observe request success and latency, database commit and replica lag, deduplication conflicts, outbox age, stream partition lag, consumer failures, authorization denies, key-service errors, backup age, restore duration, and capacity headroom. Alerts should identify the violated user or recovery contract, not merely that one CPU crossed 80 percent.

## Use one checklist for any distributed design

| Design record           | Required contents                                                                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose and load        | Successful user action, request or event rate, payload, latency target, and availability target                                               |
| State and authority     | Authoritative and derived state, allowed writers, transaction boundary, and state owner                                                       |
| Placement and flow      | Partitions, replicas, failure domains, routing decision, and bytes crossing each network edge                                                 |
| Ordering and invariants | Forbidden concurrent outcomes, ordering scope, conflict rule, and mechanism that rejects an invalid transition                                |
| Failure model           | Processes and dependencies that may pause, crash, partition, lie, fill, expire, or lose durable state                                         |
| Recovery                | Retry, replay, rebuild, failover, fencing, and restore actions, including the load each action creates                                        |
| Security                | Principal for each action, authentication method, authorization policy, secret and key boundary, and audit record                             |
| Operations and cost     | Health and contract signals, rollback rule, failure rehearsal, and the dominant CPU, memory, storage, network, accelerator, or energy expense |

Do not maximize every design goal. Full resource utilization removes recovery headroom. Cross-region synchronous coordination can improve one data-loss objective while increasing latency and reducing write availability during a partition. Transparency can simplify normal use while hiding stale caches or partial failure that the application should handle. A sound design states those trades in the contract.

## Summary

Security and recovery depend on enforced authority and observable evidence. Threat models describe who can do what; cryptographic and IAM mechanisms narrow those capabilities; incident analysis shows where shared dependencies and recovery traffic escape the intended boundary.

- **Threat-model the actor and boundary.** CIA properties become useful only after assets, capabilities, interfaces, and measurable objectives are named.
- **Keep identity, permission, and evidence separate.** Authentication identifies a principal, authorization evaluates an action on a resource, and audit records the decision and result.
- **Use current protocols and libraries.** AEAD protects ciphertext and associated metadata, signatures are not “private-key encryption,” and RFC 9846 is the current TLS 1.3 specification.
- **Certificates authenticate under local trust.** Chain signatures, names, constraints, validity, usage, and trust anchors all take part; mTLS identity still needs business authorization.
- **Recovery work can extend an outage.** Re-mirroring, cache repair, lease renewal, queue replay, scaling, and health automation need rate limits, isolation, spare capacity, and tested manual controls.
- **Replication, backup, failover, and restore differ.** RPO limits acceptable lost data; RTO limits recovery delay. Restore tests prove more than successful backup jobs.
- **Postmortems should change mechanisms.** Preserve a factual timeline, identify contributing conditions, and assign verifiable actions instead of blaming an operator.
- **Review every design through the same boundaries.** State, authority, placement, ordering, failure, recovery, security, operations, and cost expose gaps that a service-name diagram misses.

## References

- [CS 425 Fall 2025 L27: security](https://courses.grainger.illinois.edu/cs425/fa2025/L27.FA25.pdf)
- [CS 425 Fall 2025 L28: datacenter disasters](https://courses.grainger.illinois.edu/cs425/fa2025/L28.FA25.pdf)
- [CS 425 Fall 2025 final review](https://courses.grainger.illinois.edu/cs425/fa2025/Llast.FA25.pdf)
- [NIST SP 800-30 Revision 1: Guide for Conducting Risk Assessments](https://csrc.nist.gov/pubs/sp/800/30/r1/final)
- [RFC 9846: The Transport Layer Security Protocol Version 1.3](https://www.rfc-editor.org/rfc/rfc9846.html)
- [RFC 5116: An Interface and Algorithms for Authenticated Encryption](https://www.rfc-editor.org/rfc/rfc5116.html)
- [NIST FIPS 186-5: Digital Signature Standard](https://csrc.nist.gov/pubs/fips/186-5/final)
- [RFC 5280: Internet X.509 Public Key Infrastructure Certificate and CRL Profile](https://www.rfc-editor.org/rfc/rfc5280.html)
- [NIST: finalized post-quantum cryptography standards](https://www.nist.gov/news-events/news/2024/08/nist-releases-first-3-finalized-post-quantum-encryption-standards)
- [AWS IAM: policy evaluation logic](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html)
- [AWS: 2011 EC2, EBS, and RDS service disruption](https://aws.amazon.com/message/65648/)
- [Meta Engineering: More Details on Today's Outage](https://engineering.fb.com/2010/09/23/uncategorized/more-details-on-today-s-outage/): Primary account of the 2010 configuration-repair feedback loop.
- [AWS: October 2025 DynamoDB service disruption](https://aws.amazon.com/message/101925/)
- [AWS Builders' Library: timeouts, retries, and backoff with jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [AWS Builders' Library: static stability using Availability Zones](https://aws.amazon.com/builders-library/static-stability-using-availability-zones/)
- [AWS Well-Architected Reliability Pillar: disaster-recovery objectives](https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/disaster-recovery-dr-objectives.html)
- [NIST SP 800-61 Revision 3: Incident Response Recommendations](https://csrc.nist.gov/pubs/sp/800/61/r3/final)
- [Google SRE Book: Postmortem Culture](https://sre.google/sre-book/postmortem-culture/)

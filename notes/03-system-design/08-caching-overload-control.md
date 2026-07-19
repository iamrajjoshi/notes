---
title: Cache Deliberately and Survive Overload
description: Place caches at the edge or service boundary, define freshness and invalidation, then contain overload with deadlines, jitter, retry budgets, shedding, circuit breakers, and shuffle shards.
slug: caching-overload-control
order: 8
identifier: SD8
duration: 2.5 hours
difficulty: Advanced
tags:
  - cache
  - CDN
  - stampede
  - deadlines
  - load shedding
  - rate limiting
  - circuit breaker
---

## Working model

A cache is a controlled inconsistency layer, and overload protection is a controlled refusal layer. Both trade a perfect answer now for a system that can still answer later.

[DB9: Redis](../07-data-systems/09-redis-data-structures-persistence-and-cluster.md) follows one cache through command execution, expiration, eviction, persistence, replication, failover, and cluster routing. This note stays at the system-design boundary: cache semantics and origin protection.

## Start with the hit and miss path

A cache keeps a reusable copy of a result closer to the next reader than the authoritative source. A **hit** returns a usable cached entry. A **miss** has no entry or finds one that policy will not serve, so the request reaches the origin. **Expiration** makes an entry too old under its freshness policy; **eviction** removes an entry to reclaim finite cache space. A refresh computes or fetches a newer value.

Caches can sit at several boundaries. A browser cache belongs to one client. A content delivery network (CDN) operates shared HTTP caches near clients and follows HTTP cache rules when deciding whether it may reuse a response. A service-local memory cache is fast but disappears with the process and is not shared across replicas. A networked application cache such as Redis gives several service replicas a shared entry space but adds a network dependency and its own capacity, eviction, and recovery behavior. A database buffer cache stores pages for the database engine; application code should not treat it as a business-level freshness contract.

In cache-aside, the application reads the cache, reads the authoritative source on a miss, then stores the result with a bounded lifetime. Two requests can miss together, and an update can make the cached copy stale, so this simple path still needs coalescing, invalidation, and failure behavior.

```text
read: cache lookup -> hit: return value
                   -> miss: read origin -> populate cache -> return value
write: commit authority -> invalidate or replace cached variants
```

## Put semantics in the cache key

The key must include every input that changes the representation: resource identity, authorization scope, locale, encoding, and version where applicable. A missing dimension can leak data or return the wrong variant.

Choose cache-aside, write-through, or explicit invalidation based on who owns the update. A time to live (TTL) is the interval after which a stored cache entry expires. It provides a repair bound for that cache copy, not an invalidation strategy by itself and not proof that the source value is recent.

## Define ownership for hit, miss, and invalidation

For each cached value, record the authoritative source, complete identity, acceptable stale age, TTL, invalidation trigger, and behavior when refresh fails. Authorization belongs in that contract. A shared entry containing tenant-specific fields must include the tenant and permission-relevant variant, or the service must cache only data safe for every caller represented by the entry.

Cache-aside lets the reader populate on a miss, which keeps the write path simple but permits a stale value until expiry or invalidation. Write-through updates the cache as part of the write path, adding another availability and ordering concern. Explicit invalidation can shorten stale windows, yet the message may arrive late or twice. Keep a finite TTL as a repair bound, and make an invalidation safe to repeat.

- Positive entries and negative 'not found' entries need separate TTL choices
- Large entries consume eviction budget even when their request count is low
- Versioned identities can make replacement atomic instead of mutating one shared value
- Cache failures should degrade to a planned origin rate, not an assumed infinite origin

## Trace the stale-fill race before choosing invalidation

Cache-aside contains a race even when the writer invalidates after committing. Start with an expired `order:817` entry:

```text
T1 reader: cache miss
T2 reader: database returns order version 18; reader pauses
T3 writer: commits order version 19 in the database
T4 writer: deletes order:817 from the cache
T5 reader: stores the older version 18 under order:817
```

The writer used the right commit-before-invalidate order, yet the cache now holds version 18 until another invalidation or expiry. The trouble is not a missed delete. A read that began earlier completed its fill after the delete.

One safeguard gives the cache key a monotonic generation. Suppose the reader observes generation 40 before its miss. The writer commits version 19, then atomically advances the cache generation to 41 and leaves that generation present even though the value is absent. The reader may populate version 18 only with a compare-and-set that still finds generation 40. It finds 41 instead, so the cache rejects the stale fill. Deleting both value and generation would recreate the original race because absence carries no evidence of the write.

A source version can serve the same purpose when it increases for every change to one entity. Store `{source_version: 19, value: ...}` or a version-19 tombstone, and accept a replacement only when its version is at least the last version known by the cache. Another design writes immutable keys such as `order:817:v19` and moves a small current-version pointer only forward. Use a database sequence, row version, or ordered log position rather than wall-clock timestamps, which can tie or move backward across machines.

Conditional population closes the pictured race only if the generation check and cache write form one atomic cache operation. It does not make the database commit and cache update one transaction. If the writer commits version 19 and crashes before advancing the cache generation, an old copy may remain; an outbox or change-data-capture invalidation plus a finite TTL supplies repair. A request that requires read-after-write can bypass the cache, carry the committed version and reject anything older, or read from the authority until the cache has observed that version.

Async invalidation needs an ordering rule too. Give each event a source position or per-entity version and retain the last applied position with the cache entry or tombstone. If invalidation position 104 arrives before position 103, applying 103 later must not move the cache backward. Delete and recreate operations need an entity incarnation or tombstone so a delayed event from the old lifetime cannot erase the new object.

TTL answers how long a cache copy may reside after population. It does not answer when the underlying fact last changed. A five-minute application-cache TTL applied now can wrap a database row last updated two years ago, or a version-18 response fetched from a lagging replica after version 19 already committed. Carry `source_version`, `source_updated_at`, or a source position when the product needs source age. HTTP cache age similarly describes the stored response's age under HTTP freshness rules, not the age of every business fact used to render it.

Serving stale data during an origin fault can be safer than returning no answer, but make that a per-representation contract. For example, `Cache-Control: max-age=60, stale-if-error=300` permits an HTTP cache to reuse a response for up to 300 seconds after it becomes stale when an eligible origin error occurs. The contract should name the maximum staleness, eligible failures such as a connection failure or selected 5xx response, excluded data such as authorization decisions, and how the response and metric expose stale service. Measure from the original freshness deadline; a failed refresh must not start a new 300-second window.

## Make one miss do the expensive work

When a popular entry expires, request coalescing lets one caller refresh while others wait or receive a stale value. Randomized TTLs prevent many keys from expiring on the same boundary; stale-while-revalidate keeps serving a bounded old answer during refresh.

## Name overload before choosing a control

**Offered load** is all work callers try to send. **Admitted load** is the portion the service accepts. **Capacity** is the rate the system can finish while meeting its latency and error target, not the highest rate observed during collapse. **Saturation** means a limiting resource such as CPU, memory, connections, workers, storage I/O, or a dependency quota has little usable headroom.

When arrivals exceed completions, work waits in a queue or is rejected. A queue can absorb a bounded burst, but sustained excess makes queue age grow without limit. Longer waits also hold connections and request memory, which can lower the completion rate and turn overload into a feedback loop. Backpressure asks an upstream producer to slow down; load shedding refuses selected work before it consumes the scarce resource.

Autoscaling may raise future capacity, but observation, scheduling, startup, and warm-up take time. Keep enough headroom for that delay, cap admission at the present safe rate, and decide which work loses first. A high-priority checkout and a best-effort recommendation refresh should not compete under one anonymous queue.

## A rate limit needs four nouns before an algorithm

A **rate limit** bounds how quickly a defined caller or workload may consume a defined kind of work. It is not just a number. Write down four parts:

- **Identity:** the subject being limited, such as a tenant, authenticated user, API key, source network, service, or endpoint
- **Cost unit:** what one token buys, such as one request, one uploaded MiB, one database query, or a weighted estimate of work
- **Steady rate:** how quickly new allowance becomes available
- **Burst capacity:** how much saved allowance can be spent at once

Limiting only by source IP can group many users behind one network address and can be evaded by an attacker with many addresses. Limiting only by account can let one expensive endpoint consume the same allowance as a cheap lookup. Authentication, product policy, and the resource being protected decide the useful key and cost unit.

A token bucket makes the rate and burst explicit. The bucket holds at most `B` tokens and refills at `R` tokens per second. An admitted operation removes its cost. If the bucket lacks enough tokens, the service rejects, delays, or routes the operation according to a stated policy. Saved tokens permit a bounded burst; they do not change the long-run refill rate.

Suppose one tenant receives `R = 100` request tokens per second and `B = 200`. After an idle interval the bucket contains 200 tokens. A burst of 160 one-token requests can enter immediately, leaving 40. Half a second later, refill adds 50, so 90 tokens are available. If 120 more requests arrive together, at most 90 enter under this bucket and 30 meet the over-limit policy. Over a long busy interval, admission approaches 100 requests per second even though the first burst was larger.

```text
initial allowance = 200 tokens
after 160 requests = 200 - 160 = 40 tokens
after 0.5 seconds = min(200, 40 + 100 * 0.5) = 90 tokens
next 120 requests = 90 admitted, 30 over limit
```

For HTTP, `429 Too Many Requests` communicates that a rate policy rejected the request. A response can include `Retry-After` when the server can give a useful retry time. That response is part of an API contract, not proof that the limiter protected the correct resource. Under a large attack, constructing a detailed response for every rejected request can itself consume the constrained capacity.

## Keep rate, concurrency, and fleet scope separate

A rate limit does not bound how much work is already running. At 100 admitted requests per second, a dependency latency increase from 100 milliseconds to 5 seconds raises average in-flight work from about 10 to about 500. Protect finite workers, connections, and memory with a concurrency limit or bounded queue as well as a rate policy. Rate controls arrival over time; concurrency controls simultaneous residence.

A process-local bucket also does not create a fleet-wide limit. If ten replicas each enforce 100 requests per second for the same tenant, the fleet may admit roughly 1,000. Common designs include:

- route one limiter key to one owner, which makes ownership and failover part of the contract;
- update a shared counter or bucket atomically, which adds a network dependency and hot-key risk;
- allocate bounded sub-quotas to replicas, which reduces coordination but permits temporary skew or unused allowance;
- enforce a coarse global policy at the edge and a tighter resource-specific limit near the dependency.

State whether a limiter fails open or closed when its shared state is unavailable. Failing open preserves requests but may lose the protected dependency. Failing closed preserves the dependency but can turn a limiter outage into a product outage. A bounded local emergency allowance can make that trade-off explicit instead of accidental.

Observe decisions by limiter key class and policy version without putting raw customer identifiers in metric labels. Record admitted cost, rejected cost, remaining allowance, retry volume, shared-state latency, fail-open or fail-closed events, and the saturation signal of the resource the limit is meant to protect. A flat rejection rate with rising dependency concurrency means the rate number or cost model is wrong; a healthy dependency with one tenant rejected continuously points to fairness or quota policy rather than capacity.

## See how a small hit-ratio drop reaches the origin

At 10,000 reads per second and a 95% hit ratio, the origin receives 500 requests per second. If a deployment changes the cache identity and the hit ratio falls to 80%, origin traffic becomes 2,000 RPS, already above the stated 1,200 RPS safe limit. One automatic retry per failed miss can push up to 4,000 attempts per second toward the same dependency while it is least able to respond.

Concurrency also grows with latency. At the safe limit and 200 ms service time, the origin holds about 240 requests in flight. If overload stretches service time to two seconds, the same admitted rate creates roughly 2,400 in-flight requests. Connection pools, request memory, and queues fill, which raises latency again. Admission control must reject before this feedback loop consumes every worker. Coalescing and stale service reduce refresh demand; they do not replace a hard cap on admitted origin work.

_A latency increase can exhaust concurrency even when admitted request rate stays flat._

```text
10,000 * (1 - 0.95) = 500 origin RPS
10,000 * (1 - 0.80) = 2,000 origin RPS
1,200 RPS * 0.20 s = 240 in flight
1,200 RPS * 2.00 s = 2,400 in flight
```

## Spend retries once

Retries add load to the dependency most likely to be struggling. Use a request deadline, exponential backoff with jitter, a cap on attempts, and a shared retry budget. Retry only operations whose semantics make repetition safe.

> **Multiplication, not addition.** If three layers each make four total attempts, one user action can create 64 attempts at the deepest dependency.

## Fail cheaply before the process fails expensively

Admission control and load shedding reject work before it consumes the scarce resource. A circuit breaker limits calls to a failing dependency and probes recovery. Shuffle sharding gives each tenant a small, different subset of workers so one pathological workload cannot touch the whole fleet.

## Separate cache trouble from origin trouble

Graph hit ratio, miss rate, stale responses, refresh starts, coalesced waiters, eviction reasons, and refresh errors by cache region and representation type. Then compare origin admitted rate, rejected rate, queue time, service time, pool occupancy, and retry attempts. A falling hit ratio before origin latency rises points to identity, eviction, or expiry. Stable hits with rising refresh duration points downstream.

Circuit-breaker state needs context: open count, reason, probe results, and time since the last successful call. A breaker that opens after queues are already full reacts too late, while one keyed too broadly can block healthy tenants with the failing cohort. Test overload controls with a bounded traffic slice. Confirm that rejected work returns the documented response, stale age remains inside policy, retry volume stays capped, and recovery probes cannot create a second surge when the dependency starts responding again.

> **Controlled recovery.** When the origin recovers, ramp admitted work. Releasing every queued waiter and half-open probe at once can reproduce the same overload.

## Continuing worked case: caching and overload protection

The cache stores only terminal order receipts, which no longer change under the order state machine. Entries live for five minutes and use `(tenant_id, order_id, version, representation)` as the key. Pending orders, status transitions, idempotency results, and outbox state always use PostgreSQL. This boundary lets a miss fall back safely without making the cache an authority or allowing one tenant to read another tenant's receipt.

Peak offered API load is 25,000 requests each second: 5,000 creates and 20,000 reads. The first global admission ceiling is 30,000 requests each second, providing 20% planned headroom rather than an unbounded application queue. Per-tenant token buckets stop the stated 20% hot tenant, or an accidental client loop, from consuming every worker. Create and valid status transitions receive the highest class, point reads come next, and recent-order lists shed first because callers can retry them without changing state.

The create path reserved only 50 ms of its 250 ms p99 budget for queueing and variance. At 5,000 peak creates each second, a 50 ms admission queue contains about 250 arrivals; requests beyond that bound receive `429` with `Retry-After` before taking a database connection. The client remains the sole retry owner and reuses its idempotency key. Recovery ramps admitted work while tracking queue wait, primary-pool occupancy, cache misses, unique successful operations, and attempts per operation.

## Summary

Caching permits bounded staleness to avoid repeated work; overload control refuses bounded work to preserve the rest of the service. Both need explicit identity, ownership, limits, and recovery behavior because an accidental miss storm or retry storm can turn a small fault into system-wide saturation.

- **Put every representation input in the cache key.** Resource, tenant or authorization scope, locale, encoding, and version can all change the answer. Missing one can return incorrect data or cross an isolation boundary.
- **Know which cache owns the copy.** Browser, CDN, process-local, shared application, and database caches have different readers, trust boundaries, failure behavior, and invalidation controls. A hit avoids origin work; a miss or expired entry invokes the defined fallback; eviction reflects finite capacity rather than business deletion.
- **Define freshness and invalidation ownership.** Record the authoritative source, allowed stale age, TTL, invalidation trigger, negative-entry policy, and refresh-failure behavior. Keep a finite TTL even with explicit invalidation so a lost message can repair itself.
- **Stop an old read from filling after a new write.** A reader can fetch version 18, pause while a writer commits version 19 and invalidates, then install version 18. Keep a monotonic generation, source version, or event position and make population conditional so an older fill cannot replace newer knowledge.
- **Do not confuse TTL with source age.** A TTL bounds residence after cache population; it does not reveal when the underlying fact changed. Carry source version or time separately, and permit stale-if-error only for named failures, representations, and a fixed stale window.
- **Collapse simultaneous misses.** Request coalescing lets one caller refresh while peers wait or receive bounded stale data; TTL jitter spreads expirations. These controls lower refresh bursts but do not replace an origin admission limit.
- **Convert hit ratio into origin pressure.** At 10,000 reads/s, a drop from 95% to 80% hits raises origin traffic from 500 to 2,000 RPS. At 1,200 admitted RPS, latency growth from 0.2 s to 2 s raises average in-flight work from 240 to 2,400 by Little's Law.
- **Define every rate limit as identity, cost, rate, and burst.** A token bucket with rate `R` and capacity `B` permits saved allowance to absorb a bounded burst while limiting long-run admission. Process-local buckets multiply across replicas unless ownership, shared state, or bounded sub-quotas create a fleet-wide contract. Rate limits and concurrency limits protect different dimensions.
- **Spend retries at one layer.** Carry a deadline, cap attempts, add jitter, and retry only safe operations. Admission control sheds before scarce pools fill; a circuit breaker limits calls while a dependency is failing; shuffle sharding bounds which tenants share a failure.
- **Diagnose miss, origin, and recovery separately.** Correlate hit ratio, evictions, refreshes, coalesced waiters, origin queueing, pool occupancy, rejections, and retry attempts. Ramp half-open probes and admitted work after recovery so queued callers do not recreate the overload.

## References

- [RFC 9111: HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
- [RFC 5861: HTTP Cache-Control Extensions for Stale Content](https://www.rfc-editor.org/rfc/rfc5861.html): Defines stale-while-revalidate and stale-if-error with bounded stale windows.
- [Amazon Builders' Library: Timeouts, Retries, and Backoff with Jitter](https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/)
- [Amazon Builders' Library: Making Retries Safe with Idempotent APIs](https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/)
- [Google SRE: Handling Overload](https://sre.google/sre-book/handling-overload/)
- [Amazon Builders' Library: Workload Isolation Using Shuffle Sharding](https://aws.amazon.com/builders-library/workload-isolation-using-shuffle-sharding/)
- [Azure Architecture Center: Circuit Breaker Pattern](https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker)
- [RFC 6585: 429 Too Many Requests](https://www.rfc-editor.org/rfc/rfc6585.html#section-4): Defines the HTTP response and optional `Retry-After` behavior without prescribing how a server identifies or counts a caller.
- [Amazon API Gateway: HTTP API throttling](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-throttling.html): Documents a token-bucket implementation with separate steady-rate and burst settings and notes that service throttles are targets rather than absolute ceilings.
- [Kubernetes: API Priority and Fairness](https://kubernetes.io/docs/concepts/cluster-administration/flow-control/): Shows concurrency isolation, bounded queues, fair queuing, shuffle sharding, and rejection as separate overload controls.

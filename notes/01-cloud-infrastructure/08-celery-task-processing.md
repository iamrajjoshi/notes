---
title: Celery task processing under failure
shortTitle: Celery
description: Design background tasks around brokers, acknowledgements, retries, visibility, prefetch, idempotency, and poison work.
collection: cloud-infrastructure
slug: celery-task-processing
order: 8
number: CI8
duration: 110 min
difficulty: Core
tags:
  - Celery
  - Valkey
  - acknowledgements
  - idempotency
  - backpressure
---

## Working model

A Celery message is a lease on work, not proof of completion. The acknowledgement boundary decides whether a crash loses, repeats, or stalls that work.

## Questions this note answers

- Separate Celery's broker, workers, task state, and optional result backend
- Choose acknowledgement and retry behavior for crash-safe tasks
- Control prefetch, scheduled-task memory, concurrency, timeouts, and queue isolation
- Explain when a task queue fits better than a retained event log

## Start with one background job

Suppose an HTTP request asks for a large export. Generating it inside the request may exceed the caller's deadline and consume a web process for minutes. With Celery, the web application sends a small message naming an export task and its arguments. A broker stores that message until a Celery worker reserves it. The worker calls the registered Python task, writes the export to durable storage, and acknowledges the message according to the configured policy.

Celery is the task framework and worker runtime; it is not the broker. A deployment also chooses a broker transport such as RabbitMQ or Redis-compatible storage, and may choose a separate result backend. Broker choice changes acknowledgement, visibility, monitoring, and failure behavior.

| Term               | Meaning                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Task               | A named function registered with Celery for asynchronous execution                                                  |
| Producer or client | Application code that serializes a task name and arguments and sends the message                                    |
| Broker             | The external message system that stores and delivers queued work                                                    |
| Queue              | A broker-side destination used to route work to an eligible worker pool                                             |
| Worker             | A Celery process that reserves messages and executes registered task code, often through child processes or threads |
| Acknowledgement    | The signal that moves a delivered message past its broker recovery boundary                                         |
| Retry              | A new scheduled attempt after a handled failure; it does not roll back the prior attempt                            |
| Result backend     | Optional storage for task state or return values; it is not the broker queue                                        |

The message should usually contain a stable identifier such as an export ID, not a large object snapshot or secret. The worker reloads current state, checks whether the semantic work already finished, and records completion under an idempotency rule.

## The broker carries work; the backend records results

A producer serializes a task name and arguments into a broker message. Workers reserve messages and execute registered task code. An optional result backend stores state or return values; it isn't the queue and shouldn't become an accidental database for large payloads.

Pass stable identifiers rather than stale object snapshots. The task should reload current state, check whether work already completed, and write progress transactionally when possible. That makes delayed and repeated execution less dangerous.

> **Fictional case.** The bookshop runs one `export-worker` Deployment for long report jobs and another `email-worker` Deployment for short messages. Both use Celery, but separate queues, concurrency, memory limits, and shutdown budgets keep a ten-minute export from occupying every email slot.

## Join a fictional worker Deployment to its task contract

The bookshop's HTTP handler creates an export row with a unique `export_id`, commits it, then dispatches `reports.generate(export_id)`. Celery routing sends that task to the `exports` queue. The `export-worker` Deployment starts Celery with that queue allowlist, exposes worker health through a separate probe process, requests enough memory for one export per child, and allows a bounded drain interval before Kubernetes terminates it. These names and values exist only in the exercise.

The task reloads the export row, claims it with a conditional database update, and writes the resulting object under the same `export_id`. If the result already exists, a repeated attempt records completion without writing another object. Temporary object-store errors retry with a cap and jitter; invalid export parameters mark the row failed without retry. Celery delivery state and the export row answer different questions, so the status API reads the application row rather than promising that a broker acknowledgement means the report exists.

_A task definition and worker Deployment form one operating path, but they fail at different boundaries._

```text
POST /exports → commit export row → reports.generate(export_id) → exports queue
exports queue → export-worker reservation → conditional claim → object write
object write + completion row → acknowledgement
crash before acknowledgement → redelivery → same export_id → idempotency check
```

## Late acknowledgement requires idempotent work

Early acknowledgement can lose work if the worker dies after acknowledging but before finishing. Late acknowledgement shifts common crash paths toward redelivery, so the task may run more than once. But `acks_late` alone does not requeue every abrupt child-process exit: Celery acknowledges those by default. `task_reject_on_worker_lost` can request requeue instead, at the risk of a poison task creating a message loop. Every external side effect still needs its own idempotency guard.

Retry schedules another attempt; it doesn't erase a partial first attempt. Use bounded retries with backoff and jitter for transient errors, reject permanent input errors, and apply I/O timeouts inside the task. An infinite retry loop turns one bad message into standing load.

## Prefetch can hide the queue in the wrong worker

A worker may reserve more messages than it can run immediately. High prefetch suits short, uniform tasks but lets one worker hoard long jobs while peers idle. Lower prefetch improves fairness for long work, with a throughput trade-off. Celery 5.6 can disable broker prefetch while retaining early acknowledgement through `worker_disable_prefetch`, but that option currently works only with a Redis-compatible broker.

ETA and countdown tasks are different: workers hold them in memory until their scheduled time, and ordinary prefetch limits do not constrain that set. Celery 5.6 adds `worker_eta_task_limit` to cap how many one worker holds. A database-backed periodic schedule is a better fit than placing a very distant one-off task in broker visibility limbo.

Separate queues when task duration, memory, priority, or dependency limits differ. Cap concurrency against the downstream system, recycle children that retain memory, and monitor queue age alongside depth. Dead-letter handling may be a broker feature or an application quarantine path; Celery doesn't make poison work disappear.

Redis-compatible transports use a visibility timeout. If a task remains unacknowledged past that timeout, the broker can redeliver it while the first copy still runs; ETA or retry delays longer than the timeout can repeat in a loop. Raising the timeout delays recovery of truly lost work, so match the task design, broker setting, worker-loss behavior, and scheduling mechanism instead of treating one large timeout as a fix.

> **Fictional case.** The `export-worker` uses late acknowledgement and a prefetch multiplier of one because jobs last minutes and can repeat safely by `export_id`. The `email-worker` uses a separate policy for short jobs. Copying either setting without its broker and task contract would be a configuration error.

## Celery distributes commands; Kafka retains an event history

Celery fits a command such as generate this export, with task routing, retries, and a worker result. Kafka fits a durable ordered event stream that multiple independent consumer groups can replay. Both can deliver duplicates, but they expose different retention, ordering, fan-out, and progress models.

Don't use a result backend as an event log, and don't force a simple command queue into Kafka solely because Kafka already exists. Start with the recovery behavior the product needs.

## Reservation count can exceed execution slots

Take a late-acknowledging worker with concurrency 8 and a prefetch multiplier of 4. Its quality-of-service prefetch count can allow up to 32 unacknowledged task reservations, subject to transport behavior, while only eight process slots execute at once. If the first reserved tasks each run for ten minutes, up to 24 other reservations can sit inside that worker instead of being available to a peer. Reducing the multiplier toward one limits hoarding for long work; short uniform tasks may lose some throughput because workers have less work ready locally.

Now let a late-acknowledged task write an external result and then lose its worker process before the acknowledgement reaches the broker. Depending on transport and worker-loss settings, the message may return for another attempt. The second run must detect the existing result through a semantic idempotency key and finish without repeating the external effect. A timeout or retry does not undo the first process, so pass the same key to a downstream API that supports idempotency and store completion under a uniqueness constraint when possible.

_Inspect the pinned Celery and broker transport because acknowledgement and reservation behavior differ by configuration._

```text
late acknowledgement, concurrency = 8
prefetch multiplier = 4
prefetch count = 32 unacknowledged reservations
execution slots = 8
reserved but not executing <= 24 in this simplified snapshot
```

### Diagnosis signals

Compare broker depth and oldest-message age with workers' active, reserved, and scheduled task counts. Add task runtime, retry reason, worker heartbeats, child exits, memory, downstream latency, and acknowledgement errors. A deep broker with idle slots points somewhere different from a shallow broker with many long-held reservations.

## Summary

Celery distributes commands through a broker and treats acknowledgement as the recovery boundary. Task code must remain safe under delay, retry, redelivery, and partial completion because no acknowledgement setting can undo an external effect.

- The broker holds work; workers execute registered task code; an optional result backend stores task state or return values. The result backend is not the queue or an event log.
- Early acknowledgement can lose work after a worker crash. Late acknowledgement favors redelivery, which means the same task may run more than once.
- Late acknowledgement does not requeue every child-process loss by default. `task_reject_on_worker_lost` changes that boundary and can also create poison-message loops.
- Retries schedule another attempt; they do not reverse the first attempt. Use bounded backoff with jitter, I/O timeouts, and a semantic idempotency key for external effects.
- Approximate unacknowledged reservations as worker concurrency × prefetch multiplier, subject to transport behavior. With concurrency 8 and multiplier 4, up to 32 reservations may sit behind only 8 execution slots.
- Lower prefetch improves fairness for long jobs; higher prefetch can help short uniform jobs. Separate queues when duration, memory, priority, or downstream limits differ.
- Scheduled ETA/countdown tasks are held in worker memory outside ordinary prefetch limits. Celery 5.6 can cap them with `worker_eta_task_limit`, and can disable Redis broker prefetch with `worker_disable_prefetch`.
- A Redis visibility timeout shorter than execution or delay can redeliver a live task; a much longer timeout slows recovery after real worker loss.
- Celery fits routed commands and worker results. Kafka fits a retained, replayable event history with independent consumer groups.
- Compare queue depth and oldest-message age with active, reserved, and scheduled tasks, runtime, retries, worker exits, memory, downstream latency, and acknowledgement errors.

## References

- [Celery first steps](https://docs.celeryq.dev/en/stable/getting-started/first-steps-with-celery.html)
- [Celery tasks](https://docs.celeryq.dev/en/stable/userguide/tasks.html)
- [Celery optimizing guide](https://docs.celeryq.dev/en/stable/userguide/optimizing.html)
- [Celery configuration and defaults](https://docs.celeryq.dev/en/stable/userguide/configuration.html)
- [Celery Redis transport notes](https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html)
- [Celery workers guide](https://docs.celeryq.dev/en/stable/userguide/workers.html)
- [Kubernetes pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination)

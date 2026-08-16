# ADR-0004 — Jobs in Postgres by default

- **Status:** accepted
- **Date:** 2026-08-16
- **Affects:** `apps/api/src/queue/`, `apps/api/src/db/schema/jobs.ts`, `apps/api/src/worker.ts`, `docs/features/queue.md`

## Context

The template needed background work: sending an invitation email without holding the request open, and running the cleanups whose own comments had been asking to be scheduled. That is a queue, and a queue is a choice of transport.

Four were real candidates.

**Redis, through BullMQ.** The industry default, and genuinely better at being a queue: delayed jobs, backoff, concurrency limits, stalled-job recovery and rate limiting are all solved, tested and fast. It costs a second stateful service — one more thing to run in development, provision in production, monitor, back up (or deliberately not back up) and reason about when it is the half of the system that is down.

**Postgres, as a table.** The database is already there, already backed up, already in every developer's `make up`. `FOR UPDATE SKIP LOCKED` has been the documented way to write a queue since Postgres 9.5, and it is roughly twenty lines of SQL. It is slower than Redis by a wide margin and it puts write traffic on the database that carries the application's own.

**`pg-boss`.** The same transport, packaged. It would have meant a second Postgres queue beside the one the `mail_messages` outbox already implies, its own schema and its own migration story alongside Drizzle's, and its own opinions about a `jobs` table we wanted the console to be able to list.

**A hosted queue** (SQS, Cloud Tasks, Inngest). The right answer for a large system and the wrong one for a template: it cannot be run offline, it cannot be run in CI without credentials, and it makes the first thirty seconds of a fresh clone depend on somebody's account.

The deciding question was not which is fastest. It was **what a fresh clone must be able to do with no infrastructure beyond the one container it already starts**, and what the first background job in a real project actually needs.

The answer to the second part is what settled it. Almost every early job is a consequence of a database change: this user was invited, so send them an email. With Redis the enqueue cannot be part of that change's transaction, so the ordering has to be arranged by hand — and the failure mode is an email about an account that does not exist because the insert rolled back a moment later. With a table it is one commit.

## Decision

**`QUEUE_DRIVER=database` is the default**, and the `jobs` table is a first-class part of the schema rather than an implementation detail. Three drivers sit behind one environment variable:

- **`database`** — poll, claim with a single `UPDATE … FOR UPDATE SKIP LOCKED` inside a CTE, run, record. **`push` inserts through the caller's `tx`**, which makes it a transactional outbox with no second system to keep in step.
- **`redis`** — BullMQ, loaded through `await import()` so a Postgres-only deployment never parses it or `ioredis`. For when the queue is the bottleneck.
- **`sync`** — runs the handler inline, awaited, and rethrows. What the test suite uses.

Three properties of that split are load-bearing:

- **`transactional` is a flag on the driver, not a promise made to the caller.** Every `enqueue` inside a transaction passes both `tx` and `defer`; the driver honours whichever it can. The call site says "this job belongs to this change" once, and does not change when `QUEUE_DRIVER` does.
- **The `jobs` table is the failure store for every driver.** The redis driver mirrors terminal failures into it, so one Jobs page tells the same story whatever is carrying the work. Successes are not mirrored — putting every job through Postgres anyway is the entire cost that driver exists to avoid.
- **The worker is a second entrypoint, not a flag.** `src/worker.ts` runs the same `startWorker()` as `src/index.ts` does under `WORKER_IN_PROCESS`, which is on in development and off everywhere else.

## Consequences

**A fresh clone has a working queue.** `make up`, `make dev`, and an invitation is sent through a job. Nothing to install, nothing to configure, nothing to sign up for.

**An enqueue can be part of a commit, and by default is.** The property that removes a whole category of bug — the side effect for a change that did not happen — is the default rather than something to be arranged.

**Job history is a table.** It survives a restart, it is queryable in `psql`, it is on the Jobs page with `last_error`, and it is in the same backup as everything else. A failed job is not a line in a log that has rotated away.

**The queue competes with the application for the database.** This is the real cost. The claim query is one statement against a partial index, the poller sleeps a second when it finds nothing, and none of that is free. At a few jobs per second it is invisible; at a few hundred it is the reason `QUEUE_DRIVER=redis` exists, and switching is one environment variable and a `REDIS_URL`.

**Polling means latency.** A job enqueued a moment after a poll waits up to `QUEUE_POLL_MS` — one second by default. BullMQ blocks on the queue and starts within milliseconds. For work that happens because a request happened, one second is not the part anybody notices; for work a person is watching, it is, and that is a reason to choose the other driver.

**Choosing `redis` gives up the transactional enqueue.** That driver dispatches after the commit, so a crash in the window between them loses the job. Anything that must not be lost needs a record of its own — which is why `mail_messages` is written inside the transaction and why `mail.sweep-stuck` exists. See [ADR-0005](ADR-0005-transactional-outbox-for-mail.md).

**We maintain a queue.** Backoff, jitter, stale-job reaping, dedupe keys and the claim query are ours to get right, and BullMQ has years of production behind its versions of them. The mitigation is that the surface is small and the whole of it is tested against a real Postgres — including two drivers claiming concurrently, which is the test that justifies the SQL.

**The sync driver rethrows, so a failing job fails a test.** A driver that swallowed the error there would let every suite pass while production burned.

## What would change this

**Sustained throughput.** When the claim query shows up in `pg_stat_statements`, or the poll interval becomes the latency somebody complains about, set `QUEUE_DRIVER=redis`. That is the migration, and it is why the driver ships now rather than being a rewrite later.

**Fan-out to many workers on many machines.** Postgres handles this correctly through `SKIP LOCKED`, but every worker polling is load the database did not have before. Redis is better at it.

**Work that is not a consequence of a database change** — a webhook fan-out, a scheduled export, anything where the transactional enqueue buys nothing. The argument above simply does not apply, and the choice comes down to throughput.

**A second application sharing the queue.** A `jobs` table another service reads is a shared database, which is a worse coupling than a shared broker. Move to Redis, or to a hosted queue, before that becomes normal.

This ADR would be **superseded**, not amended, if the default flipped. The three-driver shape is the thing worth keeping either way.

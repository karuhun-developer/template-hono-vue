# Queue

Work that must happen, but not while somebody is waiting for a response.

| Concern             | File                                |
| ------------------- | ----------------------------------- |
| Enqueueing          | `apps/api/src/queue/queue.ts`       |
| Starting the loop   | `apps/api/src/queue/worker.ts`      |
| The worker process  | `apps/api/src/worker.ts`            |
| The catalog of jobs | `apps/api/src/queue/registry.ts`    |
| Handlers            | `apps/api/src/queue/jobs/`          |
| The `jobs` table    | `apps/api/src/db/schema/jobs.ts`    |
| Row access          | `apps/api/src/queue/queue.repo.ts`  |
| Drivers             | `apps/api/src/queue/driver/`        |
| Listing and control | `apps/api/src/queue/queue.admin.ts` |
| The HTTP face       | `apps/api/src/modules/jobs/`        |

## Enqueueing

```ts
await enqueue('sessions.prune', {})
```

That is the whole API. The name is checked against the catalog at compile time, the payload
is checked against that job's schema, and which driver carries it is configuration.

The one thing the caller does have to decide is **when the job becomes real**:

```ts
await transaction(async (tx, defer) => {
  const user = await createUser(tx, input)
  await enqueue('mail.send', { userId: user.id }, { tx, defer })
})
```

Pass both. Which one is used depends on the driver, and that is the point — the call site
says "this job belongs to this change" and the driver honours it as well as it can.

| Option        | Meaning                                                             |
| ------------- | ------------------------------------------------------------------- |
| `tx`          | The caller's transaction. Used by a driver that can join it.        |
| `defer`       | The caller's post-commit hook. Used by every driver that cannot.    |
| `delayMs`     | Do not run before this long from now.                               |
| `runAt`       | Do not run before this instant.                                     |
| `maxAttempts` | Overrides the job's default, which overrides `QUEUE_MAX_ATTEMPTS`.  |
| `dedupeKey`   | At most one live job per key. A second enqueue is silently dropped. |

## Drivers, and what each one guarantees

| `QUEUE_DRIVER` | Runs where         | Enqueue joins the transaction | Retries | Rows in `jobs` |
| -------------- | ------------------ | ----------------------------- | ------- | -------------- |
| `database`     | the worker         | **yes**                       | yes     | yes            |
| `redis`        | the worker         | no — dispatched after commit  | yes     | failures only  |
| `sync`         | the caller, inline | no — it is the caller         | no      | no             |

### `database`

The default, and the first column of that table is why. `push` inserts through the caller's
`tx`, so the row that changed and the job that acts on it commit together or not at all.
That is a transactional outbox with no second system to keep in step, and it removes the
failure that produces an email about an account that does not exist because the insert
rolled back a moment later.

### `redis`

BullMQ, loaded through `await import()` so a Postgres-only deployment never parses it.
Choose it when the queue is the bottleneck: delayed jobs, backoff, concurrency limits and
stalled-job recovery are BullMQ's, not ours, and Redis does them faster than a table.

What it costs is the first column of that table. This driver **cannot join a Postgres
transaction**, so `enqueue` goes through `defer` and the job is dispatched after the commit.
The window that leaves — a crash between the commit and the dispatch — loses the job. For
mail that hole is closed by the `mail_messages` row, which is written inside the transaction,
and the `mail.sweep-stuck` schedule that re-enqueues anything still `queued`. A job with no
such record is a job this driver can lose, and that is the trade being made.

Two details worth knowing before reading the file:

- **A terminal failure is mirrored into `jobs`.** BullMQ's own failure records live in
  Redis, expire with `removeOnFail`, and go with the server — so the Jobs page would
  otherwise show a different history depending on `QUEUE_DRIVER`. Successes are **not**
  mirrored: putting every job through Postgres anyway is the entire cost this driver exists
  to avoid.
- **A dedupe key is percent-escaped into a BullMQ job id.** BullMQ builds its Redis keys by
  joining on `:` and rejects a custom id containing one — and every key the scheduler
  produces is `<schedule>:<fired_for>`.

> **The BullMQ gotcha.** A connection given to a `Worker` must be created with
> `maxRetriesPerRequest: null`. A worker blocks on `BZPOPMIN` for seconds at a time, ioredis
> counts a blocked command as a request that has not answered, and at the default of twenty
> retries it gives up. BullMQ refuses to start without the option — but the error it throws
> names neither the option nor ioredis, so the search that follows is a long one.

Redis is behind a compose profile, because the defaults do not need it:

```bash
make up-redis   # Postgres 7332 · Redis 7379
```

### `sync`

Runs the handler inline, awaited, and **rethrows**. It is what the test suite uses, which
means a suite asserting an endpoint's effect fails when the job behind it throws — a driver
that swallowed the error there would let every suite pass while production burned. It writes
no rows, so there is nothing to list, retry or reap; anything that reads the job list says
so rather than rendering an empty table that looks broken.

It is also **not** transactional, despite running inside the caller's call stack: a handler
running inside the transaction would see rows nobody else can see yet, and a rollback would
undo work that had already left the process. `enqueue` therefore routes it through `defer`.

## The catalog

`registry.ts` is a single `as const satisfies` object, the same idiom as `PERMISSIONS`:

```ts
export const JOBS = {
  'sessions.prune': { payload: NO_PAYLOAD, handler: pruneSessionsJob },
} as const satisfies JobCatalog
```

`JobName` and `JobPayload<N>` are derived from it, so `enqueue('sesions.prune', …)` is a
compile error rather than a row nobody ever claims.

> **Payloads are JSON, and only JSON.** A `Date` goes into `jsonb` as a string and comes
> back as a string. Every payload schema uses `z.iso.datetime()` or an id, never `z.date()`.
> Getting this wrong looks exactly like a bug inside the handler.

The payload is validated **twice**, deliberately:

- **On enqueue**, so a bad payload fails inside the caller's transaction and takes the whole
  change with it — rather than surfacing three retries later in a worker log.
- **On dequeue**, because a row can be older than the code that reads it. A row whose stored
  payload no longer parses is failed **terminally**: a retry would re-read the same bytes.

A row naming a job this build has no handler for is failed terminally for the same reason —
the handler will not be registered on the second attempt either, and three tries would turn
one confusing log line into three.

## The loop

The `database` driver's, specifically — `redis` has BullMQ's, and `sync` has none.

Claim → run → record, and back round. When a batch comes back full the poller goes straight
round again; only an empty claim waits `QUEUE_POLL_MS`.

```sql
WITH claimed AS (
  SELECT id FROM jobs WHERE status = 'pending' AND run_at <= now()
  ORDER BY run_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
)
UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $1
WHERE id IN (SELECT id FROM claimed) RETURNING …
```

This is the only hand-written SQL in the repository, and every part of it is load-bearing:

- **One statement.** A `SELECT` followed by an `UPDATE` leaves a window in which a second
  worker sees the same rows.
- **`FOR UPDATE SKIP LOCKED`.** Without `SKIP LOCKED` the second worker blocks on the first
  worker's rows and then runs them the moment it commits. This is the whole concurrency
  story, and it is why the queue suite needs a real Postgres rather than a mock.
- **`attempts` increments at claim time**, not at completion. A worker that dies mid-job has
  still spent an attempt, so a job that reliably kills its worker eventually stops instead
  of being retried forever.
- **`jobs_claim_idx` is partial** on `status = 'pending'`, in the order the claim sorts by.
  A table full of finished jobs must not slow down finding the next pending one.

A failed attempt goes back to `pending` with `run_at = now() + min(1000 * 2^(attempt-1),
300_000)` **± 20 %**. The jitter is not cosmetic: a hundred jobs that failed together
because one dependency was down would otherwise all come back at the same instant and take
it down again.

At `max_attempts` the row lands `failed` and **is kept**. A queue that deletes what went
wrong has no answer to "what went wrong".

> **The poller is a self-rescheduling `setTimeout`, not `setInterval`.** An `async` callback
> handed to `setInterval` returns a promise nothing awaits, so a slow tick overlaps the next
> one — `no-misused-promises` and `no-floating-promises` both say so. Rescheduling from the
> settlement of the previous tick makes overlap impossible by construction. The timer is
> `.unref()`'d, so an idle poll is never the reason a process refuses to exit.

## Administering jobs

`modules/jobs/` is the queue's HTTP face, behind two owner-only keys — `job.read` to look,
`job.manage` to change.

| Method | Path               | Permission   |
| ------ | ------------------ | ------------ |
| `GET`  | `/jobs`            | `job.read`   |
| `POST` | `/jobs/:id/retry`  | `job.manage` |
| `POST` | `/jobs/:id/cancel` | `job.manage` |

There is **no create endpoint**, and there will not be one. A job is enqueued by the code
that knows what its payload means; an HTTP door onto `enqueue()` would be a way to run
arbitrary catalog handlers with arbitrary arguments, which is a much larger permission than
"retry the thing that just failed".

Both transitions are narrow, and both refuse loudly rather than doing something
approximate:

- **Retry** takes a `failed` or `cancelled` job back to `pending` with `attempts` reset to
  zero and `last_error` **kept**. Zero rather than "one more", because the button is pressed
  after somebody has fixed the cause, and a job given one attempt out of an already-spent
  budget would fail again immediately. A `running` job is refused with a `409`: requeueing a
  claimed row hands the same payload to a second worker while the first is still inside the
  handler, which is the one thing the claim query exists to prevent.
- **Cancel** applies only to a job that has not started, and lands it `cancelled` rather
  than `failed`. One is a decision and the other is a problem; a page that cannot tell them
  apart sends people looking for a bug that is not there.

Both are audited inside the transaction that makes the change, like every other write here.

### What each driver can offer

`QueueAdmin` is a **separate interface from `QueueDriver`**. Running a job and answering
"what happened to it" have different shapes — a claim loop against a paged list — and a
driver forced to implement both would be two objects sharing a name.

| `QUEUE_DRIVER` | `coverage` | `manageable` | What the list means                                      |
| -------------- | ---------- | ------------ | -------------------------------------------------------- |
| `database`     | `all`      | yes          | The table **is** the queue                               |
| `redis`        | `failures` | no           | The mirrored record of jobs that died                    |
| `sync`         | `none`     | no           | Nothing ran anywhere but inline, and nothing was written |

`coverage` and `manageable` travel in the list response, so the console states which of the
three it is looking at instead of rendering an empty table beside a pager. Under `sync` the
page says _"Jobs run inline in this configuration, so there is nothing to list"_ — honest,
rather than something that looks broken.

`names` travels with them: the `JOBS` catalog, so the page's Job facet is this list rather
than a second copy of it in the console. The filter itself still takes a bounded string,
because a row whose name has since left the catalog is exactly the row somebody is looking
for — the facet offers what exists, the query accepts what existed.

The `redis` admin is deliberately read-only. A row there is a **copy** of something that
already died inside BullMQ: flipping it back to `pending` would change nothing in Redis,
where the queue actually is, and would leave a row claiming to be queued that no worker will
ever look at. Re-running that work is `enqueue()` from a call site that knows what the
payload means, and a BullMQ dashboard is the tool for the live queue.

## Stale jobs

A row still `running` with a `locked_at` older than `QUEUE_STALE_AFTER_MINUTES` belonged to
a worker that died — a live one finishes or fails in seconds. `reap()` puts it back to
`pending`, keeping the attempt it already spent.

## Running the worker

```bash
make dev      # api :7300 · console :7301, with the worker inside the API process
make worker   # the worker on its own, for when WORKER_IN_PROCESS is off
```

`src/worker.ts` is a second entrypoint rather than a flag on the first, because the two have
different reasons to be restarted and different reasons to be scaled. An API replica that
also claimed jobs would multiply the workers every time the API was scaled out for traffic —
the opposite of what more traffic asks for.

`WORKER_IN_PROCESS` is **on in development and off everywhere else**, so `make dev` stays one
terminal while production runs the two separately by default. Both entrypoints go through
`startWorker()` in `queue/worker.ts`, so the decisions they share — is there anything for a
worker to claim, has one already been started — are written once.

The worker holds a `setInterval` it never uses. That is not an oversight: the poll timer is
`.unref()`'d on purpose, so without a handle of its own the process would start, find nothing
to claim, and exit as though it had finished. The line says out loud that the process is
alive because it is a worker.

### Shutting down

Shutdown tasks run in **reverse registration order**, and the ordering here is bought by
imports rather than by remembering:

```text
1. the HTTP server stops accepting requests   (registered last  → runs first)
2. the worker stops claiming, and waits       QUEUE_SHUTDOWN_GRACE_MS
3. the pool closes                            (registered first → runs last)
```

Step 2 before step 3 is the one that matters: close the pool first and the last job in flight
dies mid-write. When the grace period runs out the handlers still going are told through
`ctx.signal` that nobody is waiting any more, and the rows they were holding stay `running`
until `reap()` hands them to somebody else. The grace is deliberately below the shutdown
registry's own ten-second patience, so the warning it logs is one somebody actually sees.

## Adding a job

1. Write the handler in `queue/jobs/`. It takes `(payload, ctx)` and returns `Promise<void>`.
2. Add the payload schema and the handler to `JOBS` in `registry.ts` — JSON-only fields.
3. Set `maxAttempts` on the definition if the default of three is wrong for it.
4. Call `enqueue(name, payload, { tx, defer })` from inside a `transaction()`.
5. Test it through the `sync` driver, by asserting the **effect** rather than a row.

## Conventions

- Nothing calls a handler directly. `enqueue` is the door, so validation and the retry
  accounting cannot be skipped.
- A job is **idempotent**, because a retry after a half-finished attempt is normal.
- Background work has no request, so it logs through `ctx.logger` — never `c.get('logger')`,
  which does not exist outside a handler.
- A payload carries **ids, not rows**. A row copied into a payload is a row that has changed
  by the time the job runs.
- A handler that must clean something up before giving up compares `ctx.attempt` with
  `ctx.maxAttempts`. That is the only signal it gets that this attempt is the last one —
  `mail.send` uses it to drop a token that must not outlive its send.
- The API never calls `queue.start()`. An API replica that quietly began claiming jobs is a
  second worker nobody asked for.

## Settings

| Variable                    | Default    | Notes                                            |
| --------------------------- | ---------- | ------------------------------------------------ |
| `QUEUE_DRIVER`              | `database` | `sync` in the test suite                         |
| `REDIS_URL`                 | unset      | Required as soon as `QUEUE_DRIVER=redis`         |
| `QUEUE_POLL_MS`             | `1000`     | Only applies when the last claim found nothing   |
| `QUEUE_CONCURRENCY`         | `5`        | Jobs claimed per batch by one worker             |
| `QUEUE_MAX_ATTEMPTS`        | `3`        | A job definition may override it                 |
| `QUEUE_STALE_AFTER_MINUTES` | `15`       | After this, a `running` row is assumed abandoned |
| `QUEUE_SHUTDOWN_GRACE_MS`   | `8000`     | How long a stopping worker waits for its jobs    |
| `WORKER_IN_PROCESS`         | dev only   | Run the worker inside the API process            |

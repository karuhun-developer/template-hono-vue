# Queue

Work that must happen, but not while somebody is waiting for a response.

| Concern             | File                               |
| ------------------- | ---------------------------------- |
| Enqueueing          | `apps/api/src/queue/queue.ts`      |
| Starting the loop   | `apps/api/src/queue/worker.ts`     |
| The worker process  | `apps/api/src/worker.ts`           |
| The catalog of jobs | `apps/api/src/queue/registry.ts`   |
| Handlers            | `apps/api/src/queue/jobs/`         |
| The `jobs` table    | `apps/api/src/db/schema/jobs.ts`   |
| Row access          | `apps/api/src/queue/queue.repo.ts` |
| Drivers             | `apps/api/src/queue/driver/`       |

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
| `sync`         | the caller, inline | no — it is the caller         | no      | no             |

`database` is the default, and the first column of that table is why. `push` inserts
through the caller's `tx`, so the row that changed and the job that acts on it commit
together or not at all. That is a transactional outbox with no second system to keep in
step, and it removes the failure that produces an email about an account that does not
exist because the insert rolled back a moment later.

`sync` runs the handler inline, awaited, and **rethrows**. It is what the test suite uses,
which means a suite asserting an endpoint's effect fails when the job behind it throws — a
driver that swallowed the error there would let every suite pass while production burned.
It writes no rows, so there is nothing to list, retry or reap; anything that reads the job
list says so rather than rendering an empty table that looks broken.

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
- The API never calls `queue.start()`. An API replica that quietly began claiming jobs is a
  second worker nobody asked for.

## Settings

| Variable                    | Default    | Notes                                            |
| --------------------------- | ---------- | ------------------------------------------------ |
| `QUEUE_DRIVER`              | `database` | `sync` in the test suite                         |
| `QUEUE_POLL_MS`             | `1000`     | Only applies when the last claim found nothing   |
| `QUEUE_CONCURRENCY`         | `5`        | Jobs claimed per batch by one worker             |
| `QUEUE_MAX_ATTEMPTS`        | `3`        | A job definition may override it                 |
| `QUEUE_STALE_AFTER_MINUTES` | `15`       | After this, a `running` row is assumed abandoned |
| `QUEUE_SHUTDOWN_GRACE_MS`   | `8000`     | How long a stopping worker waits for its jobs    |
| `WORKER_IN_PROCESS`         | dev only   | Run the worker inside the API process            |

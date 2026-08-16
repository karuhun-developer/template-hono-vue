# Add a background job

Work that must happen, but not while somebody is waiting for a response — in seven steps.

The worked example is **`reports.daily-signups`**: count the accounts created on a given day and log the number. It is deliberately the smallest job that still has a payload, a schedule and a reason to be retried. What already exists is described in [`../features/queue.md`](../features/queue.md); this is the recipe.

## 1. The payload schema

A payload is written once, in `apps/api/src/queue/registry.ts`, and everything else is derived from it.

```ts
const dailySignupsPayload = z.object({
  /** Optional so a schedule can point at this job — see step 6. Absent means yesterday. */
  day: z.iso.date().optional(),
})
```

> **Payloads are JSON, and only JSON.** A `Date` goes into `jsonb` as a string and comes back as a string, so use `z.iso.datetime()`, `z.iso.date()` or an id — never `z.date()`. This is the single most common way a job goes wrong, and the symptom looks exactly like a bug inside the handler.

Two more rules, both of which cost an afternoon when broken:

- **Ids, not rows.** A row copied into a payload is a row that has changed by the time the job runs. `mail.send` carries a `messageId` and re-reads the message for exactly this reason.
- **A job that takes no arguments still takes an object** — `z.object({})`, which the registry calls `NO_PAYLOAD`. Adding a field later is then a schema change rather than a change of shape.

## 2. The handler

`apps/api/src/queue/jobs/reports.ts`:

```ts
import type { JobContext } from '#queue/registry'

export async function dailySignupsJob(payload: { day?: string }, ctx: JobContext): Promise<void> {
  const day = payload.day ?? yesterdayInUtc()
  const count = await countUsersCreatedOn(day)

  // Background work has no request, so there is no `c.get('logger')`. `ctx.logger` already
  // carries `{ job, jobId }`, which is what makes one attempt findable in an aggregator.
  ctx.logger.info({ day, count }, "counted the day's signups")
}
```

A handler takes `(payload, ctx)` and returns `Promise<void>`. It returns nothing because nothing is listening: a job's result is whatever it wrote.

What `ctx` gives you, and when each matters:

| Field                     | Use it for                                                                |
| ------------------------- | ------------------------------------------------------------------------- |
| `logger`                  | Everything. It is already tagged with the job and the attempt's id.       |
| `attempt` / `maxAttempts` | `attempt >= maxAttempts` is the only signal that this is the last chance. |
| `signal`                  | A long job, so it can stop when the worker is shutting down.              |
| `jobId`                   | Correlating with the `jobs` row, and with the Jobs page.                  |

**The handler must be idempotent.** A retry after a half-finished attempt is normal, not exceptional: a worker can die between the work and the row that records it, and the reaper will hand the job to somebody else. Write it so that running it twice is indistinguishable from running it once.

## 3. The catalog entry

`apps/api/src/queue/registry.ts` — one `as const satisfies` object, the same idiom as `PERMISSIONS`:

```diff
   'cache.sweep': { payload: NO_PAYLOAD, handler: sweepCacheJob, maxAttempts: 1 },
+
+  'reports.daily-signups': { payload: dailySignupsPayload, handler: dailySignupsJob },
 } as const satisfies JobCatalog
```

`JobName` and `JobPayload<N>` are derived from this object, so `enqueue('reports.dialy-signups', …)` is a compile error rather than a row nobody ever claims. **A job that is not in the catalog cannot be enqueued and cannot be run** — a row naming an unknown job is failed terminally, because the handler will not be registered on the second attempt either.

## 4. `maxAttempts`, if three is wrong

The default is `QUEUE_MAX_ATTEMPTS` (three). Override it on the definition when the job's shape makes that wrong:

```ts
'queue.reap': { payload: NO_PAYLOAD, handler: reapJobsJob, maxAttempts: 1 },
```

One attempt for anything that runs every few minutes anyway: a retry would only repeat work the next tick was going to do, and a job that piles up retries while the database is unwell is the last thing that database needs. More than three for work that talks to somebody else's server, where the failure is usually the other end being briefly unavailable and the backoff is the whole point.

## 5. Enqueue it

```ts
await enqueue('reports.daily-signups', { day: '2026-08-15' })
```

That is the whole API from outside a transaction. From inside one — which is where most enqueues belong — **pass both `tx` and `defer`**:

```ts
return transaction(async (tx, defer) => {
  const user = await insertUser(tx, values)
  await enqueue('reports.daily-signups', {}, { tx, defer })
  return findUser(tx, user.id)
})
```

Pass both, always. Which one is used is the driver's decision and not the call site's: the `database` driver inserts through `tx`, so the row that changed and the job that acts on it commit together or not at all; `sync` and `redis` cannot join a Postgres transaction and go through `defer`, which runs after the commit. Passing only `tx` reaches the one branch in `dispatch()` that enqueues immediately — outside the transaction — and a rollback then leaves a job for a row that does not exist.

The other options are in the table in [`../features/queue.md`](../features/queue.md#enqueueing): `delayMs`, `runAt`, `maxAttempts` and `dedupeKey`.

> **Never call a handler directly.** `enqueue` is the door: it validates the payload inside the caller's transaction and it is what the retry accounting hangs off. A handler called as a function is a job with no attempts, no record and no Jobs page entry.

## 6. Schedule it, if it is periodic

`apps/api/src/scheduler/schedules.ts`:

```diff
   {
     key: 'cache.sweep',
     cron: '*/10 * * * *',
     job: 'cache.sweep',
     description: 'Delete cache entries that have expired.',
   },
+  {
+    key: 'reports.daily-signups',
+    cron: '0 5 * * *',
+    job: 'reports.daily-signups',
+    description: "Count yesterday's new accounts.",
+  },
 ] as const satisfies readonly ScheduleDefinition[]
```

A schedule **enqueues a job; it never runs work inline.** Retries, the failure record and the Jobs page all come for free that way, and a cleanup that takes four minutes cannot hold up the tick behind it.

> **A schedule can only point at a job whose payload is entirely optional.** A cron expression carries a time and nothing else, so there is nowhere for a payload to come from — `ScheduledJobName` enforces it, and pointing a schedule at `mail.send` is a compile error. That is why `day` was optional in step 1.

The expression is parsed at module load, so a typo takes the process down at boot rather than at 05:00 on the night somebody needed the report. It is read in `SCHEDULER_TIMEZONE`, which is UTC by default and worth leaving there. The rest — the tick, the catch-up window, and how two replicas fire exactly once — is [`../features/scheduler.md`](../features/scheduler.md).

## 7. Test it

The suite runs under `QUEUE_DRIVER=sync`, so a job runs **inline, awaited, and rethrows**. That means an endpoint test asserts the job's _effect_, with no waiting and no polling:

```ts
it('counts the signups when the report is requested', async () => {
  const res = await request(app, '/reports/daily-signups', { method: 'POST', cookie: ownerCookie })

  expect(res.status).toBe(202)
  // The job has already run by the time the response is here.
  expect(await countReportsFor(day)).toBe(1)
})
```

Assert the effect, never the row: under `sync` there is no row, and a test that looks for one passes or fails depending on `QUEUE_DRIVER`, which is not what it is trying to say.

For the handler itself, build a driver directly rather than reaching for the process-wide `queue` — `env` is frozen at boot, so a test cannot flip `QUEUE_DRIVER`:

```ts
const queue = createSyncQueue({ catalog: CATALOG })
await queue.push(prepareJob('test.ok', { note: 'inline' }, {}, CATALOG))
```

Every driver takes its catalog as an option for this reason. `apps/api/tests/queue.test.ts` is the worked example, including the transactional cases.

## Troubleshooting

**My job ran twice.**
Either it is not idempotent and something retried it — check `attempts` on the row, and remember that `attempts` increments at _claim_ time, so a worker that died mid-job has still spent one — or two workers claimed it. The second is close to impossible under the `database` driver, whose claim is a single `UPDATE … FOR UPDATE SKIP LOCKED`; it is the expected outcome of enqueueing the same work twice without a `dedupeKey`. The scheduler's protection against a double fire is that unique key, not luck.

**My job never ran.**
In order of likelihood:

1. **Nothing is running a worker.** `WORKER_IN_PROCESS` is on in development and **off everywhere else**; production runs `make worker` as a separate process. The API never claims jobs.
2. **`runAt` is in the future** — a `delayMs`, or the backoff from a previous failure.
3. **The transaction rolled back.** Under `database` the job is in the same commit as your change, which is the point; if the change is not there, neither is the job.
4. **A `dedupeKey` collided.** A second enqueue under a live key is silently dropped, deliberately.
5. **It failed terminally on the first attempt** because the payload no longer parses, or because this build has no handler for that name. Both refuse to retry: the second attempt would read the same bytes with the same code. The row is on the Jobs page with the reason in `last_error`.

**The payload arrives with a string where I put a `Date`.**
Because it does. The payload goes through `JSON.parse(JSON.stringify(…))` once, at enqueue, so what a handler receives is identical whichever driver carried it. Change the schema to `z.iso.datetime()` and parse it in the handler. A `Date` that survives the `sync` driver in a test and arrives as a string from the `database` driver in production is the worst kind of difference between the two.

**It works under `sync` and not under `redis`.**
The `redis` driver cannot join a Postgres transaction: `enqueue` goes through `defer` and the job is dispatched after the commit, so a crash in that window loses it. Work that must not be lost needs a record of its own — the way `mail_messages` is written inside the transaction and `mail.sweep-stuck` re-enqueues anything still `queued`. The trade is stated in full in [ADR-0004](../decisions/ADR-0004-jobs-in-postgres-by-default.md).

**Nothing appears on the Jobs page.**
Check `QUEUE_DRIVER`. Under `sync` nothing is written anywhere and the page says so; under `redis` only terminal failures are mirrored into `jobs`. The list response carries `coverage` for exactly this reason.

## Checklist

- [ ] Payload schema is JSON-only — no `z.date()`, ids rather than rows
- [ ] Handler takes `(payload, ctx)`, logs through `ctx.logger`, and is idempotent
- [ ] Entry added to `JOBS` in `registry.ts`
- [ ] `maxAttempts` set if three is wrong for this job
- [ ] Every `enqueue` inside a transaction passes **both** `tx` and `defer`
- [ ] Periodic work is a `SCHEDULES` entry pointing at a job with an all-optional payload
- [ ] Tested through the `sync` driver, asserting the effect rather than a row
- [ ] `make check` green, `CHANGELOG.md` updated

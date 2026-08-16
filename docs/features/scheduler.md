# Scheduler

Cron, without the double fires. Seven things run periodically, and no two replicas ever run the same one.

| Concern                   | File                                      |
| ------------------------- | ----------------------------------------- |
| What runs, and when       | `apps/api/src/scheduler/schedules.ts`     |
| The tick loop             | `apps/api/src/scheduler/scheduler.ts`     |
| Time arithmetic           | `apps/api/src/scheduler/cron.ts`          |
| Row access                | `apps/api/src/scheduler/schedule.repo.ts` |
| The `schedule_runs` table | `apps/api/src/db/schema/schedules.ts`     |
| The console's endpoints   | `apps/api/src/modules/schedules/`         |

## What runs

| Key                     | Cron           | Job                     |
| ----------------------- | -------------- | ----------------------- |
| `sessions.prune`        | `15 3 * * *`   | `sessions.prune`        |
| `invites.purge`         | `30 3 * * *`   | `invites.purge`         |
| `password-resets.purge` | `35 3 * * *`   | `password-resets.purge` |
| `mail.prune`            | `0 4 * * *`    | `mail.prune`            |
| `mail.sweep-stuck`      | `*/5 * * * *`  | `mail.sweep-stuck`      |
| `queue.reap`            | `*/5 * * * *`  | `queue.reap`            |
| `cache.sweep`           | `*/10 * * * *` | `cache.sweep`           |

The nightly four are spaced fifteen minutes apart rather than all set to `0 3 * * *`. They are cheap, but four table scans starting in the same second is a spike for no reason, and staggering them makes a slow one obvious in the log rather than tangled with the others.

## A schedule enqueues a job — it never runs work

That sentence is the design. The tick claims the instant, enqueues, and returns; the queue does everything after that.

Which means retries, backoff, the failure record, the Jobs page and the shutdown grace period all come for free, because they already exist one layer down. It also means a cleanup that takes four minutes cannot hold up the five-minute schedule behind it — the tick that started it finished in milliseconds.

The registry types this: `job` is not `JobName` but `ScheduledJobName`, the jobs whose payload is empty. A cron expression carries a time and nothing else, so there is nowhere for an argument to come from, and pointing a schedule at `mail.send` is a compile error rather than a job that fails on every attempt asking which message it was supposed to send.

## There is no `schedules` table

The registry is **code**, exactly like `PERMISSIONS` and `JOBS`. Only the runs are rows.

An expression in a row is an expression nothing type-checks, pointing at a job name nothing verifies, editable with no review and no history. And the first thing anybody wants is to switch one off — which in this design is a deploy, and in the other is a row somebody changed six months ago that nobody can now explain.

## The double-fire problem, and the index that solves it

Two workers. Both wake at 03:15:02, both work out that `15 3 * * *` was due at 03:15:00, both fire. The cleanup runs twice.

```sql
INSERT INTO schedule_runs (schedule_key, fired_for, job_key)
VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id
```

Every replica computes the **same** `fired_for` from the same expression, so they all attempt the same row. `schedule_runs_tick_key` is unique on `(schedule_key, fired_for)`, one insert wins, and the rest get nothing back and do nothing. The winner enqueues.

An advisory lock would also work, and was rejected for two reasons. It survives nothing — a restart drops it, and it releases the instant its connection does, which is precisely the moment a duplicate fire is most likely. And it displays nothing: the console's Scheduled jobs page needs a history, and this approach produces one as a side effect of being correct.

`claimTick` runs through the caller's transaction handle, so under `QUEUE_DRIVER=database` the claim and the job it enqueues **commit together**. If the enqueue throws, the claim rolls back with it and the next tick simply tries again — which is why there is no `error` column on `schedule_runs`. A row recording a tick that left nothing behind is a row nobody would ever act on.

## The scheduler holds no state

It does not remember what it fired. Every tick recomputes the most recent due instant for every schedule and re-attempts the claim; all but the first attempt conflict and become no-ops.

That is what makes it restartable, movable and replicable with no handover. It is also why the correctness test is _"two schedulers, one instant, one row"_ rather than _"the timer fired once"_ — the timer is not the mechanism.

## Catching up, and deliberately not catching up

`SCHEDULER_CATCHUP_MINUTES` (default 60) is how far back a tick will look.

A worker that has been down for a week comes up and finds seven missed nightly cleanups. Firing all seven at a database that is already behind is the wrong answer; so is firing none, because last night's genuinely should run. The window draws the line: **the most recent occurrence inside it fires, everything older stays missed.**

`lastDueAt()` is the whole rule, and it is pure — an expression, a timezone, an instant and a window in, one `Date | null` out. It walks forward from the start of the window using croner's `nextRun`, because that is croner's only pure answer: `previousRun()` reports what _that instance_ last executed, which for an instance that never executes anything is always `undefined`.

## Timezones

Every expression is read in `SCHEDULER_TIMEZONE`, default `UTC`, and all the arithmetic is croner's.

Leaving it at UTC is the recommendation, and the reason is the morning the clocks change: `15 3 * * *` in a zone with daylight saving happens twice one autumn morning and not at all one spring morning. Hand-rolled cron gets this wrong silently, in November, which is why `croner` is a dependency rather than a hundred lines here. `cron.test.ts` asserts the spring-forward case across `Europe/London`, in March 2027, today.

An unknown zone is rejected by `env.ts` at boot rather than at the first tick — croner validates lazily, so without that check a typo would surface inside a worker at 03:15 as a caught error in a log.

## A typo dies at boot

`schedules.ts` parses every expression at module load and asks it for a next run. A malformed expression, or one the configured timezone cannot be applied to, throws with the schedule's key in the message — at startup, next to a stack trace, rather than at 03:15 on the night somebody needed the cleanup to have run.

## Where it runs

`src/worker.ts`, and `src/index.ts` under `WORKER_IN_PROCESS` — which is on by default in development, so `make dev` is still one terminal.

**Never `app.ts`.** An API replica that ticked would be one scheduler per replica, all contending for the same rows every thirty seconds. The index survives that; nothing is gained by it.

The loop is a self-rescheduling `setTimeout`, `.unref()`'d, for the same two reasons as the queue poller: an `async` callback handed to `setInterval` overlaps itself, and an idle timer must not be why a process refuses to exit.

## What happened

`schedule_runs` records that a tick was claimed, and nothing about how it went. The outcome is the job's, and `job_key` is the pointer at it — the dedupe key handed to the queue, which is `jobs.dedupe_key` on the row the queue created. One source of truth, rather than a second copy here that could disagree with it.

| `QUEUE_DRIVER` | The joined job                                                                       |
| -------------- | ------------------------------------------------------------------------------------ |
| `database`     | Always there: status, attempts, last error, when it finished                         |
| `sync`         | Nothing to join — the handler ran inside the tick, and no row was written            |
| `redis`        | Nothing to join — BullMQ keeps the record, and mirrored failures carry no dedupe key |

The same per-driver honesty the Jobs page has. A console showing an empty outcome under `redis` should say why rather than render a blank that reads as "nothing happened".

There is deliberately **no duration**. `jobs.locked_at` is cleared when a job finishes, so the only interval still derivable is "due until finished", which includes however long the row waited in the queue — a number that looks like a slow job and is usually a busy worker.

## Run now

`fireManually(key)` writes a row with `manual = true` and enqueues immediately.

`schedule_runs_tick_key` is **partial on `manual = false`**, which is what keeps the two apart in both directions: pressing the button twice in the same second is allowed, and a manual run can never occupy the index slot the real tick was going to claim. A button that silently skipped a night's cleanup would be a strange thing to have added.

Its dedupe key is prefixed `:manual` for the same reason, so it cannot collide with the tick for the same minute in the queue either.

## Endpoints

| Method | Path                   | Permission      |
| ------ | ---------------------- | --------------- |
| `GET`  | `/schedules`           | `schedule.read` |
| `GET`  | `/schedules/:key/runs` | `schedule.read` |
| `POST` | `/schedules/:key/run`  | `schedule.run`  |

Both keys are **owner-only** — in the catalog, absent from `admin`. That is the whole of "visible only to the superadmin" here, and it is why the console's Operations group disappears entirely for an administrator.

`GET /schedules` takes **no query at all**. Six rows of code is not something to page, sort or filter, and the console renders it with `mode="none"`. Each entry carries its `nextRunAt`, computed on that request and **never stored**: a stored next-run goes stale the moment somebody edits the expression, and the staleness is invisible — the page would keep confidently naming an instant nothing is going to fire at.

There is no create, update, pause or delete. The registry is a file; the closest thing to a pause button is a deploy, which is the entire argument for keeping the expressions out of a table.

A key that is not in the registry is a **404**, on all three routes — not an empty list, because "no runs yet" is an answer somebody would act on and this is a different thing entirely. The param is validated as a bounded string rather than an enum of the current keys, so the 400 for a malformed one does not hand back a list of every schedule that does exist.

`POST /schedules/:key/run` is deliberately **not** gated on `SCHEDULER_ENABLED`. That setting decides whether the clock is watched; the button does not watch the clock. Its audit entry is the one write in this codebase made outside the transaction it belongs to, and `schedules.service.ts` says why: `fireManually` owns its transaction because the run row and the job have to commit together, and the entry records a button press whose effect has already, definitively, happened.

## The console page

**Operations → Scheduled jobs** is the list above with a history drawer and one button. No pager, no sort and no filter — three controls over six rows is furniture, and there is no list query to send a `?sort=` to.

Two things it says out loud that a table of rows alone would not:

- **The timezone**, in the heading. A next-run time is meaningless without the zone the expression was read in, and the zone is a setting rather than the browser's.
- **`SCHEDULER_ENABLED=false`**, as a note. Six schedules with six next-run times and no runs reads as a broken scheduler; it is usually a deliberate configuration, and the note is the difference between the two.

The outcome badge reports what the _job_ came to, and `scheduleOutcome()` — the one pure decision on the page, and the one thing unit-tested there — reads a missing job as **"Enqueued"** rather than as nothing having happened. Under `QUEUE_DRIVER=redis` the queue keeps no row to join to unless the job failed for good, so the absence is a property of the driver, not evidence about the tick.

A manual run is badged as one in the history. A run somebody started by hand does not tell you the clock is working, which is exactly why the unique tick index excludes it.

## Settings

| Variable                    | Default | Means                                                   |
| --------------------------- | ------- | ------------------------------------------------------- |
| `SCHEDULER_ENABLED`         | `true`  | Whether the worker ticks at all                         |
| `SCHEDULER_TIMEZONE`        | `UTC`   | The zone every expression is read in                    |
| `SCHEDULER_TICK_MS`         | `30000` | How often the clock is checked, not how often work runs |
| `SCHEDULER_CATCHUP_MINUTES` | `60`    | How far back a tick looks for an unfired occurrence     |

## Adding one

1. Add the job to `JOBS` in `apps/api/src/queue/registry.ts`, with an empty payload schema. See [add-a-job](../guides/add-a-job.md).
2. Add an entry to `SCHEDULES` with a key, an expression and a description. The key is what the console shows and what `schedule_runs.schedule_key` stores, so renaming one orphans its history.
3. Nothing else. There is no migration, no registration call, and no restart-order to get right.

## Conventions

- A schedule enqueues; it never runs work inline.
- The registry is code. The runs are rows.
- The tick holds no state — it recomputes, and the index decides.
- Pure time arithmetic lives in `cron.ts` and takes its `now` as an argument, so the tests can name an instant instead of waiting for one.

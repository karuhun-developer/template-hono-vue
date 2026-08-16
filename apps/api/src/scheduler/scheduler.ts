import type { Logger } from 'pino'

import type { Transaction } from '#db/client'
import { transaction, type Defer } from '#db/tx'
import { env } from '#env'
import { logger as defaultLogger } from '#lib/logger'
import { onShutdown } from '#lib/shutdown'
import { enqueue } from '#queue/queue'
import { lastDueAt } from '#scheduler/cron'
import { claimTick, recordManualRun } from '#scheduler/schedule.repo'
import { SCHEDULES, type ScheduleDefinition, type ScheduledJobName } from '#scheduler/schedules'

/**
 * The tick loop, and the two ways a schedule fires.
 *
 * It holds **no state about what has already run**. Every tick recomputes the most recent
 * instant each expression was due and re-attempts the claim; the unique index makes all but
 * the first attempt a no-op. That is what lets a scheduler be restarted, moved to another
 * host, or run in three replicas at once without a handover — and it is why the correctness
 * test is "two schedulers, same instant, one row", not "the timer fired once".
 *
 * It runs in **exactly one place**: the worker. `src/app.ts` must never start one, because
 * that would be one scheduler per API replica — which is survivable, thanks to the index,
 * but is a lock contended by every replica for no reason at all.
 *
 * A tick **enqueues a job and returns**. It never runs the work, so a four-minute cleanup
 * cannot hold up the five-minute schedule behind it, and every retry, failure record and
 * console row comes from the queue that already knows how to do all three.
 */

/**
 * Injected so a test can watch what a tick enqueued without a worker running, and so the
 * enqueue can be made to fail on purpose. In production it is always `enqueue`.
 */
export type ScheduleEnqueue = (
  job: ScheduledJobName,
  options: { tx: Transaction; defer: Defer; dedupeKey: string },
) => Promise<void>

export type SchedulerOptions = {
  schedules?: readonly ScheduleDefinition[]
  logger?: Logger
  timezone?: string
  tickMs?: number
  catchupMs?: number
  enqueueJob?: ScheduleEnqueue
}

export type Scheduler = {
  start: () => void
  stop: () => void
  /** Whether `start()` has been called and `stop()` has not. */
  isRunning: () => boolean
  /**
   * One pass over every schedule, awaited, returning how many ticks this call claimed.
   *
   * Public because the loop is the uninteresting half. A test calls this with a fixed `now`
   * and gets a deterministic answer, which is not something a timer can offer.
   */
  tick: (now?: Date) => Promise<number>
  /** "Run now": enqueue outside the schedule, without disturbing it. */
  fireManually: (key: string) => Promise<{ runId: string; jobKey: string }>
}

/** `<schedule>:<fired_for>` — the dedupe key, and the correlation id in `schedule_runs.job_key`. */
function jobKeyFor(scheduleKey: string, firedFor: Date): string {
  return `${scheduleKey}:${firedFor.toISOString()}`
}

export function createScheduler(options: SchedulerOptions = {}): Scheduler {
  const {
    schedules = SCHEDULES,
    logger = defaultLogger.child({ component: 'scheduler' }),
    timezone = env.SCHEDULER_TIMEZONE,
    tickMs = env.SCHEDULER_TICK_MS,
    catchupMs = env.SCHEDULER_CATCHUP_MINUTES * 60_000,
    enqueueJob = (job, enqueueOptions) => enqueue(job, {}, enqueueOptions),
  } = options

  let running = false
  let timer: NodeJS.Timeout | null = null

  /**
   * One schedule, one due instant. `true` when this replica owned the tick.
   *
   * The claim and the enqueue share a transaction, which is what makes the pair atomic under
   * the `database` driver: either both landed or neither did. Under a driver that cannot
   * join it the enqueue goes through `defer` and happens just after the commit — so the
   * worst case is a claimed tick whose job never reached Redis, which the next occurrence
   * does not repair. That is the same gap `mail.sweep-stuck` exists for, and the reason
   * `database` is the default.
   *
   * A failed enqueue rolls the claim back, so the tick is simply re-attempted on the next
   * pass — which is why there is no `error` column here. An outcome nobody would ever read
   * is worse than no column.
   */
  const fire = async (schedule: ScheduleDefinition, firedFor: Date): Promise<boolean> => {
    const jobKey = jobKeyFor(schedule.key, firedFor)

    return transaction(async (tx, defer) => {
      const owned = await claimTick(tx, {
        scheduleKey: schedule.key,
        firedFor,
        jobKey,
      })

      // Another replica got there first, or this one already did on an earlier pass. Both
      // are the normal case — every tick re-attempts every schedule — so this is silent.
      if (!owned) return false

      await enqueueJob(schedule.job, { tx, defer, dedupeKey: jobKey })
      logger.info({ schedule: schedule.key, job: schedule.job, firedFor }, 'schedule fired')
      return true
    })
  }

  const tick = async (now: Date = new Date()): Promise<number> => {
    let fired = 0

    for (const schedule of schedules) {
      // Nothing due inside the catch-up window. Either it is simply not time, or this
      // process was away long enough that the occurrence is too old to be worth firing —
      // `lastDueAt` cannot tell the two apart, and neither case is an event.
      const due = lastDueAt(schedule.cron, timezone, now, catchupMs)
      if (due === null) continue

      try {
        if (await fire(schedule, due)) fired += 1
      } catch (err) {
        // One schedule at a time. A bad expression or a database blip on `mail.prune` must
        // not stop `queue.reap` from being attempted in the same pass.
        logger.error({ err, schedule: schedule.key }, 'schedule tick failed')
      }
    }

    return fired
  }

  /**
   * The same self-rescheduling `setTimeout` the queue poller uses, for the same two reasons:
   * an `async` callback handed to `setInterval` overlaps itself and trips
   * `no-misused-promises`, and rescheduling from the settlement of the previous tick makes
   * that impossible by construction.
   *
   * `.unref()`'d, so an idle scheduler is never why a process refuses to exit. What keeps
   * the worker alive is stated in `src/worker.ts`.
   */
  const schedule = (delayMs: number): void => {
    if (!running) return

    timer = setTimeout(() => {
      timer = null

      void tick().then(
        () => schedule(tickMs),
        (err: unknown) => {
          // Unreachable — `tick()` catches per schedule — and here anyway, because a loop
          // that stops rescheduling on an unexpected throw is a scheduler that silently
          // stops scheduling.
          logger.error({ err }, 'scheduler tick failed')
          schedule(tickMs)
        },
      )
    }, delayMs)

    timer.unref()
  }

  return {
    start: () => {
      if (running) return
      running = true
      logger.info({ timezone, tickMs, schedules: schedules.length }, 'scheduler started')
      schedule(0)
    },

    stop: () => {
      running = false
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },

    isRunning: () => running,

    tick,

    fireManually: async (key) => {
      const schedule = schedules.find((candidate) => candidate.key === key)
      if (!schedule) throw new Error(`unknown schedule "${key}"`)

      const firedFor = new Date()
      const jobKey = jobKeyFor(`${schedule.key}:manual`, firedFor)

      /**
       * A dedupe key of its own, prefixed `:manual`, so it can never collide with the tick
       * for the same minute. Pressing the button is meant to run the job now — suppressing
       * it because tonight's occurrence happens to share an instant would be a button that
       * does nothing, occasionally.
       */
      return transaction(async (tx, defer) => {
        const runId = await recordManualRun(tx, { scheduleKey: schedule.key, firedFor, jobKey })
        await enqueueJob(schedule.job, { tx, defer, dedupeKey: jobKey })
        logger.info({ schedule: schedule.key, job: schedule.job }, 'schedule fired manually')
        return { runId, jobKey }
      })
    },
  }
}

/**
 * The process-wide scheduler.
 *
 * Constructing it starts nothing, exactly as the queue driver does not: the API imports this
 * module to press "Run now", and an API replica that quietly began ticking would be a
 * scheduler nobody asked for. `start()` is called from `src/worker.ts` and from
 * `src/index.ts` under `WORKER_IN_PROCESS`, and nowhere else.
 */
export const scheduler: Scheduler = createScheduler()

onShutdown('scheduler', () => {
  scheduler.stop()
})

/** Started only where a worker is. `false` when the setting is off, so the caller can say so. */
export function startScheduler(instance: Scheduler = scheduler): boolean {
  if (!env.SCHEDULER_ENABLED) return false
  if (instance.isRunning()) return false

  instance.start()
  return true
}

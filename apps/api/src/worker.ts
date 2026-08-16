// Imported for its side effect, exactly as `src/index.ts` does it: loading the pool is
// what registers its shutdown task, and it must happen before anything registered below so
// that it runs after them.
import '#db/client'
import { env } from '#env'
import { logger } from '#lib/logger'
import { installSignalHandlers, onShutdown } from '#lib/shutdown'
import { startWorker, stopWorker } from '#queue/worker'
import { startScheduler } from '#scheduler/scheduler'

/**
 * The worker process: claims jobs, runs them, and answers no HTTP.
 *
 * It is a second entrypoint rather than a flag on the first because the two have different
 * reasons to be restarted and different reasons to be scaled. An API replica that also
 * claimed jobs would multiply the workers every time the API was scaled out for traffic,
 * which is the opposite of what more traffic asks for.
 *
 * In development `WORKER_IN_PROCESS` defaults to on, so `make dev` is still one terminal.
 */

/**
 * The reason this process stays alive.
 *
 * The poll timer is `.unref()`'d on purpose — an idle poll must never be what keeps a
 * process from exiting — so without a handle of its own the worker would start, find
 * nothing to claim, and exit as though it had finished. This says out loud that the
 * process is alive because it is a worker, not because a timer happens to be pending.
 */
const keepAlive = setInterval(() => {}, 1 << 30)

onShutdown('worker-lifetime', () => {
  clearInterval(keepAlive)
})

onShutdown('worker', stopWorker)

if (startWorker()) {
  logger.info({ driver: env.QUEUE_DRIVER, env: env.NODE_ENV }, `${env.APP_NAME} worker ready`)
} else {
  logger.warn(
    { driver: env.QUEUE_DRIVER },
    'the worker has nothing to do with this driver and will idle',
  )
}

/**
 * The scheduler lives here and in `src/index.ts` under `WORKER_IN_PROCESS` — never in
 * `app.ts`. An API replica that ticked would be a second scheduler contending for the same
 * rows every thirty seconds, which the unique index survives and nobody benefits from.
 *
 * Started after the worker, so a schedule that fires in the first tick has somebody to claim
 * it. Its own shutdown task was registered by the module, beside the singleton it stops.
 */
if (!startScheduler()) {
  logger.info({ enabled: env.SCHEDULER_ENABLED }, 'the scheduler is not running in this process')
}

installSignalHandlers()

import { logger as defaultLogger } from '#lib/logger'

/**
 * A registry of things to run before the process exits.
 *
 * There are two entrypoints now — the API (`src/index.ts`) and the worker
 * (`src/worker.ts`) — and both have to stop the same subsystems in the same order. A
 * SIGINT block copied into the second one is a block that will drift from the first: the
 * day someone adds a cleanup hook they will add it to whichever file they had open.
 *
 * Tasks run in **reverse registration order**, because registration order is dependency
 * order. The database pool is registered first, by whoever imports it first; the queue
 * that reads through that pool registers later and therefore stops earlier. Stop the pool
 * first and the last in-flight job dies half-written.
 */

export type ShutdownTask = () => Promise<void> | void

export type ShutdownRegistry = {
  /** Register a task. Later registrations run earlier. */
  onShutdown: (name: string, run: ShutdownTask) => void
  /** Run every task once, in reverse order. Safe to call twice; the second call is a no-op. */
  runShutdown: (reason: string) => Promise<void>
  /** Wire SIGINT and SIGTERM to `runShutdown`, then exit. */
  installSignalHandlers: () => void
  /** Registered task names, newest first. For tests and for the `debug` line at boot. */
  pending: () => readonly string[]
}

export type ShutdownRegistryOptions = {
  /** How long any one task gets before we stop waiting and move to the next. */
  taskTimeoutMs?: number
  /** How long the whole sequence gets before the process is killed regardless. */
  totalTimeoutMs?: number
  logger?: Pick<typeof defaultLogger, 'info' | 'warn' | 'error'>
  exit?: (code: number) => void
  onSignal?: (handler: (signal: NodeJS.Signals) => void) => void
}

export function createShutdownRegistry(options: ShutdownRegistryOptions = {}): ShutdownRegistry {
  const {
    taskTimeoutMs = 10_000,
    totalTimeoutMs = 15_000,
    logger = defaultLogger,
    exit = (code: number) => process.exit(code),
    onSignal = (handler) => {
      process.on('SIGINT', handler)
      process.on('SIGTERM', handler)
    },
  } = options

  const tasks: { name: string; run: ShutdownTask }[] = []
  let running: Promise<void> | null = null

  const onShutdown = (name: string, run: ShutdownTask): void => {
    tasks.push({ name, run })
  }

  /**
   * One slow task must not hold the others hostage. We do not cancel it — there is no way
   * to cancel an arbitrary promise — we simply stop waiting, which is the honest thing to
   * do when the process is seconds from exiting anyway.
   */
  const withTimeout = async (name: string, run: ShutdownTask): Promise<void> => {
    let timer: NodeJS.Timeout | undefined
    const expired = Symbol('expired')
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(run),
        new Promise<typeof expired>((resolve) => {
          timer = setTimeout(() => resolve(expired), taskTimeoutMs)
        }),
      ])
      if (outcome === expired) {
        logger.warn({ task: name, taskTimeoutMs }, 'shutdown task timed out, moving on')
      }
    } catch (err) {
      // A failing task is reported and skipped. The ones after it still have to run:
      // failing to close a mail transport must not leave the database pool open.
      logger.error({ err, task: name }, 'shutdown task failed')
    } finally {
      clearTimeout(timer)
    }
  }

  const runShutdown = (reason: string): Promise<void> => {
    if (running) return running

    logger.info({ reason, tasks: tasks.length }, 'shutting down')
    running = (async () => {
      for (const task of [...tasks].reverse()) {
        await withTimeout(task.name, task.run)
      }
      logger.info({ reason }, 'shutdown complete')
    })()

    return running
  }

  const installSignalHandlers = (): void => {
    onSignal((signal: NodeJS.Signals) => {
      // Do not hang forever on a connection that refuses to let go. Unreffed, so it never
      // by itself keeps an otherwise-idle process alive.
      const hardStop = setTimeout(() => {
        logger.error({ signal, totalTimeoutMs }, 'shutdown took too long, exiting anyway')
        exit(1)
      }, totalTimeoutMs)
      hardStop.unref()

      void runShutdown(signal).then(
        () => {
          clearTimeout(hardStop)
          // Preserve an exit code something else has already decided on, but never inherit
          // a string one — `process.exit` wants a number.
          exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
        },
        (err: unknown) => {
          logger.error({ err, signal }, 'shutdown failed')
          clearTimeout(hardStop)
          exit(1)
        },
      )
    })
  }

  return {
    onShutdown,
    runShutdown,
    installSignalHandlers,
    pending: () => tasks.map((task) => task.name).reverse(),
  }
}

const registry = createShutdownRegistry()

export const onShutdown = registry.onShutdown
export const runShutdown = registry.runShutdown
export const installSignalHandlers = registry.installSignalHandlers

import { serve } from '@hono/node-server'

import { app } from '#app'
// Imported for its side effect: loading it is what registers the pool's shutdown task,
// and it must happen before the one registered below so that it runs after it.
import '#db/client'
import { env, isProduction, workerInProcess } from '#env'
import { logger } from '#lib/logger'
import { installSignalHandlers, onShutdown } from '#lib/shutdown'
import { startWorker, stopWorker } from '#queue/worker'
import { startScheduler } from '#scheduler/scheduler'

/**
 * A warning rather than a refusal. Some installations genuinely want no outbound mail — an
 * internal tool where accounts are handed out in person is a real thing — so this is not a
 * `superRefine` error. But the other reason to be running it in production is having
 * forgotten to configure a transport, and that one is invisible until somebody cannot
 * accept their invitation.
 */
if (isProduction && env.MAIL_DRIVER === 'log') {
  logger.warn(
    'MAIL_DRIVER=log in production — nothing is actually sent. Invitations and password resets will only ever reach the mail log.',
  )
}

/**
 * The other warning that cannot be a `superRefine` error, and for a sharper reason: the
 * environment does not know how many replicas there are. One process with a memory cache is
 * correct; two is a permission revoked on one of them and honoured by the other until the
 * TTL runs out, which is a security property decided by a setting nobody looked at.
 *
 * Here rather than in `cache.ts`, because `loadAccess` only runs on a request path — a
 * worker booting with the same configuration has nothing to warn about.
 */
if (env.CACHE_ACCESS_PERMISSIONS && env.CACHE_DRIVER === 'memory') {
  logger.warn(
    { ttlSeconds: env.CACHE_ACCESS_TTL_SECONDS },
    'CACHE_ACCESS_PERMISSIONS is on with CACHE_DRIVER=memory — invalidation reaches this process only, so with more than one replica a revoked permission stays honoured elsewhere until the entry expires.',
  )
}

const server = serve({ fetch: app.fetch, hostname: env.API_HOST, port: env.API_PORT }, (info) => {
  logger.info(
    { host: info.address, port: info.port, env: env.NODE_ENV },
    `${env.APP_NAME} API ready`,
  )
})

/**
 * One terminal in development, two processes in production.
 *
 * Registered before the HTTP server's task below, so it runs after it: the server stops
 * accepting requests first, and only then does the worker stop claiming — otherwise a
 * request arriving during shutdown could enqueue a job with nothing left to run it.
 *
 * Nothing here is conditional on being the API. `startWorker()` refuses on the sync driver,
 * where a handler has already run inside the request that enqueued it.
 */
if (workerInProcess) {
  onShutdown('worker', stopWorker)
  if (startWorker()) logger.info({ driver: env.QUEUE_DRIVER }, 'queue worker running in-process')

  // Inside this `if` and nowhere else. The scheduler belongs to the worker, so wherever the
  // worker is, it is — and an API that is not carrying one must not tick, or scaling out for
  // traffic would scale out the scheduler with it.
  if (startScheduler()) {
    logger.info({ timezone: env.SCHEDULER_TIMEZONE }, 'scheduler running in-process')
  }
}

/**
 * Stop accepting new connections and let the requests already in flight finish. This
 * matters more than it looks — a process killed mid-write is how you end up with a row
 * that says one thing and an audit trail that says another.
 *
 * Registered last, so it runs first: the pool registered itself in `db/client.ts` and has
 * to outlive the handlers still writing through it.
 */
onShutdown('http-server', async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
})

installSignalHandlers()

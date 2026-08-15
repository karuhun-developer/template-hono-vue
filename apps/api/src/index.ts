import { serve } from '@hono/node-server'

import { app } from '#app'
// Imported for its side effect: loading it is what registers the pool's shutdown task,
// and it must happen before the one registered below so that it runs after it.
import '#db/client'
import { env } from '#env'
import { logger } from '#lib/logger'
import { installSignalHandlers, onShutdown } from '#lib/shutdown'

const server = serve({ fetch: app.fetch, hostname: env.API_HOST, port: env.API_PORT }, (info) => {
  logger.info(
    { host: info.address, port: info.port, env: env.NODE_ENV },
    `${env.APP_NAME} API ready`,
  )
})

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

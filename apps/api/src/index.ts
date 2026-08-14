import { serve } from '@hono/node-server'

import { app } from '#app'
import { env } from '#env'
import { logger } from '#lib/logger'

const server = serve({ fetch: app.fetch, hostname: env.API_HOST, port: env.API_PORT }, (info) => {
  logger.info(
    { host: info.address, port: info.port, env: env.NODE_ENV },
    `${env.APP_NAME} API ready`,
  )
})

/**
 * Shut down tidily: stop accepting new connections, let the requests already in flight
 * finish. This matters more than it looks — a process killed mid-write is how you end up
 * with a row that says one thing and an audit trail that says another.
 */
function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, 'closing server')
  server.close((err) => {
    if (err) {
      logger.error({ err }, 'failed to close server')
      process.exitCode = 1
    }
    process.exit()
  })
  // Do not hang forever on a connection that refuses to let go.
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

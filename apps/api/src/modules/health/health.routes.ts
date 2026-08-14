import { Hono } from 'hono'

import { pingDatabase } from '#db/client'
import { env } from '#env'
import type { AppBindings } from '#middleware/request-context'

const startedAt = Date.now()

function uptimeSeconds(): number {
  return Math.round((Date.now() - startedAt) / 1000)
}

/**
 * `/health` answers **liveness**: "is the process still alive?" It deliberately touches
 * nothing outside the process, so that it keeps answering 200 while the database is down —
 * that is precisely the moment you most need to know the API itself is not the thing that
 * died. Orchestrators restart on this signal, and a liveness probe that checks the database
 * turns one Postgres hiccup into a restart loop across every instance at once.
 *
 * `/health/ready` answers a different question: **readiness**, "can this instance serve a
 * request?" That is the one a load balancer uses to decide whether to send traffic, and it
 * is where dependency checks belong.
 *
 * Neither requires auth: nothing here cannot already be inferred by connecting to the port.
 */
export const healthRoutes = new Hono<AppBindings>()
  .get('/', (c) => {
    return c.json({
      status: 'ok' as const,
      app: env.APP_NAME,
      env: env.NODE_ENV,
      uptimeSeconds: uptimeSeconds(),
      time: new Date().toISOString(),
    })
  })
  .get('/ready', async (c) => {
    const database = await pingDatabase().catch((err: unknown) => {
      c.get('logger').error({ err }, 'health: the database did not answer')
      return false
    })

    return c.json(
      {
        status: database ? ('ready' as const) : ('degraded' as const),
        checks: { database },
        uptimeSeconds: uptimeSeconds(),
        time: new Date().toISOString(),
      },
      database ? 200 : 503,
    )
  })

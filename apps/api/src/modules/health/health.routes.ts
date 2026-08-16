import { Hono } from 'hono'

import { pingDatabase } from '#db/client'
import { env } from '#env'
import type { AppBindings } from '#middleware/request-context'
import { queue } from '#queue/queue'

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
    /**
     * Both at once, because they are independent and a probe is being timed. The queue check
     * asks whether this instance can still **hand a job over** — not whether anything is
     * draining them, which is a question about the fleet rather than about this replica.
     *
     * Under the `sync` and `database` drivers it is `true` by construction: there is either
     * no transport at all, or it is the pool the line above just pinged. Only `redis` has a
     * dependency of its own here, and before this check an instance that could not reach it
     * would have gone on reporting itself ready while every enqueue failed.
     */
    const [database, queueReady] = await Promise.all([
      pingDatabase().catch((err: unknown) => {
        c.get('logger').error({ err }, 'health: the database did not answer')
        return false
      }),
      queue.ping().catch((err: unknown) => {
        c.get('logger').error({ err }, 'health: the queue did not answer')
        return false
      }),
    ])

    const ready = database && queueReady

    return c.json(
      {
        status: ready ? ('ready' as const) : ('degraded' as const),
        checks: { database, queue: queueReady },
        uptimeSeconds: uptimeSeconds(),
        time: new Date().toISOString(),
      },
      ready ? 200 : 503,
    )
  })

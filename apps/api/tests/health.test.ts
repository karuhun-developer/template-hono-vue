import { afterAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase } from '#db/client'

import { request } from './support/world'

/**
 * The two probes, and the distinction between them.
 *
 * `/health` is liveness and must touch nothing outside the process — a liveness probe that
 * checked a dependency would turn one Postgres hiccup into a restart loop across every
 * instance at once, at exactly the moment you need to know the API itself is still alive.
 * `/health/ready` is the one a load balancer uses, and it is where the checks belong.
 *
 * The suite runs under `QUEUE_DRIVER=sync`, so the queue check is `true` by construction:
 * there is no transport to be unable to reach. The driver that has a dependency of its own
 * is `redis`, and its `ping` is asserted in `queue.redis.test.ts` against a real server —
 * including the case where there is nothing on the port.
 */

afterAll(closeDatabase)

describe('the health endpoints', () => {
  it('answers liveness without asking anything outside the process', async () => {
    const res = await request(app, '/health')
    const body = (await res.json()) as { status: string; uptimeSeconds: number }

    expect(res.status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0)
  })

  it('reports every dependency it checked, by name', async () => {
    const res = await request(app, '/health/ready')
    const body = (await res.json()) as {
      status: string
      checks: Record<string, boolean>
    }

    expect(res.status).toBe(200)
    expect(body.status).toBe('ready')
    // Named rather than counted: a check that silently disappears from the response is a
    // dependency nobody is watching any more, and the shape is what a probe keys off.
    expect(body.checks).toEqual({ database: true, queue: true })
  })

  it('is public, because nothing here is not already visible from the port', async () => {
    await expect(request(app, '/health').then((res) => res.status)).resolves.toBe(200)
    await expect(request(app, '/health/ready').then((res) => res.status)).resolves.toBe(200)
  })
})

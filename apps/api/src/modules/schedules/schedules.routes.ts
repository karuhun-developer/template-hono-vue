import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'

import { badRequest } from '#lib/errors'
import { requirePermission } from '#middleware/rbac'
import type { AppBindings } from '#middleware/request-context'
import { requireAuth } from '#middleware/session'
import { actorFromContext } from '#modules/audit/audit.repo'
import { listRunsQuery, scheduleKeyParam } from '#modules/schedules/schedules.schema'
import {
  listSchedules,
  listScheduleRuns,
  runScheduleNow,
} from '#modules/schedules/schedules.service'

/**
 * The scheduler, from the outside.
 *
 * Owner-only, through two keys for the same reason the queue has two: reading the list
 * answers "did last night's cleanup run", while "Run now" starts real work against live data
 * at a moment nobody planned for.
 *
 * There is no endpoint that adds, edits, pauses or deletes a schedule. The registry is a file
 * — see `docs/features/scheduler.md` — and the closest thing to a pause button is a deploy.
 */

const validationHook = (result: { success: boolean; error?: unknown }): void => {
  if (result.success) return
  throw badRequest('The details you sent are not valid.', result.error)
}

export const scheduleRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())

  .get('/', requirePermission('schedule.read'), async (c) => {
    // No query at all: the registry is six rows of code, so there is nothing to page,
    // sort or filter. `next_run` is computed here, on this request, and never stored.
    return c.json(await listSchedules())
  })

  .get(
    '/:key/runs',
    requirePermission('schedule.read'),
    zValidator('param', scheduleKeyParam, validationHook),
    zValidator('query', listRunsQuery, validationHook),
    async (c) => {
      const runs = await listScheduleRuns(c.req.valid('param').key, c.req.valid('query').limit)

      return c.json({ items: runs })
    },
  )

  .post(
    '/:key/run',
    requirePermission('schedule.run'),
    zValidator('param', scheduleKeyParam, validationHook),
    async (c) => {
      const result = await runScheduleNow(actorFromContext(c), c.req.valid('param').key)

      c.get('logger').info(
        { schedule: result.schedule, job: result.job, runId: result.runId },
        'schedule run requested',
      )
      return c.json(result)
    },
  )

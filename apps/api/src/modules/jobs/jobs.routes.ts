import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { badRequest } from '#lib/errors'
import { requirePermission } from '#middleware/rbac'
import type { AppBindings } from '#middleware/request-context'
import { requireAuth } from '#middleware/session'
import { actorFromContext } from '#modules/audit/audit.repo'
import { listJobsQuery } from '#modules/jobs/jobs.schema'
import { cancelQueuedJob, listVisibleJobs, retryJob } from '#modules/jobs/jobs.service'

/**
 * The background queue, from the outside.
 *
 * Owner-only, through two keys rather than one: reading the list answers support questions
 * ("did that invitation ever go out"), while retrying re-runs code against live data and
 * cancelling throws work away.
 *
 * There is no create endpoint, and there will not be one. A job is enqueued by the code
 * that knows what its payload means — an HTTP door onto `enqueue()` would be a way to run
 * arbitrary catalog handlers with arbitrary arguments, which is a different and much larger
 * permission than "retry the thing that just failed".
 */

const validationHook = (result: { success: boolean; error?: unknown }): void => {
  if (result.success) return
  throw badRequest('The details you sent are not valid.', result.error)
}

const idParam = z.object({ id: z.uuid('Not a valid job id.') })

export const jobRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())

  .get(
    '/',
    requirePermission('job.read'),
    zValidator('query', listJobsQuery, validationHook),
    async (c) => {
      // `{ items, total, page, perPage }` plus the two fields that say what the rows mean
      // under the configured driver — see `JobCoverage`.
      return c.json(await listVisibleJobs(c.req.valid('query')))
    },
  )

  .post(
    '/:id/retry',
    requirePermission('job.manage'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      const job = await retryJob(actorFromContext(c), c.req.valid('param').id)

      c.get('logger').info({ jobId: job.id, job: job.name }, 'job requeued')
      return c.json({ job })
    },
  )

  .post(
    '/:id/cancel',
    requirePermission('job.manage'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      const job = await cancelQueuedJob(actorFromContext(c), c.req.valid('param').id)

      c.get('logger').info({ jobId: job.id, job: job.name }, 'job cancelled')
      return c.json({ job })
    },
  )

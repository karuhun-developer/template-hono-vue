import { db } from '#db/client'
import type { Job } from '#db/schema'
import { conflict, notFound } from '#lib/errors'
import { recordAudit, type AuditActor } from '#modules/audit/audit.repo'
import type { ListJobsQuery } from '#modules/jobs/jobs.schema'
import { queueAdmin, type JobCoverage, type QueueAdmin } from '#queue/queue.admin'
import { JOB_NAMES } from '#queue/registry'

/**
 * The Jobs page's side of the queue.
 *
 * Every function here takes the `QueueAdmin` as a **last argument defaulting to the
 * singleton**. That is not dependency injection for its own sake: `env` is frozen at boot,
 * the test suite runs on `QUEUE_DRIVER=sync`, and without the seam there would be no way to
 * exercise retry and cancel at all — the two operations most worth a test.
 *
 * The status guards live here rather than in the admin because they are the same rule
 * whichever driver is configured. What differs between drivers is whether the change is
 * possible at all, and that is the admin's answer to give.
 */

export type JobListPage = {
  items: Job[]
  total: number
  page: number
  perPage: number
  /** What the rows above represent under the configured driver. See `JobCoverage`. */
  coverage: JobCoverage
  /** Whether retry and cancel will do anything, so the console can say so up front. */
  manageable: boolean
  /**
   * The catalog, so the console's name facet is this list rather than a second copy of it.
   *
   * `jobs.schema.ts` says a job name is "a closed set the console can offer as a facet" —
   * this is that set, travelling with the page it is offered on. A row whose name has since
   * left the catalog is therefore not in the facet, which is why the filter itself takes a
   * bounded string: the one message somebody is looking for is often the one under a name
   * that no longer exists.
   */
  names: readonly string[]
}

export async function listVisibleJobs(
  query: ListJobsQuery,
  admin: QueueAdmin = queueAdmin,
): Promise<JobListPage> {
  const { rows, total } = await admin.list({
    status: query.status,
    name: query.name,
    page: query.page,
    perPage: query.perPage,
    sort: query.sort,
    order: query.order,
  })

  return {
    items: rows,
    total,
    page: query.page,
    perPage: query.perPage,
    coverage: admin.coverage,
    manageable: admin.manageable,
    names: JOB_NAMES,
  }
}

/**
 * Run a job that has stopped, again.
 *
 * Only from a terminal state. A `pending` job is already going to run and a second copy is
 * not what the button promises; a `running` one is being worked on by somebody, and
 * requeueing it would hand the same payload to a second worker while the first is still
 * inside the handler — the exact double-execution the claim query exists to prevent.
 */
export async function retryJob(
  actor: AuditActor,
  jobId: string,
  admin: QueueAdmin = queueAdmin,
): Promise<Job> {
  return db.transaction(async (tx) => {
    const before = await admin.find(tx, jobId)
    if (!before) throw notFound('Job not found.')

    if (before.status !== 'failed' && before.status !== 'cancelled') {
      throw conflict(
        `Only a failed or cancelled job can be run again — this one is ${before.status}.`,
      )
    }

    const after = await admin.retry(tx, before)

    await recordAudit(tx, actor, {
      action: 'job.retry',
      subjectType: 'jobs',
      subjectId: before.id,
      subjectLabel: before.name,
      before: { status: before.status, attempts: before.attempts, lastError: before.lastError },
      after: { status: after.status, attempts: after.attempts, runAt: after.runAt.toISOString() },
    })

    return after
  })
}

/**
 * Decide the work is no longer wanted.
 *
 * Only a job that has not started. Cancelling something already in flight would be a
 * promise this cannot keep: the handler is running in another process and the row is not
 * what would stop it. `cancelled` is a separate status from `failed` because one is a
 * decision and the other is a problem, and a page that cannot tell them apart sends people
 * looking for a bug that does not exist.
 */
export async function cancelQueuedJob(
  actor: AuditActor,
  jobId: string,
  admin: QueueAdmin = queueAdmin,
): Promise<Job> {
  return db.transaction(async (tx) => {
    const before = await admin.find(tx, jobId)
    if (!before) throw notFound('Job not found.')

    if (before.status !== 'pending') {
      throw conflict(
        `Only a job that has not started can be cancelled — this one is ${before.status}.`,
      )
    }

    const after = await admin.cancel(tx, before)

    await recordAudit(tx, actor, {
      action: 'job.cancel',
      subjectType: 'jobs',
      subjectId: before.id,
      subjectLabel: before.name,
      before: { status: before.status },
      after: { status: after.status },
    })

    return after
  })
}

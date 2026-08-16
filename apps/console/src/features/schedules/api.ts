import type { InferResponseType } from 'hono/client'

import { api } from '@/lib/api'
import { readAction, readApiError, type ActionResult, type ApiFailure } from '@/lib/api-error'

/**
 * Everything this console knows about the scheduler: the shapes, and the calls.
 *
 * There is no paging, no sort and no filter, because there is no list query — the registry
 * is a file with a handful of entries in it, and three controls over six rows is furniture.
 * That is also why there is nothing here that edits a schedule: changing one is a deploy.
 */

export type ScheduleListResponse = InferResponseType<typeof api.schedules.$get>

export type ScheduleSummary = ScheduleListResponse['items'][number]

/** A row of `schedule_runs`, joined to whatever the queue still knows about its job. */
export type ScheduleRun = InferResponseType<
  (typeof api.schedules)[':key']['runs']['$get']
>['items'][number]

export type ScheduleJobStatus = NonNullable<ScheduleRun['job']>['status']

export async function fetchSchedules(): Promise<ScheduleListResponse | { failure: ApiFailure }> {
  const response = await api.schedules.$get()
  if (!response.ok) return { failure: await readApiError(response) }
  return response.json()
}

export async function fetchScheduleRuns(
  key: string,
): Promise<ScheduleRun[] | { failure: ApiFailure }> {
  const response = await api.schedules[':key'].runs.$get({ param: { key }, query: {} })
  if (!response.ok) return { failure: await readApiError(response) }
  return (await response.json()).items
}

export function runSchedule(
  key: string,
): Promise<ActionResult<InferResponseType<(typeof api.schedules)[':key']['run']['$post']>>> {
  return readAction(() => api.schedules[':key'].run.$post({ param: { key } }))
}

/* ------------------------------------------------------------------------------ outcome */

export type ScheduleOutcome = {
  label: string
  variant: 'secondary' | 'success' | 'destructive' | 'info'
}

/**
 * What a run came to, in one badge.
 *
 * Pure, and here rather than inside the table, because it is the part worth a test: a run row
 * and the job it enqueued are two different records, and only one of them is guaranteed to
 * exist. Under `QUEUE_DRIVER=redis` the queue keeps nothing to join to unless the job failed
 * for good, so a missing job means **"the tick fired and the queue took it"** — not "nothing
 * happened", which is what an empty cell would say.
 */
export function scheduleOutcome(run: ScheduleRun | null): ScheduleOutcome | null {
  if (!run) return null
  if (!run.job) return { label: 'Enqueued', variant: 'secondary' }

  const LABELS: Record<ScheduleJobStatus, ScheduleOutcome> = {
    pending: { label: 'Queued', variant: 'secondary' },
    running: { label: 'Running', variant: 'info' },
    succeeded: { label: 'Succeeded', variant: 'success' },
    failed: { label: 'Failed', variant: 'destructive' },
    // A scheduled job somebody cancelled by hand. Not a failure, which is the whole reason
    // the queue keeps it as a separate status.
    cancelled: { label: 'Cancelled', variant: 'secondary' },
  }

  return LABELS[run.job.status]
}

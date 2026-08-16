import type { InferResponseType } from 'hono/client'

import { listResult, type ResourceQuery } from '@/composables/useResourceList'
import { api } from '@/lib/api'
import { readAction, type ActionResult, type ApiFailure } from '@/lib/api-error'

/**
 * Everything this console knows about background jobs: the shapes, and the calls.
 *
 * Derived from `AppType`, never declared — the same rule as every other feature here, and
 * for the same reason: a field that leaves the API should break the component that showed
 * it rather than quietly render `undefined`.
 */

/**
 * The whole envelope, not just the page.
 *
 * `GET /jobs` answers with three fields beyond `{ items, total }` — `coverage`, `manageable`
 * and `names` — and all three are things the page has to say out loud. Under
 * `QUEUE_DRIVER=sync` there is genuinely nothing to list, and "no jobs" would read as a
 * broken queue rather than as a configuration.
 */
export type JobListResponse = InferResponseType<typeof api.jobs.$get>

export type JobSummary = JobListResponse['items'][number]
export type JobStatus = JobSummary['status']
export type JobCoverage = JobListResponse['coverage']

/** The keys `listJobsQuery` accepts as `?sort=`. Anything else falls back to the default. */
export const JOB_SORTABLE = ['createdAt', 'runAt', 'name', 'status'] as const

export type JobSortKey = (typeof JOB_SORTABLE)[number]

export type JobFilters = {
  statuses: string[]
  /** Exact catalog names. The facet's options come from the response's own `names`. */
  names: string[]
}

export function fetchJobs(
  query: ResourceQuery<JobSortKey>,
  filters: JobFilters,
): Promise<JobListResponse | { failure: ApiFailure }> {
  return listResult(
    api.jobs.$get(
      {
        query: {
          // Sent once per ticked box; the API reads a repeated parameter as a set.
          ...(filters.statuses.length === 0 ? {} : { status: filters.statuses as JobStatus[] }),
          ...(filters.names.length === 0 ? {} : { name: filters.names }),
          page: String(query.page),
          perPage: String(query.perPage),
          sort: query.sort,
          order: query.order,
        },
      },
      { init: { signal: query.signal } },
    ),
  )
}

export function retryJob(
  id: string,
): Promise<ActionResult<InferResponseType<(typeof api.jobs)[':id']['retry']['$post']>>> {
  return readAction(() => api.jobs[':id'].retry.$post({ param: { id } }))
}

export function cancelJob(
  id: string,
): Promise<ActionResult<InferResponseType<(typeof api.jobs)[':id']['cancel']['$post']>>> {
  return readAction(() => api.jobs[':id'].cancel.$post({ param: { id } }))
}

/* ----------------------------------------------------------------------- row actions */

/**
 * Which of the two buttons a row is allowed to show.
 *
 * Pure, and here rather than inside the table, because it is the part worth a test: these
 * are the API's own status guards mirrored, and a mirror that drifts offers people a button
 * whose only outcome is a 409.
 *
 * It is **not** enforcement. `requirePermission('job.manage')` refuses the request and the
 * service refuses the transition; this only decides what is worth offering.
 */
export function jobActions(job: JobSummary): { retry: boolean; cancel: boolean } {
  return {
    // Terminal only. A pending job is already going to run and a running one is in
    // somebody's hands — requeueing either is how the same payload gets executed twice.
    retry: job.status === 'failed' || job.status === 'cancelled',
    // Only before it starts. Nothing here can reach into another process and stop a
    // handler, so offering it on a running job would be a promise the button cannot keep.
    cancel: job.status === 'pending',
  }
}

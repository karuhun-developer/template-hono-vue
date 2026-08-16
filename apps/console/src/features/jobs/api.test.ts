import { describe, expect, it } from 'vitest'

import { jobActions, type JobStatus, type JobSummary } from '@/features/jobs/api'

/**
 * The mirror of the API's status guards, which is the one part of the Jobs page worth a
 * test: `jobs.service.ts` answers 409 for every transition it refuses, and a mirror that has
 * drifted offers people a button whose only possible outcome is that 409.
 *
 * It is not a test of authorisation. `requirePermission('job.manage')` refuses the request,
 * and `apps/api/tests/jobs.test.ts` asserts the 403.
 */

/** Only `status` is read, so the rest of a `JobSummary` is beside the point. */
function jobWith(status: JobStatus): JobSummary {
  return { id: 'b1c2…', name: 'mail.send', status } as JobSummary
}

describe('jobActions', () => {
  it('offers a run again only from a terminal state', () => {
    expect(jobActions(jobWith('failed')).retry).toBe(true)
    expect(jobActions(jobWith('cancelled')).retry).toBe(true)

    // A pending job is already going to run, and a running one is in somebody's hands —
    // requeueing either is how one payload gets executed twice.
    expect(jobActions(jobWith('pending')).retry).toBe(false)
    expect(jobActions(jobWith('running')).retry).toBe(false)
    expect(jobActions(jobWith('succeeded')).retry).toBe(false)
  })

  it('offers a cancel only before the job has started', () => {
    expect(jobActions(jobWith('pending')).cancel).toBe(true)

    // Nothing here can reach into another process and stop a handler mid-flight.
    expect(jobActions(jobWith('running')).cancel).toBe(false)
    expect(jobActions(jobWith('succeeded')).cancel).toBe(false)
    expect(jobActions(jobWith('failed')).cancel).toBe(false)
    expect(jobActions(jobWith('cancelled')).cancel).toBe(false)
  })
})

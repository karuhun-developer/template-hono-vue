import { describe, expect, it } from 'vitest'

import { scheduleOutcome, type ScheduleRun } from '@/features/schedules/api'

/**
 * The one decision on this page, so the one thing worth a test.
 *
 * A run row and the job it enqueued are separate records, and only the run row is guaranteed
 * to exist — under `QUEUE_DRIVER=redis` there is nothing to join to unless the job failed for
 * good. Reading that absence as "nothing happened" is the mistake this guards against.
 */

const RUN: ScheduleRun = {
  id: '11111111-1111-4111-8111-111111111111',
  scheduleKey: 'sessions.prune',
  firedFor: '2026-01-01T03:15:00.000Z',
  manual: false,
  enqueuedAt: '2026-01-01T03:15:01.000Z',
  job: null,
}

function withJob(status: NonNullable<ScheduleRun['job']>['status']): ScheduleRun {
  return {
    ...RUN,
    job: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'sessions.prune',
      status,
      attempts: 1,
      maxAttempts: 3,
      lastError: null,
      finishedAt: null,
    },
  }
}

describe('scheduleOutcome', () => {
  it('has nothing to say about a schedule that has never fired', () => {
    expect(scheduleOutcome(null)).toBeNull()
  })

  it('reads a missing job as enqueued rather than as a failure', () => {
    expect(scheduleOutcome(RUN)).toEqual({ label: 'Enqueued', variant: 'secondary' })
  })

  it('reports the job status when the queue kept one', () => {
    expect(scheduleOutcome(withJob('succeeded'))?.variant).toBe('success')
    expect(scheduleOutcome(withJob('failed'))?.variant).toBe('destructive')
    // A decision somebody made, not a problem — the same reading the Jobs page gives it.
    expect(scheduleOutcome(withJob('cancelled'))?.variant).toBe('secondary')
  })
})

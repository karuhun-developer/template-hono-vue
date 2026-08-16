import { describe, expect, it } from 'vitest'

import { lastDueAt, nextRunAt, parseCron } from '#scheduler/cron'

/**
 * The time arithmetic, on its own.
 *
 * No database and no clock: every case names an instant and asks what the expression says
 * about it. That is the only way the daylight-saving cases below can exist at all — waiting
 * until March to find out is not a test.
 */

const at = (iso: string): Date => new Date(iso)

describe('nextRunAt', () => {
  it('is strictly after the instant it is given', () => {
    // 03:15 exactly is not "after 03:15" — otherwise a tick landing precisely on the minute
    // would compute itself as its own next run and fire twice.
    expect(nextRunAt('15 3 * * *', 'UTC', at('2026-08-16T03:15:00.000Z'))).toEqual(
      at('2026-08-17T03:15:00.000Z'),
    )
  })

  it('answers within the minute for a frequent expression', () => {
    expect(nextRunAt('*/5 * * * *', 'UTC', at('2026-08-16T03:16:42.000Z'))).toEqual(
      at('2026-08-16T03:20:00.000Z'),
    )
  })
})

/**
 * The clocks go forward in London at 01:00 on 2027-03-28, so 01:30 local does not exist that
 * morning. A daily 02:30 therefore lands at 01:30 **UTC**, exactly as it does on every other
 * day of British Summer Time — which is the point: the expression means half past two where
 * the people are, and the arithmetic that keeps it meaning that is croner's, not ours.
 */
describe('nextRunAt across a daylight-saving boundary', () => {
  it('keeps local time fixed while the offset moves', () => {
    const before = nextRunAt('30 2 * * *', 'Europe/London', at('2027-03-26T12:00:00.000Z'))
    const after = nextRunAt('30 2 * * *', 'Europe/London', at('2027-03-28T12:00:00.000Z'))

    // 02:30 GMT the day before the change; 02:30 BST the day after it.
    expect(before).toEqual(at('2027-03-27T02:30:00.000Z'))
    expect(after).toEqual(at('2027-03-29T01:30:00.000Z'))
  })

  it('does not skip the day of the change', () => {
    expect(nextRunAt('30 2 * * *', 'Europe/London', at('2027-03-27T12:00:00.000Z'))).toEqual(
      at('2027-03-28T01:30:00.000Z'),
    )
  })
})

describe('lastDueAt', () => {
  const HOUR = 60 * 60 * 1000

  it('finds the most recent occurrence at or before now', () => {
    expect(lastDueAt('*/5 * * * *', 'UTC', at('2026-08-16T03:16:42.000Z'), HOUR)).toEqual(
      at('2026-08-16T03:15:00.000Z'),
    )
  })

  it('includes an occurrence landing exactly on now', () => {
    // The boundary that decides whether a tick arriving on the second fires at all.
    expect(lastDueAt('*/5 * * * *', 'UTC', at('2026-08-16T03:15:00.000Z'), HOUR)).toEqual(
      at('2026-08-16T03:15:00.000Z'),
    )
  })

  it('returns null when nothing was due inside the window', () => {
    // A daily 03:15, asked at 09:00 with an hour to look back through: last night's run is
    // hours outside the window, so this tick fires nothing rather than firing it late.
    expect(lastDueAt('15 3 * * *', 'UTC', at('2026-08-16T09:00:00.000Z'), HOUR)).toBeNull()
  })

  it('fires the most recent occurrence once, not every one it missed', () => {
    // The restart-after-a-week case. A week of daily runs is inside a window that wide, and
    // the answer is still a single instant — the one the scheduler will claim.
    const week = 7 * 24 * HOUR
    expect(lastDueAt('15 3 * * *', 'UTC', at('2026-08-16T09:00:00.000Z'), week)).toEqual(
      at('2026-08-16T03:15:00.000Z'),
    )
  })
})

describe('parseCron', () => {
  it('refuses a malformed expression', () => {
    // What turns a typo in `SCHEDULES` into a failure at boot rather than at 03:15.
    expect(() => parseCron('every tuesday', 'UTC')).toThrow()
  })

  it('starts nothing', () => {
    // Croner runs a timer only when handed a function. If that ever changed, a module that
    // merely asks an expression a question would start scheduling callbacks.
    expect(parseCron('* * * * *', 'UTC').isRunning()).toBe(false)
  })
})

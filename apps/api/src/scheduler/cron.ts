import { Cron } from 'croner'

/**
 * The two time questions the scheduler asks, as pure functions of an expression and an
 * instant. Nothing here reads a clock, holds state, or schedules a callback — which is what
 * makes the DST tests below possible at all, and what lets `GET /schedules` compute a next
 * run without the API owning a scheduler.
 *
 * `croner` rather than `node-cron` for exactly this reason: it works as a **parser**, not
 * only as a thing that calls you back. A scheduler that cannot answer "when next" leaves the
 * console with a column it can only fill in by guessing.
 *
 * All arithmetic goes through croner in the configured timezone, so `15 3 * * *` means 03:15
 * local on the day the clocks go forward as much as on any other day. Doing this by hand is
 * how a cleanup silently runs twice on one October morning and not at all in March.
 */

/**
 * A parsed expression. Inert: croner starts a timer only when handed a function, and this is
 * never handed one — the tick loop lives in `scheduler.ts` and this is only ever asked
 * questions.
 *
 * Throws on a malformed expression, which is what `schedules.ts` relies on to turn a typo
 * into a boot failure rather than into 03:15 on some Tuesday when nothing happens.
 */
export function parseCron(expression: string, timezone: string): Cron {
  return new Cron(expression, { timezone })
}

/**
 * The next instant this expression is due, strictly after `from`.
 *
 * `null` when there is none — croner answers that for an expression pinned to a date that
 * has passed. Nothing in `SCHEDULES` can be, but this is a public function and a caller
 * reading a `Date | null` is a caller that handles it.
 */
export function nextRunAt(expression: string, timezone: string, from: Date): Date | null {
  return parseCron(expression, timezone).nextRun(from)
}

/**
 * Ceiling on the walk below. With the shipped defaults the real number is 12 — a
 * five-minute schedule over a one-hour catch-up window — and the pathological case is
 * `* * * * *` with the window at its 1440-minute maximum, which is 1440.
 *
 * The cap is not tuning. It is the guarantee that a future expression this file has not seen
 * cannot turn one tick into an unbounded loop inside a worker.
 */
const MAX_STEPS = 10_000

/**
 * The most recent instant this expression was due, at or before `now`, but no earlier than
 * `windowMs` ago. `null` when it has not been due inside that window.
 *
 * This is the whole catch-up rule, and it reads backwards from how it is implemented: a
 * worker started after a week away should fire last night's cleanup **once** and let the six
 * before it stay missed, rather than firing seven in a row into a database that is already
 * behind. The window is what draws that line, and `null` is a schedule that was missed.
 *
 * Implemented as a forward walk from the start of the window, because `nextRun` is croner's
 * only pure answer — `previousRun()` reports what *this instance* last executed, which for
 * an instance that never executes anything is always `undefined`. The walk is bounded twice:
 * by the window, and by `MAX_STEPS`.
 */
export function lastDueAt(
  expression: string,
  timezone: string,
  now: Date,
  windowMs: number,
): Date | null {
  const cron = parseCron(expression, timezone)
  const start = new Date(now.getTime() - windowMs)

  let cursor = cron.nextRun(start)
  let last: Date | null = null

  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (cursor === null || cursor.getTime() > now.getTime()) return last
    last = cursor
    cursor = cron.nextRun(cursor)
  }

  return last
}

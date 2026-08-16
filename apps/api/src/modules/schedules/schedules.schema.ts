import { z } from 'zod'

/**
 * The request shapes for the Scheduled jobs page.
 *
 * There is no list query. The registry is code and a handful of entries long, so a pager, a
 * sort and a filter would be three controls over six rows — see `docs/features/data-table.md`
 * on why `mode="none"` exists.
 */

/**
 * A registry key, and deliberately not an enum of the current ones.
 *
 * A `z.enum(SCHEDULE_KEYS)` would answer an unknown key with a 400 whose message lists every
 * schedule that does exist, which is a shape nobody asked for and a detail nobody outside
 * needs. The service answers a 404 instead — the same thing any other missing thing gets.
 */
export const scheduleKeyParam = z.object({
  key: z.string().trim().min(1).max(120),
})

export const listRunsQuery = z.object({
  /**
   * How much history the drawer shows. Capped for the same reason `perPage` is: the ceiling
   * is what stops `?limit=100000` turning one request into a full table read.
   */
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

export type ListRunsQuery = z.infer<typeof listRunsQuery>

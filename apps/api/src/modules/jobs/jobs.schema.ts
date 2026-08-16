import { z } from 'zod'

import { repeatable } from '#lib/query'

/**
 * The request shape for the Jobs page.
 *
 * There is no free-text search. A job name is a key in the `JOBS` catalog — a closed set
 * the console can offer as a facet — and `payload` is `jsonb`, so a `q` across it would be
 * a sequential scan over the table that grows fastest in the database, dressed up as a
 * feature.
 */

const jobStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled'])

export const listJobsQuery = z.object({
  status: repeatable(jobStatus).optional(),
  /** Exact match. Bounded because a catalog name is a code identifier, not prose. */
  name: repeatable(z.string().trim().min(1).max(120)).optional(),

  /** Coerced because query strings are text; capped for the reason given on `perPage`. */
  page: z.coerce.number().int().min(1).default(1),
  /**
   * The ceiling is what stops a crafted `?perPage=100000` from turning one request into a
   * full table read. The default matches what the console asks for.
   */
  perPage: z.coerce.number().int().min(1).max(100).default(20),

  /**
   * An enum, not a string. This is the whole security story of the endpoint: a column name
   * arriving as text and reaching an `ORDER BY` is an injection point, so the orderings the
   * API accepts are written down here and mapped to real columns in `queue.repo.ts`.
   */
  sort: z.enum(['createdAt', 'runAt', 'name', 'status']).default('createdAt'),
  /** Newest first: the question this page answers is almost always "what just happened". */
  order: z.enum(['asc', 'desc']).default('desc'),
})

export type ListJobsQuery = z.infer<typeof listJobsQuery>

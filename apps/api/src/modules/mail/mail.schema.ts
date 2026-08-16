import { z } from 'zod'

import { repeatable } from '#lib/query'

/**
 * The request shape for the Mail log page.
 *
 * `template` is a bounded string rather than an enum of the current registry, for the same
 * reason `jobs.name` is: a message sent last year under a template since renamed is still a
 * row, and a filter that could not name it would be a filter that cannot find the one
 * message somebody is looking for.
 */

const mailStatus = z.enum(['queued', 'sent', 'failed'])

export const listMailQuery = z.object({
  status: repeatable(mailStatus).optional(),
  template: repeatable(z.string().trim().min(1).max(120)).optional(),

  /**
   * Matched against the recipient address and the subject. Not the body: it is the largest
   * column in the table, and the interesting parts of the stored copy read `[redacted]`.
   */
  q: z.string().trim().max(200).optional(),

  page: z.coerce.number().int().min(1).default(1),
  /**
   * The ceiling is what stops a crafted `?perPage=100000` from turning one request into a
   * full table read. The default matches what the console asks for.
   */
  perPage: z.coerce.number().int().min(1).max(100).default(20),

  /**
   * An enum, not a string. A column name arriving as text and reaching an `ORDER BY` is an
   * injection point, so the orderings the API accepts are written here and mapped to real
   * columns in `mail.repo.ts`.
   */
  sort: z.enum(['createdAt', 'sentAt', 'status']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
})

export type ListMailQuery = z.infer<typeof listMailQuery>

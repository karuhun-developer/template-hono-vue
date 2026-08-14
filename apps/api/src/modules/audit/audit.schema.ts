import { z } from 'zod'

/**
 * The request shape for reading the trail.
 *
 * Every filter is optional and every one of them is an **exact match**: the audit page is
 * for answering "what happened to this user" or "what did this person do", and a free-text
 * search across `before` / `after` would be a sequential scan over the largest table in the
 * database dressed up as a feature.
 */

const uuid = z.uuid('Not a valid id.')

export const listAuditLogsQuery = z.object({
  /** e.g. `user.disable` — the same vocabulary as the permission keys. */
  action: z.string().trim().max(64).optional(),
  subjectType: z.string().trim().max(64).optional(),
  subjectId: uuid.optional(),
  actorId: uuid.optional(),

  /** The `nextCursor` of the previous page — the id of the last row that was shown. */
  cursor: uuid.optional(),

  /**
   * Coerced because query strings are text. Capped at 100: the ceiling is what stops a
   * crafted `?limit=100000` from turning one request into a full table read.
   */
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuery>

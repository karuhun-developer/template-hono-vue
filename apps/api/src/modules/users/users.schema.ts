import { z } from 'zod'

import { email } from '#modules/auth/auth.schema'

/**
 * The shape of user management requests.
 *
 * `roleIds` is sent whole or not at all, and that distinction carries weight: the roles of
 * a user are stored delete-then-write, so a `PATCH` that could not tell "unchanged" from
 * "cleared" would strip somebody's access every time an admin fixed a typo in their name.
 * Omitted means leave them alone; present means this is now the complete list.
 */

const uuid = z.uuid('Not a valid id.')

const name = z.string().trim().min(1, 'A name is required.').max(120)

/**
 * At most 20 roles — not a business rule, a sanity limit. A payload carrying thousands of
 * ids is only a way of making one transaction run for a long time.
 */
const roleIds = z
  .array(uuid)
  .min(1, 'Pick at least one role.')
  .max(20, 'That is too many roles.')
  .transform((ids) => [...new Set(ids)])

export const inviteUserBody = z.object({ email, name, roleIds })

export type InviteUserBody = z.infer<typeof inviteUserBody>

export const updateUserBody = z
  .object({
    name: name.optional(),
    roleIds: roleIds.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change — send at least one field.')

export type UpdateUserBody = z.infer<typeof updateUserBody>

/**
 * Reading the list.
 *
 * `sort` is an enum rather than a string, and that is the whole security story of this
 * endpoint: a column name that arrives as text and is spliced into an `ORDER BY` is an
 * injection point, so the set of orderings the API accepts is written down here and
 * mapped to actual columns in the repository. Nothing else can reach the query.
 */
export const listUsersQuery = z.object({
  status: z.enum(['invited', 'active', 'disabled']).optional(),
  /** Matched against the name or the email. */
  q: z.string().trim().max(120).optional(),
  /** Everyone holding this role. Exact match on the id — role names are not unique enough. */
  roleId: uuid.optional(),

  /** Coerced because query strings are text; capped for the reason given on `perPage`. */
  page: z.coerce.number().int().min(1).default(1),
  /**
   * The ceiling is what stops a crafted `?perPage=100000` from turning one request into a
   * full table read. The default matches what the console asks for.
   */
  perPage: z.coerce.number().int().min(1).max(100).default(10),

  sort: z.enum(['name', 'email', 'status', 'lastLoginAt', 'createdAt']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
})

export type ListUsersQuery = z.infer<typeof listUsersQuery>

export type ListUsersSort = ListUsersQuery['sort']

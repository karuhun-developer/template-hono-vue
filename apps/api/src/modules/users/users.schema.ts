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

export const listUsersQuery = z.object({
  status: z.enum(['invited', 'active', 'disabled']).optional(),
  /** Matched against the name or the email. */
  q: z.string().trim().max(120).optional(),
})

export type ListUsersQuery = z.infer<typeof listUsersQuery>

import { PERMISSION_KEYS } from '@app/contract'
import { z } from 'zod'

/**
 * The shape of role management requests.
 *
 * `permissions` is validated against the catalog in `@app/contract` rather than being
 * accepted as `z.string()`. A mistyped key would otherwise reach `role_permissions`, never
 * match anything once `loadAccess()` filters it out, and surface as a role that is "ticked
 * but still refused" — the kind of complaint that costs an afternoon to track down.
 */

const permissionKey = z.enum(PERMISSION_KEYS as [string, ...string[]])

const permissions = z.array(permissionKey).max(PERMISSION_KEYS.length)

const name = z.string().trim().min(1, 'A role name is required.').max(60)

const description = z
  .string()
  .trim()
  .max(240)
  .transform((value) => (value === '' ? null : value))

export const createRoleBody = z.object({
  name,
  description: description.optional(),
  permissions: permissions.min(1, 'Pick at least one permission.'),
})

export type CreateRoleBody = z.infer<typeof createRoleBody>

export const updateRoleBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    permissions: permissions.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change — send at least one field.')

export type UpdateRoleBody = z.infer<typeof updateRoleBody>

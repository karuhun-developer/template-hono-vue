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

/**
 * Reading the list.
 *
 * The same envelope and the same caps as `listUsersQuery`, for the same reasons — see the
 * note there about why `sort` is an enum. Roles are a short list in every installation
 * this template is a starting point for, but "short" is not a property the API can check.
 *
 * `perPage` defaults higher than the user list because two dialogs need every role at once
 * to render their checkboxes; they ask for `perPage=100` and the ceiling holds them there.
 */
export const listRolesQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.enum(['name', 'key', 'usedBy']).default('name'),
  order: z.enum(['asc', 'desc']).default('asc'),
})

export type ListRolesQuery = z.infer<typeof listRolesQuery>

export type ListRolesSort = ListRolesQuery['sort']

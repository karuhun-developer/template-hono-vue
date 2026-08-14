import { boolean, pgTable, primaryKey, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

import { primaryId, timestamps } from '#db/columns'
import { users } from '#db/schema/identity'

/**
 * RBAC: the permission catalog, the roles, and who holds which role.
 *
 * The catalog is the vocabulary; the roles are the policy. Keeping them in separate
 * tables is what lets an administrator invent a role you never thought of without anyone
 * writing code — while the set of things a role *can* grant stays bounded by what the API
 * actually enforces.
 */

/**
 * Seeded from `PERMISSIONS` in `packages/contract/src/rbac.ts`. The `key` is the primary
 * key directly: there is nothing to gain from adding a uuid to a value that is already
 * unique, stable, and readable in a query.
 */
export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  group: text('group').notNull(),
  label: text('label').notNull(),
  ...timestamps(),
})

export type Permission = typeof permissions.$inferSelect
export type NewPermission = typeof permissions.$inferInsert

export const roles = pgTable(
  'roles',
  {
    id: primaryId(),

    /** `owner`, `admin`, … For a role somebody creates, slugged from its name. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),

    /**
     * Cloned from `SYSTEM_ROLES`. Its permissions may be edited, but the role itself
     * cannot be deleted: removing `owner` would leave the installation with nobody able
     * to grant anything back, and there is no obvious way to undo that.
     */
    isSystem: boolean('is_system').notNull().default(false),

    ...timestamps(),
  },
  (table) => [uniqueIndex('roles_key_key').on(table.key)],
)

export type Role = typeof roles.$inferSelect
export type NewRole = typeof roles.$inferInsert

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionKey: text('permission_key')
      .notNull()
      .references(() => permissions.key, { onDelete: 'cascade' }),
    ...timestamps(),
  },
  (table) => [primaryKey({ columns: [table.roleId, table.permissionKey] })],
)

export type RolePermission = typeof rolePermissions.$inferSelect
export type NewRolePermission = typeof rolePermissions.$inferInsert

export const userRoles = pgTable(
  'user_roles',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * `restrict`, not `cascade`. "You cannot delete a role somebody still holds" is a rule
     * the service states in a friendly 409 — but two requests racing each other can slip
     * between that check and the delete. The constraint is what makes the rule true rather
     * than likely.
     */
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),

    ...timestamps(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
)

export type UserRole = typeof userRoles.$inferSelect
export type NewUserRole = typeof userRoles.$inferInsert

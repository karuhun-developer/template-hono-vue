/**
 * The permission catalog and the system roles — shared by the API (which enforces
 * them), the console (which renders the checkbox matrix), and the seeder (which writes
 * them to the database).
 *
 * Keys are named `<domain>.<action>`, and **a dangerous verb gets its own key**. If
 * "edit a user" and "disable a user" shared one key, the only way to let someone fix a
 * typo in a name would be to also let them lock people out.
 *
 * That is why `user.create` is not folded into `user.invite`: inviting hands out a link
 * and the person chooses their own password, while creating sets one on their behalf.
 * And why `user.reset_password` is its own key rather than part of `user.update`: it
 * starts a credential flow on somebody else's account, which is not something the
 * permission for correcting a name should quietly also do.
 *
 * This catalog is deliberately small. A permission with no route behind it is worse
 * than a missing one: nobody can tell whether it is wired up or aspirational. Add keys
 * as you add the endpoints that check them — see docs/guides/add-api-module.md.
 */

export const PERMISSION_GROUPS = ['users', 'roles', 'audit', 'operations'] as const

export type PermissionGroup = (typeof PERMISSION_GROUPS)[number]

export type PermissionDefinition = {
  readonly key: string
  readonly group: PermissionGroup
  readonly label: string
}

export const PERMISSIONS = [
  // Users
  { key: 'user.read', group: 'users', label: 'View users' },
  { key: 'user.invite', group: 'users', label: 'Invite users' },
  { key: 'user.create', group: 'users', label: 'Create users with a password' },
  { key: 'user.update', group: 'users', label: 'Edit users and their roles' },
  { key: 'user.disable', group: 'users', label: 'Enable and disable users' },
  { key: 'user.delete', group: 'users', label: 'Delete and restore users' },
  { key: 'user.reset_password', group: 'users', label: "Reset another user's password" },

  // Roles
  { key: 'role.read', group: 'roles', label: 'View roles' },
  { key: 'role.manage', group: 'roles', label: 'Create, edit and delete roles' },

  // Audit
  { key: 'audit.read', group: 'audit', label: 'View the audit log' },

  // Operations
  //
  // Reading and administering are split for the usual reason: "what happened to that
  // invitation email" is a support question, while retrying a job re-runs code against
  // live data and cancelling one throws work away.
  { key: 'job.read', group: 'operations', label: 'View background jobs' },
  { key: 'job.manage', group: 'operations', label: 'Retry and cancel background jobs' },
  { key: 'mail.read', group: 'operations', label: 'View the mail log' },
  { key: 'schedule.read', group: 'operations', label: 'View scheduled jobs' },
  { key: 'schedule.run', group: 'operations', label: 'Run a scheduled job now' },
] as const satisfies readonly PermissionDefinition[]

export type PermissionKey = (typeof PERMISSIONS)[number]['key']

export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSIONS.map((p) => p.key)

export function isPermissionKey(value: string): value is PermissionKey {
  return (PERMISSION_KEYS as readonly string[]).includes(value)
}

// --- System roles -----------------------------------------------------------

export type SystemRoleDefinition = {
  readonly key: string
  readonly name: string
  readonly description: string
  /** `'*'` means the whole catalog — so a new permission reaches the owner automatically. */
  readonly permissions: readonly PermissionKey[] | '*'
}

/**
 * The roles `make seed` creates.
 *
 * The split between `owner` and `admin` is not decorative. An admin can manage roles but
 * holds none of the dangerous user keys and not `audit.read`, which makes the
 * two-directional grantable rule visible the first time you log in as one: those
 * checkboxes render disabled, and opening the `owner` role gives a locked matrix. See
 * docs/features/rbac.md.
 *
 * "Owner-only" is the whole superadmin story in this template: a key that is in the
 * catalog and absent from `admin`. There is no `isSuperadmin` flag anywhere, and adding
 * one would be the first thing in this codebase that a role could not express.
 */
export const SYSTEM_ROLES = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full access. New permissions are granted automatically.',
    permissions: '*',
  },
  {
    key: 'admin',
    name: 'Administrator',
    description:
      'Manages people and roles. Deliberately without the owner-only keys, so the grantable rule has something to demonstrate.',
    permissions: ['user.read', 'user.invite', 'user.update', 'role.read', 'role.manage'],
  },
  {
    key: 'member',
    name: 'Member',
    description: 'Can see who else is in the application, and nothing more.',
    permissions: ['user.read'],
  },
] as const satisfies readonly SystemRoleDefinition[]

export type SystemRoleKey = (typeof SYSTEM_ROLES)[number]['key']

/** Expand `'*'` into the real list. Used by the seeder and by role provisioning. */
export function resolveRolePermissions(role: SystemRoleDefinition): readonly PermissionKey[] {
  return role.permissions === '*' ? PERMISSION_KEYS : role.permissions
}

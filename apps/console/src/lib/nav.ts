import type { PermissionKey } from '@app/contract'
import { LayoutDashboard, ListChecks, ScrollText, ShieldCheck, Users } from '@lucide/vue'
import type { Component } from 'vue'

/**
 * What the shell's navigation contains.
 *
 * The rule: **an item is added in the same commit as its page**, never earlier as a
 * placeholder. A menu item that leads to an empty screen reads as a broken feature rather
 * than as one that has not arrived yet. That is why there are two groups here and not the
 * six an admin template usually ships with — these are the pages that exist.
 *
 * `permission` here decides what is *visible*, not what is *allowed* — see the note at the
 * top of `lib/access.ts`.
 */

export type NavChild = {
  to: string
  label: string
  permission?: PermissionKey
}

export type NavItem = {
  /**
   * Where the row goes — and, for a row with `children`, the prefix that marks the whole
   * group active. A parent is a disclosure, not a destination: clicking it expands.
   */
  to: string
  label: string
  icon: Component
  permission?: PermissionKey
  /** Present means this row expands instead of navigating. */
  children?: readonly NavChild[]
}

export type NavGroup = {
  label: string
  items: readonly NavItem[]
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'General',
    items: [
      { to: '/', label: 'Overview', icon: LayoutDashboard },
      { to: '/users', label: 'Users', icon: Users, permission: 'user.read' },
      { to: '/roles', label: 'Roles', icon: ShieldCheck, permission: 'role.read' },
    ],
  },
  {
    label: 'Audit',
    items: [{ to: '/audit-log', label: 'Audit log', icon: ScrollText, permission: 'audit.read' }],
  },
  /**
   * Owner-only, and achieved with no "superadmin" concept anywhere: every key in this group
   * is in the catalog and absent from the Administrator role, so `visibleGroups()` drops the
   * whole group — heading included — for an admin.
   */
  {
    label: 'Operations',
    items: [{ to: '/jobs', label: 'Jobs', icon: ListChecks, permission: 'job.read' }],
  },
]

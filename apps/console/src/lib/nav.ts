import type { PermissionKey } from '@app/contract'
import { LayoutDashboard, ScrollText, ShieldCheck, Users } from '@lucide/vue'
import type { Component } from 'vue'

/**
 * What the shell's navigation contains.
 *
 * The rule: **an item is added in the same commit as its page**, never earlier as a
 * placeholder. A menu item that leads to an empty screen reads as a broken feature rather
 * than as one that has not arrived yet.
 *
 * `permission` here decides what is *visible*, not what is *allowed* — see the note at the
 * top of `lib/access.ts`.
 */

export type NavItem = {
  to: string
  label: string
  icon: Component
  permission?: PermissionKey
}

export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard },
  { to: '/users', label: 'Users', icon: Users, permission: 'user.read' },
  { to: '/roles', label: 'Roles', icon: ShieldCheck, permission: 'role.read' },
  { to: '/audit-log', label: 'Audit log', icon: ScrollText, permission: 'audit.read' },
]

import type { PermissionKey } from '@app/contract'

import type { NavGroup, NavItem } from '@/lib/nav'

/**
 * The pure part of authorisation on the client.
 *
 * Worth stating once and remembering forever: **this enforces nothing.** Enforcement is
 * `requirePermission()` in the API, and it has to stay there even after the button has
 * been hidden here — a hidden button is one `fetch` away from not being hidden. These
 * functions only decide what is worth showing, because offering somebody a menu item that
 * always ends in a 403 is the most annoying possible way to tell them they lack access.
 */

export function hasPermission(
  granted: readonly string[],
  needed: PermissionKey | undefined,
): boolean {
  if (needed === undefined) return true
  return granted.includes(needed)
}

/** All of them, not any — following `requirePermission()` in the API. */
export function hasAllPermissions(
  granted: readonly string[],
  needed: readonly PermissionKey[],
): boolean {
  return needed.every((key) => granted.includes(key))
}

/**
 * Which navigation items are worth rendering.
 *
 * The rule is deliberately identical to `decideNavigation()` below. Any difference
 * between the two shows up as a menu item that leads to the "access denied" page.
 */
export function visibleItems<T extends { permission?: PermissionKey }>(
  items: readonly T[],
  state: Pick<NavigationState, 'permissions'>,
): T[] {
  return items.filter((item) => hasPermission(state.permissions, item.permission))
}

/**
 * The same filter, one level up.
 *
 * A group whose every item was filtered away is dropped rather than rendered as a heading
 * with nothing under it — which is how somebody without `audit.read` would otherwise see
 * the word "Audit" and conclude the page failed to load.
 *
 * Items that expand are filtered on both levels: their children go through the same rule,
 * and a parent left with none is dropped too.
 */
export function visibleGroups(
  groups: readonly NavGroup[],
  state: Pick<NavigationState, 'permissions'>,
): { label: string; items: NavItem[] }[] {
  return groups
    .map((group) => ({
      label: group.label,
      items: visibleItems(group.items, state)
        .map((item) =>
          item.children ? { ...item, children: visibleItems(item.children, state) } : item,
        )
        .filter((item) => item.children === undefined || item.children.length > 0),
    }))
    .filter((group) => group.items.length > 0)
}

/**
 * The permissions a role carries that the caller does not hold.
 *
 * This is the client half of `removedBeyondReach` in `roles.service.ts`. When it comes back
 * non-empty, the role is one the caller may **not** re-tick at all: the API refuses both
 * directions — handing out a permission you lack, and quietly dropping one you lack — so
 * the only save that could succeed is one that does not touch the permissions.
 *
 * Returning the keys rather than a boolean is what lets the matrix say *which* ones.
 */
export function beyondReach(held: readonly string[], granted: readonly string[]): string[] {
  return held.filter((key) => !granted.includes(key))
}

// --- The navigation decision ------------------------------------------------

export type NavigationState = {
  authenticated: boolean
  permissions: readonly string[]
}

export type RouteNeed = {
  /** `false` only for the sign-in, invitation and error pages. */
  requiresAuth: boolean
  permission?: PermissionKey | undefined
}

export type NavigationDecision =
  { kind: 'allow' } | { kind: 'login'; next: string } | { kind: 'forbidden' } | { kind: 'home' }

/**
 * Split out of `router.beforeEach` so it can be tested without assembling a router, and
 * so the rules read as one list instead of being scattered between early returns.
 *
 * Where somebody was heading is kept as `next` when they are sent to the sign-in page: a
 * session that expires mid-task must not cost them the walk back through the menu.
 */
export function decideNavigation(
  state: NavigationState,
  need: RouteNeed,
  fullPath: string,
): NavigationDecision {
  if (!need.requiresAuth) {
    // Signed in and opening the sign-in page again — usually the back button.
    return state.authenticated && isLoginPath(fullPath) ? { kind: 'home' } : { kind: 'allow' }
  }

  // Session before permission: without one, the permission list is empty anyway, but the
  // honest answer is "sign in", not "you lack access".
  if (!state.authenticated) return { kind: 'login', next: fullPath }

  if (!hasPermission(state.permissions, need.permission)) return { kind: 'forbidden' }

  return { kind: 'allow' }
}

export const LOGIN_PATH = '/login'
export const FORBIDDEN_PATH = '/forbidden'

function isLoginPath(fullPath: string): boolean {
  return fullPath === LOGIN_PATH || fullPath.startsWith(`${LOGIN_PATH}?`)
}

/**
 * `next` comes out of a query string, so it is input somebody else controls. Only internal
 * paths are accepted: `//evil.example` and `https://…` are both thrown away, because both
 * are off-site redirects triggered through a link.
 */
export function safeRedirect(next: unknown, fallback = '/'): string {
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return fallback
  return next
}

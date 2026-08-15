import { describe, expect, it } from 'vitest'

import {
  beyondReach,
  decideNavigation,
  safeRedirect,
  visibleGroups,
  visibleItems,
} from '@/lib/access'

/**
 * The route guard is tested here rather than through an assembled router.
 *
 * What needs pinning down is not "was `next()` called" but the rules themselves: an
 * expired session sends you to the sign-in page **remembering where you were going**, a
 * missing permission lands on its own page rather than being quietly bounced home (which
 * makes people click the same menu item over and over), and `next` from a query string
 * cannot be used to walk somebody off the site.
 */

/** A stand-in for the lucide component a real nav item carries; nothing here renders. */
const Icon = { name: 'Icon' }

const anon = { authenticated: false, permissions: [] }
const member = { authenticated: true, permissions: ['user.read'] }

describe('decideNavigation', () => {
  it('sends you to sign in, keeping where you were going', () => {
    expect(decideNavigation(anon, { requiresAuth: true }, '/users?q=ana')).toEqual({
      kind: 'login',
      next: '/users?q=ana',
    })
  })

  it('lets a public page open without a session', () => {
    expect(decideNavigation(anon, { requiresAuth: false }, '/login')).toEqual({ kind: 'allow' })
  })

  it('sends somebody already signed in away from the sign-in page', () => {
    expect(decideNavigation(member, { requiresAuth: false }, '/login')).toEqual({ kind: 'home' })
    expect(decideNavigation(member, { requiresAuth: false }, '/login?next=/users')).toEqual({
      kind: 'home',
    })
  })

  it('does not send them away from other public pages', () => {
    expect(decideNavigation(member, { requiresAuth: false }, '/forbidden')).toEqual({
      kind: 'allow',
    })
  })

  it('allows a route that asks for no permission', () => {
    expect(decideNavigation(member, { requiresAuth: true }, '/')).toEqual({ kind: 'allow' })
  })

  it('refuses a permission that is not held, instead of redirecting home', () => {
    expect(
      decideNavigation(member, { requiresAuth: true, permission: 'role.read' }, '/roles'),
    ).toEqual({ kind: 'forbidden' })
  })

  it('puts the session question before the permission question', () => {
    // Without a session the permission list is empty too, but the answer has to be
    // "sign in first", not "you lack access".
    expect(
      decideNavigation(anon, { requiresAuth: true, permission: 'role.read' }, '/roles'),
    ).toEqual({ kind: 'login', next: '/roles' })
  })
})

describe('safeRedirect', () => {
  it('accepts an internal path', () => {
    expect(safeRedirect('/users?q=ana')).toBe('/users?q=ana')
  })

  it.each([
    ['another host', 'https://evil.example/'],
    ['protocol-relative', '//evil.example/'],
    ['not a string', 42],
    ['nothing at all', undefined],
  ])('rejects %s', (_label, value) => {
    expect(safeRedirect(value)).toBe('/')
  })
})

describe('beyondReach', () => {
  const granted = ['user.read', 'user.invite', 'role.read', 'role.manage']

  it('finds nothing when the role stays inside what the caller holds', () => {
    expect(beyondReach(['user.read', 'role.read'], granted)).toEqual([])
  })

  it('names the permissions the caller cannot touch', () => {
    // An admin opening the owner role: `audit.read` is why the whole matrix locks.
    expect(beyondReach(['user.read', 'audit.read', 'user.disable'], granted)).toEqual([
      'audit.read',
      'user.disable',
    ])
  })

  it('treats an empty role as within reach', () => {
    expect(beyondReach([], granted)).toEqual([])
  })
})

describe('visibleItems', () => {
  const items = [
    { to: '/', label: 'Overview' },
    { to: '/users', label: 'Users', permission: 'user.read' as const },
    { to: '/roles', label: 'Roles', permission: 'role.read' as const },
  ]

  it('filters what needs a permission and keeps what does not', () => {
    expect(visibleItems(items, member).map((item) => item.to)).toEqual(['/', '/users'])
  })
})

describe('visibleGroups', () => {
  const groups = [
    {
      label: 'General',
      items: [
        { to: '/', label: 'Overview', icon: Icon },
        { to: '/users', label: 'Users', icon: Icon, permission: 'user.read' as const },
      ],
    },
    {
      label: 'Audit',
      items: [
        { to: '/audit-log', label: 'Audit log', icon: Icon, permission: 'audit.read' as const },
      ],
    },
  ]

  it('drops a group once everything inside it is out of reach', () => {
    expect(visibleGroups(groups, member).map((group) => group.label)).toEqual(['General'])
  })

  it('keeps the group when at least one item survives', () => {
    const auditor = { authenticated: true, permissions: ['audit.read'] }

    expect(visibleGroups(groups, auditor)).toEqual([
      { label: 'General', items: [{ to: '/', label: 'Overview', icon: Icon }] },
      { label: 'Audit', items: groups[1]?.items },
    ])
  })

  /** A row that expands is only worth rendering while something is left under it. */
  it('filters children too, and drops a parent left with none', () => {
    const nested = [
      {
        label: 'General',
        items: [
          {
            to: '/reports',
            label: 'Reports',
            icon: Icon,
            children: [{ to: '/reports/audit', label: 'Audit', permission: 'audit.read' as const }],
          },
        ],
      },
    ]

    expect(visibleGroups(nested, member)).toEqual([])
  })
})

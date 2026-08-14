import { describe, expect, it } from 'vitest'

import { decideNavigation, safeRedirect, visibleItems } from '@/lib/access'

/**
 * The route guard is tested here rather than through an assembled router.
 *
 * What needs pinning down is not "was `next()` called" but the rules themselves: an
 * expired session sends you to the sign-in page **remembering where you were going**, a
 * missing permission lands on its own page rather than being quietly bounced home (which
 * makes people click the same menu item over and over), and `next` from a query string
 * cannot be used to walk somebody off the site.
 */

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

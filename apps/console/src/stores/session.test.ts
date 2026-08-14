import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStore } from '@/stores/session'

/**
 * The session store is tested with a stubbed `fetch`. What is interesting here is not the
 * network but the decisions: a 401 is an answer rather than an error, permissions are
 * never kept in the browser, and "Sign out" clears the screen whatever the server says.
 */

const me = {
  user: { id: 'u-1', email: 'owner@example.test', name: 'Owner' },
  permissions: ['user.read', 'role.read'],
}

const jsonOk = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('bootstrap', () => {
  it('treats a 401 as an answer, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })))

    const session = useSessionStore()
    await session.bootstrap()

    expect(session.status).toBe('anonymous')
    expect(session.isAuthenticated).toBe(false)
    expect(session.permissions).toEqual([])
  })

  it('ends anonymous when the network is down, rather than hanging on loading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const session = useSessionStore()
    await session.bootstrap()

    expect(session.status).toBe('anonymous')
  })

  it('fills in the identity and the permissions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonOk(me)))

    const session = useSessionStore()
    await session.bootstrap()

    expect(session.status).toBe('authenticated')
    expect(session.user?.email).toBe('owner@example.test')
    expect(session.permissions).toEqual(['user.read', 'role.read'])
    expect(session.can('user.read')).toBe(true)
    expect(session.can('audit.read')).toBe(false)
  })

  it('sends one request even when asked several times at once', async () => {
    // The route guard and the components both ask for it while booting. Two requests
    // would mean the second one sees a half-finished status.
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(me))
    vi.stubGlobal('fetch', fetchMock)

    const session = useSessionStore()
    await Promise.all([session.bootstrap(), session.bootstrap(), session.ensureReady()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the cookie, which is the whole session', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonOk(me))
    vi.stubGlobal('fetch', fetchMock)

    await useSessionStore().bootstrap()

    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
    expect(init.credentials).toBe('include')
  })
})

describe('login', () => {
  it('returns the API message without changing the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: 'unauthorized', message: 'Invalid email or password.' },
          }),
          { status: 401, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )

    const session = useSessionStore()
    const failure = await session.login({ email: 'a@b.test', password: 'x' })

    expect(failure?.message).toBe('Invalid email or password.')
    expect(session.isAuthenticated).toBe(false)
  })

  it('takes the identity from /auth/me, not from the login body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonOk({ user: { id: 'u-1' }, expiresAt: '2026-01-01T00:00:00.000Z' }))
      .mockResolvedValueOnce(jsonOk(me))
    vi.stubGlobal('fetch', fetchMock)

    const session = useSessionStore()
    const failure = await session.login({ email: 'owner@example.test', password: 'secret' })

    expect(failure).toBeNull()
    expect(session.permissions).toEqual(['user.read', 'role.read'])
  })
})

describe('logout', () => {
  it('clears the client side even when the server does not answer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(me))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.stubGlobal('fetch', fetchMock)

    const session = useSessionStore()
    await session.bootstrap()
    await session.logout().catch(() => undefined)

    expect(session.status).toBe('anonymous')
    expect(session.user).toBeNull()
    expect(session.permissions).toEqual([])
  })
})

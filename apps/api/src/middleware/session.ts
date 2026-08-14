import type { Context, MiddlewareHandler } from 'hono'

import { unauthorized } from '#lib/errors'
import { readSessionCookie } from '#lib/session-cookie'
import { looksLikeToken } from '#lib/token'
import type { AppBindings } from '#middleware/request-context'
import { loadAccess, type AccessContext } from '#modules/rbac/rbac.repo'
import { findLiveSession, touchSession, type LiveSession } from '#platform/session.repo'

/**
 * The identity layer: cookie → session row → the person making the request, and what they
 * are allowed to do.
 *
 * Split into two middlewares that stack rather than one that does everything:
 *
 * - `sessionContext()` is mounted **globally**. It reads the cookie if there is one and
 *   stays quiet if there is not, so public endpoints — the invitation pages, health —
 *   keep working.
 * - `requireAuth()` turns away anyone without a session, and loads their permissions.
 *
 * A route that forgot its guard is visible as a route that never calls `requireAuth()`,
 * and `currentUser(c)` will throw the moment it is reached rather than quietly handing
 * back `undefined`.
 */

/** Do not write `last_seen_at` more often than this. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000

export const sessionContext = (): MiddlewareHandler<AppBindings> => {
  return async (c, next) => {
    const token = readSessionCookie(c)

    // A malformed value does not deserve a query. Stale cookies from an older deployment
    // and automated scanners are far more numerous than they look.
    if (token && looksLikeToken(token, 'session')) {
      const session = await findLiveSession(token)
      if (session) {
        c.set('session', session)
        c.set('logger', c.get('logger').child({ sessionId: session.id }))
      }
    }

    await next()

    const session = c.get('session')
    if (session && Date.now() - session.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
      // Deliberately not awaited: a response must not wait on a write that only updates
      // a "last used" column.
      void touchSession(session.id).catch((err: unknown) => {
        c.get('logger').warn({ err }, 'failed to update the session last_seen_at')
      })
    }
  }
}

/**
 * The permissions are loaded here rather than lazily inside each handler so that
 * `requirePermission()` can stay synchronous and, more importantly, so that there is
 * exactly one query per request no matter how many checks a route performs.
 */
export const requireAuth = (): MiddlewareHandler<AppBindings> => {
  return async (c, next) => {
    const session = c.get('session')
    if (!session) throw unauthorized()

    c.set('access', await loadAccess(session.user.id))

    await next()
  }
}

/**
 * Accessors that **throw when their middleware was never mounted**.
 *
 * Without them every handler would write `const session = c.get('session')` and then check
 * for `undefined` — and sooner or later somebody writes `!` instead and it detonates in
 * production as `Cannot read properties of undefined`. The messages below name the
 * middleware that is missing.
 */

export function currentSession(c: Context<AppBindings>): LiveSession {
  const session = c.get('session')
  if (!session) throw new Error('currentSession(): this route is missing requireAuth()')
  return session
}

export function currentUser(c: Context<AppBindings>): LiveSession['user'] {
  return currentSession(c).user
}

export function currentAccess(c: Context<AppBindings>): AccessContext {
  const access = c.get('access')
  if (!access) throw new Error('currentAccess(): this route is missing requireAuth()')
  return access
}

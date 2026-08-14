import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'

import { badRequest } from '#lib/errors'
import { clientInfo } from '#lib/request-info'
import { clearSessionCookie, readSessionCookie, setSessionCookie } from '#lib/session-cookie'
import type { AppBindings } from '#middleware/request-context'
import { currentUser, requireAuth } from '#middleware/session'
import { acceptInviteBody, loginBody } from '#modules/auth/auth.schema'
import {
  acceptInvitation,
  loginUser,
  logout,
  previewInvite,
  type LoginResult,
} from '#modules/auth/auth.service'

/**
 * The auth endpoints.
 *
 * The session token **never** appears in a response body — only in the `httpOnly` cookie.
 * Send it back as well and a client will be tempted to keep its own copy, which undoes the
 * entire reason for `httpOnly`.
 *
 * `GET /auth/me` is what the console calls on boot. It answers "am I still signed in?" and
 * "what am I allowed to do?" in one round trip, so the shell does not have to render twice.
 */

/**
 * Validation failures are thrown as `ApiError` instead of being answered by zValidator
 * itself, so the error body has the same shape as every other endpoint and the frontend
 * only needs one error reader.
 */
const validationHook = (result: { success: boolean; error?: unknown }): void => {
  if (result.success) return
  throw badRequest('The details you sent are not valid.', result.error)
}

function loginResponse(result: LoginResult): {
  user: { id: string; email: string; name: string }
  expiresAt: string
} {
  const { principal } = result
  return {
    user: { id: principal.id, email: principal.email, name: principal.name },
    expiresAt: result.session.expiresAt.toISOString(),
  }
}

export const authRoutes = new Hono<AppBindings>()
  .post('/login', zValidator('json', loginBody, validationHook), async (c) => {
    const body = c.req.valid('json')
    const result = await loginUser(body, clientInfo(c))

    setSessionCookie(c, result.session.token, result.session.expiresAt)
    c.get('logger').info({ userId: result.principal.id }, 'signed in')

    return c.json(loginResponse(result))
  })
  /**
   * The two invitation endpoints are deliberately **public**: the people who open them are
   * precisely the ones without an active account. The capability lives in the token itself.
   */
  .get('/invitation/:token', async (c) => {
    return c.json({ invitation: await previewInvite(c.req.param('token')) })
  })
  .post('/invitation/accept', zValidator('json', acceptInviteBody, validationHook), async (c) => {
    const body = c.req.valid('json')
    const result = await acceptInvitation(body, clientInfo(c))

    setSessionCookie(c, result.session.token, result.session.expiresAt)
    c.get('logger').info({ userId: result.principal.id }, 'invitation accepted')

    return c.json(loginResponse(result))
  })
  .get('/me', requireAuth(), (c) => {
    const user = currentUser(c)

    return c.json({
      user: { id: user.id, email: user.email, name: user.name },
    })
  })
  .post('/logout', async (c) => {
    // The cookie is cleared first, whatever the revocation does in the database. Reverse
    // the order and a database problem leaves the browser holding a cookie whose owner
    // believes they have signed out.
    const token = readSessionCookie(c)
    clearSessionCookie(c)
    await logout(token)

    return c.json({ ok: true as const })
  })

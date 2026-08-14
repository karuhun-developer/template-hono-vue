import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { CookieOptions } from 'hono/utils/cookie'

import { env, isProduction } from '#env'

/**
 * The session cookie.
 *
 * The session token lives in an `httpOnly` cookie, not in `localStorage`. There is one
 * reason and it is enough: a single XSS on any page can read `localStorage` and post the
 * token elsewhere, while an `httpOnly` cookie is invisible to JavaScript entirely. The
 * price is that the cookie is sent automatically, so CSRF has to be handled separately —
 * which is the job of `SameSite` below plus the CORS origin list in `app.ts`.
 */

/**
 * `Lax`, not `None`.
 *
 * In development, `localhost:7301` → `localhost:7300` is already same-site (ports do not
 * count), and in production both sides sit under one apex domain. So `Lax` is sufficient,
 * and it closes CSRF for every non-GET request from another site without a separate CSRF
 * token. `None` would reopen that door for a capability we may never need.
 *
 * `Strict` is rejected for a different reason: a link from an email or a chat app into the
 * console would land looking signed-out, and people would conclude their session had been
 * lost.
 */
const SAME_SITE = 'Lax' as const

function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: SAME_SITE,
    // `Secure` has to be off in development — `localhost` over HTTP will not accept it,
    // and the failure is silent: the cookie is simply never stored.
    secure: isProduction,
    path: '/',
  }
}

export function setSessionCookie(c: Context, token: string, expiresAt: Date): void {
  setCookie(c, env.SESSION_COOKIE_NAME, token, {
    ...baseOptions(),
    expires: expiresAt,
  })
}

export function readSessionCookie(c: Context): string | null {
  return getCookie(c, env.SESSION_COOKIE_NAME) ?? null
}

/**
 * Delete the cookie with **exactly** the attributes it was set with.
 *
 * A browser matches the cookie to remove by name + domain + path. Differ in one of them
 * and what you get is a second, empty cookie while the original keeps being sent on the
 * next request — a sign-out that looks successful and is not.
 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, env.SESSION_COOKIE_NAME, baseOptions())
}

import type { Context } from 'hono'

/**
 * The identifying details recorded on a session row and in the audit log.
 *
 * **This is description, not evidence.** `X-Forwarded-For` can be invented by anyone able
 * to reach the API directly, so these values are good enough to answer "which device was
 * this?" on a security page and never good enough for an authorisation decision. Never
 * allow anything on the strength of what is in here.
 */

const MAX_LENGTH = 256

function trim(value: string | undefined): string | null {
  if (!value) return null
  const cleaned = value.trim().slice(0, MAX_LENGTH)
  return cleaned.length > 0 ? cleaned : null
}

export type ClientInfo = {
  userAgent: string | null
  ipAddress: string | null
}

export function clientInfo(c: Context): ClientInfo {
  // The leftmost entry is the original client; the rest is the proxy chain.
  const forwarded = trim(c.req.header('x-forwarded-for'))?.split(',')[0]

  return {
    userAgent: trim(c.req.header('user-agent')),
    ipAddress: trim(forwarded) ?? trim(c.req.header('x-real-ip')),
  }
}

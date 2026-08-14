import type { MiddlewareHandler } from 'hono'
import type { Logger } from 'pino'
import { v7 as uuidv7 } from 'uuid'

import { logger as rootLogger } from '#lib/logger'
import type { LiveSession } from '#platform/session.repo'

/**
 * The values middleware hands to handlers through `c.get(...)`.
 *
 * Anything a *later* middleware fills in is typed as optional, and that is on purpose: a
 * route that forgets its guard then has to deal with `undefined` during `pnpm typecheck`
 * rather than in production. Handlers that would rather not write that check out by hand
 * use the accessor helpers that come with each guard.
 */
export type AppVariables = {
  requestId: string
  logger: Logger
  /** Set by `sessionContext()` when the cookie points at a session that is still alive. */
  session?: LiveSession
}

export type AppBindings = {
  Variables: AppVariables
}

/** An inbound header is only trusted if it looks harmless — logs must not be injectable. */
const SAFE_REQUEST_ID = /^[\w.-]{1,64}$/

/**
 * Gives every request one `requestId` (a UUIDv7 — time-ordered, so it sorts usefully in a
 * log aggregator) and a child logger carrying it. The id goes back out as the
 * `X-Request-Id` header, so a bug report that quotes it maps straight onto its log lines.
 */
export const requestContext = (): MiddlewareHandler<AppBindings> => {
  return async (c, next) => {
    const incoming = c.req.header('x-request-id')
    const requestId = incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : uuidv7()
    const log = rootLogger.child({ requestId })

    c.set('requestId', requestId)
    c.set('logger', log)
    c.header('X-Request-Id', requestId)

    const startedAt = performance.now()
    await next()
    const durationMs = Math.round(performance.now() - startedAt)

    log.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        durationMs,
      },
      'request',
    )
  }
}

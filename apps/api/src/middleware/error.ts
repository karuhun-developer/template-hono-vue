import type { ApiErrorBody, ErrorCode } from '@app/contract'
import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'

import { isProduction } from '#env'
import { ApiError } from '#lib/errors'
import { logger as rootLogger } from '#lib/logger'
import type { AppBindings } from '#middleware/request-context'

function body(code: ErrorCode, message: string, details?: unknown): ApiErrorBody {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } }
}

/**
 * The only place an error turns into a response. Handlers never catch an error just to
 * shape their own JSON — they `throw`, and the response shape is guaranteed to be uniform
 * here. The payoff is on the other side of the wire: a client only ever has to know one
 * error shape.
 */
export const errorHandler: ErrorHandler<AppBindings> = (err, c) => {
  const log = safeLogger(c)

  if (err instanceof ApiError) {
    // An error we threw ourselves is part of the normal flow, not an incident.
    log.warn({ code: err.code, message: err.message }, 'api error')
    return c.json(err.toBody(), err.status)
  }

  if (err instanceof ZodError) {
    log.warn({ issues: err.issues }, 'validation failed')
    return c.json(
      body(
        'validation_failed',
        'The data you sent is not valid.',
        err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      ),
      422,
    )
  }

  if (err instanceof HTTPException) {
    log.warn({ status: err.status, message: err.message }, 'http exception')
    return c.json(body(codeForStatus(err.status), err.message || 'Request failed.'), err.status)
  }

  // Reaching this line means a bug. The technical detail goes to the log, not to the client.
  log.error({ err }, 'unhandled error')
  return c.json(
    body(
      'internal_error',
      'Something went wrong on the server. Try again shortly.',
      isProduction ? undefined : { name: err.name, message: err.message, stack: err.stack },
    ),
    500,
  )
}

export const notFoundHandler: NotFoundHandler<AppBindings> = (c) => {
  return c.json(body('not_found', `No route ${c.req.method} ${c.req.path}.`), 404)
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'bad_request'
    case 401:
      return 'unauthorized'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 422:
      return 'validation_failed'
    case 429:
      return 'rate_limited'
    default:
      return 'internal_error'
  }
}

/** An error can fire before `requestContext()` ran; do not fall over on the way out. */
function safeLogger(c: Context<AppBindings>) {
  try {
    return c.get('logger') ?? rootLogger
  } catch {
    return rootLogger
  }
}

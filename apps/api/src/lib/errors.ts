import { type ApiErrorBody, type ErrorCode } from '@app/contract'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

/**
 * Every error we deliberately hand back to a client goes through this one class, with a
 * stable `code` the frontend can match on. The `message` is a sentence for a human and is
 * free to change at any time; the `code` is the contract.
 *
 * The list of codes and the shape of the body live in `@app/contract`, because the Vue
 * apps read them too. What lives here is the purely server-side part: the mapping to HTTP
 * status codes, and the class that gets thrown.
 */

const STATUS_BY_CODE: Record<ErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  internal_error: 500,
}

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: ContentfulStatusCode
  readonly details: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = STATUS_BY_CODE[code]
    this.details = details
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    }
  }
}

export const badRequest = (message: string, details?: unknown): ApiError =>
  new ApiError('bad_request', message, details)

export const unauthorized = (message = 'You need to sign in first.'): ApiError =>
  new ApiError('unauthorized', message)

export const forbidden = (
  message = 'You do not have access to this action.',
  details?: unknown,
): ApiError => new ApiError('forbidden', message, details)

export const notFound = (message = 'Not found.'): ApiError => new ApiError('not_found', message)

/** For illegal state transitions and for uniqueness that the database rejected. */
export const conflict = (message: string, details?: unknown): ApiError =>
  new ApiError('conflict', message, details)

export const rateLimited = (message = 'Too many requests. Try again shortly.'): ApiError =>
  new ApiError('rate_limited', message)

import { isApiErrorBody, type ErrorCode } from '@app/contract'

/**
 * One error reader for the whole console.
 *
 * Pages must not write `await response.json()` and guess the shape themselves. What
 * arrives when something goes wrong is very often **not** our JSON: an error page from a
 * reverse proxy, an empty body from a 502, or no response at all because the network
 * dropped. All three have to end up as a sentence a person can read, not as
 * `undefined is not an object`.
 */

export type ApiFailure = {
  code: ErrorCode
  message: string
  /** `0` means the request never arrived — a network problem, not a server one. */
  status: number
  details?: unknown
}

const FALLBACK_BY_STATUS: Partial<Record<number, string>> = {
  401: 'Your session has ended. Please sign in again.',
  403: 'You do not have access to this.',
  404: 'That could not be found.',
  429: 'Too many requests. Try again in a moment.',
}

export async function readApiError(response: Response): Promise<ApiFailure> {
  const body: unknown = await response.json().catch(() => null)

  if (isApiErrorBody(body)) {
    return {
      code: body.error.code,
      message: body.error.message,
      status: response.status,
      ...(body.error.details === undefined ? {} : { details: body.error.details }),
    }
  }

  return {
    code: codeForStatus(response.status),
    message:
      FALLBACK_BY_STATUS[response.status] ??
      `The server answered ${response.status}. Try again in a moment.`,
    status: response.status,
  }
}

/**
 * For a `catch` around `fetch`, where the request did not even arrive — so there is no
 * status to report.
 */
export function networkFailure(error: unknown): ApiFailure {
  return {
    code: 'internal_error',
    message: 'Could not reach the server. Check your connection.',
    status: 0,
    details: error instanceof Error ? error.message : error,
  }
}

function codeForStatus(status: number): ErrorCode {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 422) return 'validation_failed'
  if (status === 429) return 'rate_limited'
  return status >= 500 ? 'internal_error' : 'bad_request'
}

/**
 * The error shape the API sends and every frontend reads.
 *
 * What matters here is not `message` — that is a human sentence, free to change at any
 * time — but `code`. Frontends branch on `code`, and a frontend that branches on a
 * substring of the message turns a typo fix into a silent bug in two other places.
 */

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'validation_failed',
  'rate_limited',
  'internal_error',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type ApiErrorBody = {
  error: {
    code: ErrorCode
    message: string
    details?: unknown
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)
}

/**
 * A shape check for a body that arrived over the network.
 *
 * Deliberately not zod: this runs on the error path, which is exactly where the input
 * is least likely to be what you expect — an HTML page from a reverse proxy, an empty
 * response, or `null`.
 */
export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false

  const { error } = value
  if (typeof error !== 'object' || error === null) return false

  const { code, message } = error as { code?: unknown; message?: unknown }
  return isErrorCode(code) && typeof message === 'string'
}

import { describe, expect, it } from 'vitest'

import { networkFailure, readApiError } from '@/lib/api-error'

/**
 * This is the "something has already gone wrong" path — precisely where the input is
 * least likely to be what you expect. Every branch has to end in a readable sentence.
 */

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

describe('readApiError', () => {
  it('uses the message from the API as it is', async () => {
    const failure = await readApiError(
      jsonResponse(403, { error: { code: 'forbidden', message: 'You are not an administrator.' } }),
    )

    expect(failure).toEqual({
      code: 'forbidden',
      message: 'You are not an administrator.',
      status: 403,
    })
  })

  it('carries details through when there are any', async () => {
    const failure = await readApiError(
      jsonResponse(403, {
        error: {
          code: 'forbidden',
          message: 'You cannot grant what you do not hold.',
          details: { permissions: ['audit.read'] },
        },
      }),
    )

    expect(failure.details).toEqual({ permissions: ['audit.read'] })
  })

  it('writes its own sentence when the body is not ours', async () => {
    const failure = await readApiError(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    )

    expect(failure.code).toBe('internal_error')
    expect(failure.message).toContain('502')
  })

  it('has a specific sentence for an expired session', async () => {
    const failure = await readApiError(new Response(null, { status: 401 }))

    expect(failure.code).toBe('unauthorized')
    expect(failure.message).toContain('sign in again')
  })

  it('does not blow up on an empty body', async () => {
    const failure = await readApiError(new Response(null, { status: 500 }))

    expect(failure.code).toBe('internal_error')
    expect(failure.message.length).toBeGreaterThan(0)
  })
})

describe('networkFailure', () => {
  it('reports status 0, because the request never arrived', () => {
    const failure = networkFailure(new TypeError('Failed to fetch'))

    expect(failure.status).toBe(0)
    expect(failure.message).toContain('connection')
    expect(failure.details).toBe('Failed to fetch')
  })
})

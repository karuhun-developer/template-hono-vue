import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { db } from '#db/client'
import { users } from '#db/schema'
import { transaction } from '#db/tx'

import { cleanFixtures, createUser, emailFor } from './support/world'

const TAG = 'tx'

describe('transaction()', () => {
  beforeAll(async () => {
    await cleanFixtures(TAG)
  })

  afterAll(async () => {
    await cleanFixtures(TAG)
  })

  it('runs a deferred task only after the commit is visible', async () => {
    const email = emailFor(TAG, 'committed')
    let visibleToAnotherConnection: boolean | null = null

    await transaction(async (tx, defer) => {
      const [row] = await tx
        .insert(users)
        .values({ email, name: email })
        .returning({ id: users.id })
      if (!row) throw new Error('insert returned nothing')

      defer('read-back', async () => {
        // Deliberately through `db`, not `tx`: a separate connection can only see the row
        // if the transaction has already committed.
        const found = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
        visibleToAnotherConnection = found.length === 1
      })

      expect(visibleToAnotherConnection).toBeNull()
    })

    expect(visibleToAnotherConnection).toBe(true)
  })

  it('runs nothing when the transaction rolls back', async () => {
    const email = emailFor(TAG, 'rolled-back')
    const task = vi.fn()

    await expect(
      transaction(async (tx, defer) => {
        await tx.insert(users).values({ email, name: email })
        defer('never', task)
        throw new Error('changed my mind')
      }),
    ).rejects.toThrow('changed my mind')

    expect(task).not.toHaveBeenCalled()

    const rows = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
    expect(rows).toHaveLength(0)
  })

  it('does not fail the caller when a deferred task throws', async () => {
    const after = vi.fn()

    const result = await transaction((_tx, defer) => {
      defer('broken', () => {
        throw new Error('the mail server is down')
      })
      defer('after', after)
      return 'ok'
    })

    // The write committed. A failure in something that happens afterwards must not be
    // reported to the caller as a failure of the write.
    expect(result).toBe('ok')
    expect(after).toHaveBeenCalledOnce()
  })

  it('runs deferred tasks in the order they were registered', async () => {
    const order: string[] = []

    await transaction((_tx, defer) => {
      defer('first', () => void order.push('first'))
      defer('second', () => void order.push('second'))
    })

    expect(order).toEqual(['first', 'second'])
  })

  it('refuses a defer registered after the transaction has finished', async () => {
    let escaped: ((name: string, task: () => void) => void) | undefined

    await transaction((_tx, defer) => {
      escaped = defer
    })

    expect(() => escaped?.('too-late', () => {})).toThrow(/already finished/)
  })

  it('gives the callback a handle that sees its own uncommitted writes', async () => {
    const email = emailFor(TAG, 'own-write')

    await transaction(async (tx) => {
      await tx.insert(users).values({ email, name: email })
      const rows = await tx.select({ id: users.id }).from(users).where(eq(users.email, email))
      expect(rows).toHaveLength(1)
    })

    await createUser(emailFor(TAG, 'unrelated'))
  })
})

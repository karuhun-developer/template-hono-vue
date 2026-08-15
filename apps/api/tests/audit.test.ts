import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase, db } from '#db/client'
import { auditLogs } from '#db/schema'
import { diffFields, recordAudit, redact } from '#modules/audit/audit.repo'

import {
  cleanFixtures,
  countAuditRows,
  createRole,
  createUser,
  emailFor,
  ensureCatalog,
  login,
  request,
} from './support/world'

/**
 * The trail: what gets written, what never gets written, and who may read it.
 *
 * `diffFields` and `redact` are tested directly because they are the two functions standing
 * between "an audit log" and "a second copy of the users table, password hashes included".
 */

const TAG = 'audit'
const READER = emailFor(TAG, 'reader')
const WRITER = emailFor(TAG, 'writer')

let readerCookie: string
let writerCookie: string
let plainRoleId: string

beforeAll(async () => {
  await cleanFixtures(TAG)
  await ensureCatalog()

  const readerRoleId = await createRole(TAG, 'reader', ['user.read', 'user.invite', 'audit.read'])
  const writerRoleId = await createRole(TAG, 'writer', ['user.read', 'user.invite'])
  plainRoleId = await createRole(TAG, 'plain', ['user.read'])

  await createUser(READER, { name: 'Reader', roleIds: [readerRoleId] })
  await createUser(WRITER, { name: 'Writer', roleIds: [writerRoleId] })

  readerCookie = await login(app, READER)
  writerCookie = await login(app, WRITER)
})

afterAll(async () => {
  await cleanFixtures(TAG)
  await closeDatabase()
})

describe('diffFields', () => {
  it('keeps only the columns that actually changed', () => {
    const diff = diffFields({ name: 'Old', email: 'same@example.test' }, { name: 'New' })

    expect(diff).toEqual({ before: { name: 'Old' }, after: { name: 'New' } })
  })

  it('is null when the payload changed nothing', () => {
    // A PATCH that re-sends the same values is not an event worth a row.
    expect(diffFields({ name: 'Same' }, { name: 'Same' })).toBeNull()
  })

  it('ignores keys the row does not have', () => {
    // Otherwise a request body could invent a change to a column that does not exist.
    expect(
      diffFields<Record<string, unknown>>({ name: 'Old' }, { nickname: 'Injected' }),
    ).toBeNull()
  })

  it('compares dates by their instant, not by identity', () => {
    const before = { at: new Date('2026-01-01T00:00:00.000Z') }
    const after = { at: new Date('2026-01-01T00:00:00.000Z') }

    expect(diffFields(before, after)).toBeNull()
  })
})

describe('redact', () => {
  it('replaces the value and keeps the key', () => {
    const out = redact({ email: 'someone@example.test', passwordHash: '$argon2id$v=19$...' })

    // "The password was changed" is the very thing an investigation wants to see; dropping
    // the key would make that change invisible.
    expect(out).toEqual({ email: 'someone@example.test', passwordHash: '[redacted]' })
  })

  it('leaves null alone, so "never set" stays different from "set, hidden"', () => {
    expect(redact({ inviteTokenHash: null })).toEqual({ inviteTokenHash: null })
  })

  it('reaches into nested objects', () => {
    expect(redact({ user: { name: 'Someone', token: 'sess_abc' } })).toEqual({
      user: { name: 'Someone', token: '[redacted]' },
    })
  })
})

describe('recordAudit', () => {
  /**
   * The property the signature exists for: `recordAudit` takes the caller's handle, so the
   * entry lives or dies with the change it describes. A trail entry for a change that never
   * committed is worse than no entry at all.
   */
  it('joins the caller’s transaction and rolls back with it', async () => {
    const action = `${TAG}.rolled-back`

    await expect(
      db.transaction(async (tx) => {
        await recordAudit(tx, { type: 'user', label: READER }, { action, subjectType: 'users' })
        throw new Error('the change failed after the trail was written')
      }),
    ).rejects.toThrow('the change failed after the trail was written')

    expect(await countAuditRows(TAG, action)).toBe(0)
  })

  it('records a system actor with no user behind it', async () => {
    const action = `${TAG}.scheduled`
    await recordAudit(db, { type: 'system', label: READER }, { action, subjectType: 'users' })

    const [row] = await db
      .select({ actorType: auditLogs.actorType, actorId: auditLogs.actorId })
      .from(auditLogs)
      .where(eq(auditLogs.action, action))

    // `actor_id` carries no foreign key, so a trail outlives the account that wrote it.
    expect(row).toMatchObject({ actorType: 'system', actorId: null })
  })
})

describe('the trail an endpoint leaves', () => {
  it('records who invited whom, without the invitation token', async () => {
    const email = emailFor(TAG, 'joiner')
    const res = await request(app, '/users', {
      method: 'POST',
      cookie: writerCookie,
      body: { email, name: 'New Joiner', roleIds: [plainRoleId] },
    })
    expect(res.status).toBe(201)
    const { inviteToken } = (await res.json()) as { inviteToken: string }

    const [row] = await db
      .select({
        actorLabel: auditLogs.actorLabel,
        subjectType: auditLogs.subjectType,
        subjectLabel: auditLogs.subjectLabel,
        after: auditLogs.after,
        requestId: auditLogs.requestId,
      })
      .from(auditLogs)
      .where(eq(auditLogs.subjectLabel, email))
      .orderBy(desc(auditLogs.id))
      .limit(1)

    expect(row).toMatchObject({
      actorLabel: WRITER,
      subjectType: 'users',
      subjectLabel: email,
      after: { email, name: 'New Joiner', roles: [`${TAG}-plain`] },
    })
    expect(row?.requestId).toBeTruthy()
    expect(JSON.stringify(row?.after)).not.toContain(inviteToken)
  })
})

describe('GET /audit-logs', () => {
  it('is refused without audit.read', async () => {
    expect((await request(app, '/audit-logs', { cookie: writerCookie })).status).toBe(403)
  })

  it('returns the newest entries first', async () => {
    const res = await request(app, `/audit-logs?action=user.invite`, { cookie: readerCookie })
    const body = (await res.json()) as { items: { id: string; action: string }[] }

    expect(res.status).toBe(200)
    expect(body.items.every((item) => item.action === 'user.invite')).toBe(true)
    expect([...body.items.map((item) => item.id)].sort().reverse()).toEqual(
      body.items.map((item) => item.id),
    )
  })

  /** The console's Action filter is a checkbox list, so it sends `action` once per tick. */
  it('takes a repeated action as a set', async () => {
    const one = `${TAG}.alpha`
    const two = `${TAG}.beta`

    for (const action of [one, two]) {
      await recordAudit(db, { type: 'user', label: READER }, { action, subjectType: 'users' })
    }

    const res = await request(app, `/audit-logs?action=${one}&action=${two}`, {
      cookie: readerCookie,
    })
    const body = (await res.json()) as { items: { action: string }[] }

    expect([...body.items.map((item) => item.action)].sort()).toEqual([one, two].sort())
  })

  it('pages by keyset, and stops offering a cursor at the end', async () => {
    const action = `${TAG}.page`
    for (let index = 0; index < 3; index += 1) {
      await recordAudit(
        db,
        { type: 'user', label: READER },
        { action, subjectType: 'users', reason: `entry ${index}` },
      )
    }

    const first = await request(app, `/audit-logs?action=${action}&limit=2`, {
      cookie: readerCookie,
    })
    const page1 = (await first.json()) as {
      items: { id: string }[]
      nextCursor: string | null
    }

    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).toBe(page1.items[1]?.id)

    const second = await request(
      app,
      `/audit-logs?action=${action}&limit=2&cursor=${page1.nextCursor}`,
      { cookie: readerCookie },
    )
    const page2 = (await second.json()) as { items: { id: string }[]; nextCursor: string | null }

    expect(page2.items).toHaveLength(1)
    // The last page says so by offering nothing to page on to.
    expect(page2.nextCursor).toBeNull()
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id)
  })

  it('rejects a limit beyond the ceiling', async () => {
    // What stops a crafted `?limit=100000` from turning one request into a full table read.
    const res = await request(app, '/audit-logs?limit=100000', { cookie: readerCookie })

    expect(res.status).toBe(400)
  })
})

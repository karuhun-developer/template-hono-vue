import { eq, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase, db } from '#db/client'
import { mailMessages } from '#db/schema'
import { queueMail } from '#mail/outbox'

import {
  cleanFixtures,
  createRole,
  createUser,
  emailFor,
  ensureCatalog,
  login,
  request,
} from './support/world'

/**
 * The Mail log endpoints.
 *
 * Most of this file is the usual list-endpoint work — filters, a pager, a sort whitelist,
 * a 403. One test is not: **the response for a message whose payload held a live token
 * contains neither the token nor a `payload` key.** That is the assertion the whole
 * three-mechanism design in `db/schema/mail.ts` exists to make true, and it is asserted
 * here, at the HTTP boundary, because that is where a regression would actually be reached
 * from.
 */

const TAG = 'maillog'
const READER = emailFor(TAG, 'reader')
const OUTSIDER = emailFor(TAG, 'outsider')
const RECIPIENT = emailFor(TAG, 'ada')

/** Long enough that `maskSecrets` does not skip it as too short to be worth masking. */
const TOKEN = 'inv_a-token-that-must-never-leave-the-database'

let readerCookie: string
let outsiderCookie: string

/**
 * Write the outbox row and collect the send instead of performing it, so the message stays
 * `queued` — the state in which `payload` is still populated, and therefore the only state
 * in which the leak this file is about is even possible.
 */
async function queueMessage(
  template: 'invitation' | 'password-reset' = 'invitation',
  to = RECIPIENT,
): Promise<string> {
  return db.transaction(async (tx) =>
    queueMail(
      tx,
      () => {
        /* collected and never run */
      },
      {
        to: { email: to, name: 'Ada' },
        template,
        payload: {
          name: 'Ada',
          token: TOKEN,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      },
    ),
  )
}

function cleanMail(): Promise<unknown> {
  return db.delete(mailMessages).where(like(mailMessages.toEmail, `%@${TAG}.test`))
}

beforeAll(async () => {
  await cleanFixtures(TAG)
  await ensureCatalog()

  const readerRoleId = await createRole(TAG, 'reader', ['mail.read'])
  const outsiderRoleId = await createRole(TAG, 'outsider', ['user.read'])

  await createUser(READER, { name: 'Reader', roleIds: [readerRoleId] })
  await createUser(OUTSIDER, { name: 'Outsider', roleIds: [outsiderRoleId] })

  readerCookie = await login(app, READER)
  outsiderCookie = await login(app, OUTSIDER)
})

afterEach(cleanMail)

afterAll(async () => {
  await cleanMail()
  await cleanFixtures(TAG)
  await closeDatabase()
})

type ListBody = {
  items: Record<string, unknown>[]
  total: number
  page: number
  perPage: number
}

describe('GET /mail-messages', () => {
  it('answers with the list envelope, and counts the whole match rather than the page', async () => {
    await queueMessage('invitation')
    await queueMessage('password-reset')

    const res = await request(app, `/mail-messages?q=${encodeURIComponent(RECIPIENT)}&perPage=1`, {
      cookie: readerCookie,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as ListBody
    expect(body.items).toHaveLength(1)
    // Over the filter, not over the page — the pager depends on it.
    expect(body).toMatchObject({ total: 2, page: 1, perPage: 1 })
  })

  it('gives back neither the payload nor the token in it', async () => {
    await queueMessage()

    const res = await request(app, `/mail-messages?q=${encodeURIComponent(RECIPIENT)}`, {
      cookie: readerCookie,
    })
    const raw = await res.text()

    // Against the raw response text, not a parsed field: the point is that the token is
    // nowhere in what left the process, whatever shape it might have been wrapped in.
    expect(raw).not.toContain(TOKEN)
    // And the column itself is absent rather than null — `mailColumns` never selected it.
    expect(Object.keys(((JSON.parse(raw) as ListBody).items[0] ?? {}) as object)).not.toContain(
      'payload',
    )
  })

  it('shows the masked body, so the page has something honest to render', async () => {
    await queueMessage()

    const res = await request(app, `/mail-messages?q=${encodeURIComponent(RECIPIENT)}`, {
      cookie: readerCookie,
    })
    const body = (await res.json()) as ListBody

    // The stored copy is a real body with the secret replaced. That is what makes a mail
    // log useful and safe at the same time — an empty body would be neither.
    expect(body.items[0]?.textBody).toContain('[redacted]')
    expect(body.items[0]?.subject).toEqual(expect.any(String))
  })

  it('filters by status and by template', async () => {
    await queueMessage('invitation')
    await queueMessage('password-reset')

    const byTemplate = await request(app, '/mail-messages?template=invitation', {
      cookie: readerCookie,
    })
    const byStatus = await request(app, '/mail-messages?status=sent', { cookie: readerCookie })

    expect(((await byTemplate.json()) as ListBody).items).toHaveLength(1)
    // Nothing was actually sent — the deferred task was collected, not run.
    expect(((await byStatus.json()) as ListBody).total).toBe(0)
  })

  it('rejects a status that is not a status, rather than ignoring it', async () => {
    const res = await request(app, '/mail-messages?status=nonsense', { cookie: readerCookie })

    expect(res.status).toBe(400)
  })

  it('rejects a sort key that is not in the whitelist', async () => {
    // The whitelist is the only thing between `sort` and an ORDER BY.
    const res = await request(app, '/mail-messages?sort=textBody', { cookie: readerCookie })

    expect(res.status).toBe(400)
  })

  it('is 403 without mail.read', async () => {
    const res = await request(app, '/mail-messages', { cookie: outsiderCookie })

    expect(res.status).toBe(403)
  })
})

describe('GET /mail-messages/:id', () => {
  it('answers with the one message, still without its payload', async () => {
    const id = await queueMessage()

    const res = await request(app, `/mail-messages/${id}`, { cookie: readerCookie })

    expect(res.status).toBe(200)
    const raw = await res.text()
    expect(raw).not.toContain(TOKEN)

    const body = JSON.parse(raw) as { message: Record<string, unknown> }
    expect(body.message.id).toBe(id)
    expect(body.message.toEmail).toBe(RECIPIENT)
    expect(Object.keys(body.message)).not.toContain('payload')
    // The row still has one — this is the projection doing the work, not the nulling.
    const [row] = await db.select().from(mailMessages).where(eq(mailMessages.id, id))
    expect(row?.payload).not.toBeNull()
  })

  it('rejects an id that is not an id before touching the database', async () => {
    const res = await request(app, '/mail-messages/not-a-uuid', { cookie: readerCookie })

    expect(res.status).toBe(400)
  })

  it('is 404 for a message that does not exist', async () => {
    const res = await request(app, '/mail-messages/00000000-0000-4000-8000-000000000000', {
      cookie: readerCookie,
    })

    expect(res.status).toBe(404)
  })

  it('is 403 without mail.read', async () => {
    const id = await queueMessage()

    const res = await request(app, `/mail-messages/${id}`, { cookie: outsiderCookie })

    expect(res.status).toBe(403)
  })
})

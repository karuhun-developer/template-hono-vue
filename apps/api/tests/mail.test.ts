import { randomUUID } from 'node:crypto'

import { and, eq, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { closeDatabase, db } from '#db/client'
import { transaction } from '#db/tx'
import { mailMessages } from '#db/schema'
import { logger } from '#lib/logger'
import { createSmtpMailer, smtpTransportOptions } from '#mail/driver/smtp'
import { pruneMailMessages } from '#mail/mail.repo'
import type { MailDriver, OutgoingMail, SendResult } from '#mail/mailer'
import { queueMail } from '#mail/outbox'
import { maskSecrets, renderTemplate } from '#mail/templates'
import { sendMailJob, sweepStuckMailJob } from '#queue/jobs/mail'
import type { JobContext } from '#queue/registry'

import { cleanFixtures, emailFor, lastMailTo } from './support/world'

/**
 * The mail subsystem, and mostly one property: **a stored message is not a way in**.
 *
 * The invitation body contains a live `inv_…` link, and the Mail log page shows stored
 * bodies to anyone holding `mail.read`. Three mechanisms keep those two facts compatible —
 * masking on the way in, `payload` absent from every read projection, and `payload` nulled
 * at a terminal state — and each of them is asserted below. Any one of them silently
 * regressing turns the mail log into an account-takeover feature, which is not a thing a
 * reviewer would spot from a diff.
 */

const TAG = 'mailsub'
const RECIPIENT = emailFor(TAG, 'ada')

/** Recognisable, and long enough that `maskSecrets` does not skip it as too short to mask. */
const TOKEN = 'inv_a-test-token-that-must-never-be-stored'

function context(overrides: Partial<JobContext> = {}): JobContext {
  return {
    name: 'mail.send',
    jobId: randomUUID(),
    attempt: 1,
    maxAttempts: 3,
    logger,
    signal: new AbortController().signal,
    ...overrides,
  }
}

/** A driver that keeps what it was handed. The seam exists because `env` is frozen at boot. */
function capturingMailer(): MailDriver & { sent: OutgoingMail[] } {
  const sent: OutgoingMail[] = []

  return {
    kind: 'log',
    sent,
    send(message: OutgoingMail): Promise<SendResult> {
      sent.push(message)
      return Promise.resolve({ providerMessageId: 'captured' })
    },
  }
}

function failingMailer(message: string): MailDriver {
  return {
    kind: 'log',
    send: () => Promise.reject(new Error(message)),
  }
}

/**
 * Write the outbox row without letting the send happen yet.
 *
 * `defer` is the caller's post-commit hook, and collecting the tasks instead of running
 * them is what leaves the message `queued` — which is the state every assertion about the
 * *stored* copy needs to be made in.
 */
async function queueWithoutSending(token = TOKEN): Promise<string> {
  return db.transaction(async (tx) =>
    queueMail(
      tx,
      () => {
        /* collected and never run */
      },
      {
        to: { email: RECIPIENT, name: 'Ada' },
        template: 'invitation',
        payload: {
          name: 'Ada',
          token,
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
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
})

afterEach(cleanMail)

afterAll(async () => {
  await cleanFixtures(TAG)
  await closeDatabase()
})

describe('rendering', () => {
  it('builds an absolute link from CONSOLE_URL, because a worker has no window', () => {
    const { rendered } = renderTemplate('invitation', {
      name: 'Ada',
      token: TOKEN,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })

    expect(rendered.text).toContain(`http://localhost:7301/invitation/${TOKEN}`)
    expect(rendered.html).toContain(`http://localhost:7301/invitation/${TOKEN}`)
    expect(rendered.secrets).toEqual([TOKEN])
  })

  it('masks a secret inside the URL it was interpolated into', () => {
    const { rendered } = renderTemplate('password-reset', {
      name: 'Ada',
      token: 'rst_another-token-nobody-should-read',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })

    const masked = maskSecrets(rendered.text, rendered.secrets)

    // The occurrence a naive implementation misses: the link, not the bare token.
    expect(masked).toContain('http://localhost:7301/reset-password/[redacted]')
    expect(masked).not.toContain('rst_another')
  })

  it('escapes a name into the HTML part', () => {
    const { rendered } = renderTemplate('invitation', {
      name: '<script>alert(1)</script>',
      token: TOKEN,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    })

    // A person's name reaches an inbox, and half of those render HTML.
    expect(rendered.html).not.toContain('<script>')
    expect(rendered.html).toContain('&lt;script&gt;')
  })

  it('refuses a template that is not in the catalog', () => {
    expect(() => renderTemplate('invitaton', {})).toThrow(/unknown mail template/)
  })

  it('refuses a payload the template could not render', () => {
    // Caught here rather than three retries later in a worker log.
    expect(() => renderTemplate('invitation', { name: 'Ada', token: TOKEN })).toThrow(/invalid/)
  })
})

/**
 * The option mapping, and nothing else.
 *
 * Nothing here pretends to reach a mail server: what would be under test is nodemailer. What
 * is ours is the two guesses the driver makes on a caller's behalf, and both of them fail in
 * ways that read as somebody else's fault — a hang, or a rejected password on a server that
 * never asked for one.
 */
describe('the smtp driver', () => {
  it('infers implicit TLS from port 465 and STARTTLS from anything else', () => {
    expect(smtpTransportOptions({ host: 'mail.example.com', port: 465 }).secure).toBe(true)
    // 587 is plaintext first and upgraded, which nodemailer does on its own. Opening it
    // encrypted would hang rather than fail.
    expect(smtpTransportOptions({ host: 'mail.example.com', port: 587 }).secure).toBe(false)
  })

  it('lets SMTP_SECURE override the guess', () => {
    const options = smtpTransportOptions({ host: 'mail.example.com', port: 2525, secure: true })

    expect(options.secure).toBe(true)
  })

  it('omits auth entirely when no user is configured', () => {
    const options = smtpTransportOptions({ host: 'relay.internal', port: 25 })

    // Not `{ user: undefined }`: a relay that authenticates by IP is offered nothing, rather
    // than an empty pair it would refuse.
    expect('auth' in options).toBe(false)
    expect(options.pool).toBe(true)
  })

  it('passes credentials through when there are any', () => {
    const options = smtpTransportOptions({
      host: 'mail.example.com',
      port: 587,
      user: 'apikey',
      password: 'not-a-real-secret',
      maxConnections: 3,
    })

    expect(options.auth).toEqual({ user: 'apikey', pass: 'not-a-real-secret' })
    expect(options.maxConnections).toBe(3)
  })

  it('names the missing setting rather than failing at the first send', () => {
    // `env.ts` makes this unreachable through `mailer.ts`. It stays reachable — and legible —
    // for anyone constructing the factory directly.
    expect(() => createSmtpMailer()).toThrow(/SMTP_HOST is required/)
  })

  it('opens nothing when it is constructed', () => {
    // The contract `mailer.ts` states: a mail server having a bad afternoon is a retried job,
    // not an API that refuses to start. The pool is opened by the first send.
    expect(createSmtpMailer({ host: 'mail.example.com' }).kind).toBe('smtp')
  })
})

describe('the outbox', () => {
  it('stores the body with the token masked', async () => {
    await queueWithoutSending()

    const row = await lastMailTo(RECIPIENT)

    expect(row?.status).toBe('queued')
    expect(row?.textBody).not.toContain(TOKEN)
    expect(row?.htmlBody).not.toContain(TOKEN)
    expect(row?.textBody).toContain('http://localhost:7301/invitation/[redacted]')
    // And the payload — the one copy that is not masked — is still there, because the send
    // has not happened yet and is what re-renders from it.
    expect(row?.payload).toMatchObject({ token: TOKEN })
  })

  it('leaves nothing behind when the transaction rolls back', async () => {
    await expect(
      transaction(async (tx, defer) => {
        await queueMail(tx, defer, {
          to: { email: RECIPIENT, name: 'Ada' },
          template: 'invitation',
          payload: { name: 'Ada', token: TOKEN, expiresAt: new Date().toISOString() },
        })
        // Whatever the caller was doing failed after deciding to send.
        throw new Error('the change did not commit')
      }),
    ).rejects.toThrow('the change did not commit')

    // The property the outbox exists to buy: no email about an account that does not exist.
    expect(await lastMailTo(RECIPIENT)).toBeNull()
  })

  it('sends through the queue when the transaction commits', async () => {
    // The suite runs on QUEUE_DRIVER=sync, so `defer` dispatches the send inline the moment
    // the commit lands. End to end, with nothing injected.
    await transaction(async (tx, defer) => {
      await queueMail(tx, defer, {
        to: { email: RECIPIENT, name: 'Ada' },
        template: 'invitation',
        payload: {
          name: 'Ada',
          token: TOKEN,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
      })
    })

    const row = await lastMailTo(RECIPIENT)

    expect(row?.status).toBe('sent')
    expect(row?.driver).toBe('log')
    expect(row?.sentAt).not.toBeNull()
  })
})

describe('sending', () => {
  it('sends the unmasked body while the stored copy stays masked', async () => {
    const messageId = await queueWithoutSending()
    const driver = capturingMailer()

    await sendMailJob({ messageId }, context(), driver)

    // What left the process is the real link — otherwise the invitation would be useless.
    expect(driver.sent[0]?.text).toContain(`http://localhost:7301/invitation/${TOKEN}`)
    // What stayed behind is not.
    const row = await lastMailTo(RECIPIENT)
    expect(row?.textBody).not.toContain(TOKEN)
  })

  it('clears the payload once the message has been sent', async () => {
    const messageId = await queueWithoutSending()

    await sendMailJob({ messageId }, context(), capturingMailer())

    const row = await lastMailTo(RECIPIENT)

    expect(row?.status).toBe('sent')
    // The third mechanism. A database dump taken next year must not be able to accept last
    // year's invitations.
    expect(row?.payload).toBeNull()
    expect(row?.attempts).toBe(1)
    expect(row?.providerMessageId).toBe('captured')
  })

  it('does not send a message twice', async () => {
    const messageId = await queueWithoutSending()
    const driver = capturingMailer()

    await sendMailJob({ messageId }, context(), driver)
    await sendMailJob({ messageId }, context({ attempt: 2 }), driver)

    // A retry after a half-finished attempt is normal, so the row is re-read rather than
    // trusted from the payload.
    expect(driver.sent).toHaveLength(1)
  })

  it('keeps the payload while attempts remain, and rethrows so the queue retries', async () => {
    const messageId = await queueWithoutSending()

    await expect(
      sendMailJob(
        { messageId },
        context({ attempt: 1, maxAttempts: 3 }),
        failingMailer('smtp down'),
      ),
    ).rejects.toThrow('smtp down')

    const row = await lastMailTo(RECIPIENT)

    expect(row?.status).toBe('queued')
    expect(row?.error).toContain('smtp down')
    // Still renderable: the retry has to have something to render from.
    expect(row?.payload).toMatchObject({ token: TOKEN })
  })

  it('gives up the payload on the last attempt', async () => {
    const messageId = await queueWithoutSending()

    await expect(
      sendMailJob({ messageId }, context({ attempt: 3, maxAttempts: 3 }), failingMailer('nope')),
    ).rejects.toThrow('nope')

    const row = await lastMailTo(RECIPIENT)

    expect(row?.status).toBe('failed')
    // A token must not outlive its send, whether or not the send worked.
    expect(row?.payload).toBeNull()
  })

  it('says so and stops when the message has gone', async () => {
    // Retention swept it, or somebody deleted it. Failing would put a permanent error on
    // the Jobs page for work that no longer exists.
    await expect(sendMailJob({ messageId: randomUUID() }, context())).resolves.toBeUndefined()
  })
})

describe('the sweep and the prune', () => {
  it('re-enqueues a message whose dispatch was lost', async () => {
    const messageId = await queueWithoutSending()

    // Older than the five-minute window: under the redis driver this is what a crash
    // between the commit and the dispatch leaves behind.
    await db
      .update(mailMessages)
      .set({ createdAt: new Date(Date.now() - 10 * 60_000) })
      .where(eq(mailMessages.id, messageId))

    // The sync driver runs the send inline, so the sweep's effect is the send itself.
    await sweepStuckMailJob({}, context({ name: 'mail.sweep-stuck' }))

    expect((await lastMailTo(RECIPIENT))?.status).toBe('sent')
  })

  it('leaves a message that is merely young alone', async () => {
    await queueWithoutSending()

    await sweepStuckMailJob({}, context({ name: 'mail.sweep-stuck' }))

    // A queue with a backlog is not a queue with a problem.
    expect((await lastMailTo(RECIPIENT))?.status).toBe('queued')
  })

  it('deletes finished messages past the window and keeps the rest', async () => {
    const old = new Date(Date.now() - 40 * 86_400_000)

    const sentOld = await queueWithoutSending()
    const queuedOld = await queueWithoutSending()
    const sentNew = await queueWithoutSending()

    await db
      .update(mailMessages)
      .set({ status: 'sent', createdAt: old })
      .where(eq(mailMessages.id, sentOld))
    await db.update(mailMessages).set({ createdAt: old }).where(eq(mailMessages.id, queuedOld))
    await db.update(mailMessages).set({ status: 'sent' }).where(eq(mailMessages.id, sentNew))

    const removed = await pruneMailMessages(db, { olderThanMs: 30 * 86_400_000 })

    expect(removed).toBe(1)
    const survivors = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(and(like(mailMessages.toEmail, `%@${TAG}.test`)))

    // The old `queued` row survives on purpose: it has not been sent, and deleting it would
    // throw away a message rather than a record of one.
    expect(survivors.map((row) => row.id).sort()).toEqual([queuedOld, sentNew].sort())
  })
})

import { and, asc, count, desc, eq, ilike, inArray, lt, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import type { Database, DatabaseHandle } from '#db/client'
import { mailMessages, type MailMessage, type MailStatus } from '#db/schema'
import { escapeLike } from '#lib/query'

/**
 * Every read and write of `mail_messages`.
 *
 * The one thing to keep straight while reading this file: **`payload` is the dangerous
 * column**. It holds the template data, which for an invitation contains a live token. It
 * is selected in exactly one place — `findMailForSend`, which the send job calls — and it
 * is nulled at every terminal state. Nothing that answers an HTTP request may select it,
 * which is what `mailColumns` is for.
 */

/**
 * What a read path is allowed to see.
 *
 * The same device as `userColumns` omitting `passwordHash`: a projection is a rule you
 * cannot forget to apply, whereas "remember to delete the field before responding" is a
 * rule that survives exactly until somebody adds an endpoint in a hurry.
 */
export const mailColumns = {
  id: mailMessages.id,
  toEmail: mailMessages.toEmail,
  toName: mailMessages.toName,
  fromEmail: mailMessages.fromEmail,
  subject: mailMessages.subject,
  template: mailMessages.template,
  // The **masked** copies. Safe by the time they were written, not by the time they are read.
  textBody: mailMessages.textBody,
  htmlBody: mailMessages.htmlBody,
  status: mailMessages.status,
  driver: mailMessages.driver,
  attempts: mailMessages.attempts,
  error: mailMessages.error,
  providerMessageId: mailMessages.providerMessageId,
  sentAt: mailMessages.sentAt,
  createdAt: mailMessages.createdAt,
  updatedAt: mailMessages.updatedAt,
} as const

/**
 * A message as the read API is allowed to describe it.
 *
 * Derived by subtraction from the row type rather than written out, so a column added to
 * the table joins this automatically and a column added to the *dangerous* list has to be
 * named here — which is the direction that fails loudly.
 */
export type MailRecord = Omit<MailMessage, 'payload'>

export type ListMailFilter = {
  status?: readonly MailStatus[] | undefined
  template?: readonly string[] | undefined
  /** Matched against the recipient and the subject — the two things support asks by. */
  q?: string | undefined
  page: number
  perPage: number
  sort: 'createdAt' | 'sentAt' | 'status'
  order: 'asc' | 'desc'
}

export type ListMailPage = { rows: MailRecord[]; total: number }

const SORTABLE = {
  createdAt: mailMessages.createdAt,
  sentAt: mailMessages.sentAt,
  status: mailMessages.status,
} as const satisfies Record<ListMailFilter['sort'], PgColumn>

export async function listMailMessages(
  database: Database,
  filter: ListMailFilter,
): Promise<ListMailPage> {
  const where: SQL[] = []
  if (filter.status?.length) where.push(inArray(mailMessages.status, [...filter.status]))
  if (filter.template?.length) where.push(inArray(mailMessages.template, [...filter.template]))

  if (filter.q) {
    const needle = `%${escapeLike(filter.q)}%`
    // Not the body. It is the largest column here and searching it would be a sequential
    // scan dressed up as a feature — and on a masked copy, so the interesting parts of it
    // read `[redacted]` anyway.
    where.push(or(ilike(mailMessages.toEmail, needle), ilike(mailMessages.subject, needle)) as SQL)
  }

  const condition = where.length > 0 ? and(...where) : undefined
  const direction = filter.order === 'desc' ? desc : asc

  const [rows, [counted]] = await Promise.all([
    database
      .select(mailColumns)
      .from(mailMessages)
      .where(condition)
      // `id` breaks ties, for the reason the user list gives: two pages of an unstable sort
      // can show one row twice and skip another entirely.
      .orderBy(direction(SORTABLE[filter.sort]), asc(mailMessages.id))
      .limit(filter.perPage)
      .offset((filter.page - 1) * filter.perPage),

    // The same `where`, deliberately. A count over a different condition is a pager that
    // promises pages which are not there.
    database.select({ value: count() }).from(mailMessages).where(condition),
  ])

  return { rows, total: counted?.value ?? 0 }
}

/** The detail view. Through `mailColumns` as well — there is no read path that is not. */
export async function findMailMessage(database: Database, id: string): Promise<MailRecord | null> {
  const [row] = await database
    .select(mailColumns)
    .from(mailMessages)
    .where(eq(mailMessages.id, id))
    .limit(1)

  return row ?? null
}

export type NewMailRow = {
  toEmail: string
  toName: string | null
  fromEmail: string
  subject: string
  template: string
  payload: Record<string, unknown>
  /** Already masked. The unmasked render never reaches this function. */
  textBody: string
  htmlBody: string
  driver: string
}

/**
 * Write the outbox row.
 *
 * Takes a `DatabaseHandle` because it is nearly always called with the caller's `tx`: the
 * row and the change that caused it commit together, or neither does.
 */
export async function insertMailMessage(handle: DatabaseHandle, row: NewMailRow): Promise<string> {
  const [inserted] = await handle
    .insert(mailMessages)
    .values(row)
    .returning({ id: mailMessages.id })

  if (!inserted) throw new Error('the mail message could not be written')
  return inserted.id
}

/**
 * The whole row, `payload` included — the only place that reads it.
 *
 * Re-read rather than carried in the job payload, so a retry sees the current state and a
 * message somebody already sent is not sent twice.
 */
export async function findMailForSend(database: Database, id: string): Promise<MailMessage | null> {
  const [row] = await database.select().from(mailMessages).where(eq(mailMessages.id, id)).limit(1)
  return row ?? null
}

/**
 * Terminal success: the payload goes with it.
 *
 * That last part is the third of the three mechanisms in the schema comment. A token that
 * has been delivered has no reason to stay in a column, and a database dump taken next year
 * should not be able to accept last year's invitations.
 */
export async function markMailSent(
  database: Database,
  id: string,
  result: { providerMessageId: string | null; driver: string },
): Promise<void> {
  await database
    .update(mailMessages)
    .set({
      status: 'sent',
      payload: null,
      driver: result.driver,
      providerMessageId: result.providerMessageId,
      attempts: sql`${mailMessages.attempts} + 1`,
      error: null,
      sentAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, id))
}

/**
 * A failed attempt. `terminal` decides whether the message stays `queued` for the retry the
 * queue is already going to perform, or gives up — and gives up the payload with it.
 */
export async function markMailFailed(
  database: Database,
  id: string,
  options: { error: string; terminal: boolean },
): Promise<void> {
  await database
    .update(mailMessages)
    .set({
      status: options.terminal ? 'failed' : 'queued',
      // Only on the way out. A message still due a retry needs its payload to render from.
      ...(options.terminal ? { payload: null } : {}),
      attempts: sql`${mailMessages.attempts} + 1`,
      error: options.error,
      updatedAt: new Date(),
    })
    .where(eq(mailMessages.id, id))
}

/**
 * Messages that were written but never dispatched.
 *
 * This is what closes the gap the redis queue driver leaves: that driver cannot join the
 * Postgres transaction, so a crash between the commit and the dispatch loses the job — but
 * not the row, which was written inside the transaction. Anything still `queued` well after
 * it was created is either that, or a worker that died mid-send.
 */
export async function findStuckMail(
  database: Database,
  options: { olderThanMs: number; limit: number },
): Promise<{ id: string }[]> {
  const cutoff = new Date(Date.now() - options.olderThanMs)

  return database
    .select({ id: mailMessages.id })
    .from(mailMessages)
    .where(and(eq(mailMessages.status, 'queued'), lt(mailMessages.createdAt, cutoff)))
    .orderBy(asc(mailMessages.createdAt))
    .limit(options.limit)
}

/**
 * Retention. Only finished messages — a `queued` row older than the window is the sweep's
 * business, and deleting it would throw away something that has not been sent yet.
 */
export async function pruneMailMessages(
  database: Database,
  options: { olderThanMs: number },
): Promise<number> {
  const cutoff = new Date(Date.now() - options.olderThanMs)

  const deleted = await database
    .delete(mailMessages)
    .where(
      and(inArray(mailMessages.status, ['sent', 'failed']), lt(mailMessages.createdAt, cutoff)),
    )
    .returning({ id: mailMessages.id })

  return deleted.length
}

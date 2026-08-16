import { db } from '#db/client'
import { notFound } from '#lib/errors'
import { findMailMessage, listMailMessages, type MailRecord } from '#mail/mail.repo'
import type { ListMailQuery } from '#modules/mail/mail.schema'

/**
 * The Mail log page's side of the outbox.
 *
 * Read-only, entirely. There is no resend, and the reason is in the schema comment: a
 * terminal message has had its `payload` set to `NULL`, so the only thing left to send is
 * the **masked** copy — an invitation whose link reads `[redacted]`. A button that silently
 * delivered a dead link would be worse than no button. Sending again is inviting again,
 * from the endpoint that knows how to issue a fresh token.
 *
 * Both functions go through `mailColumns`, which is what keeps `payload` out of every
 * response. That is a projection rather than a deletion on the way out, because "remember
 * to strip the field" is a rule that survives exactly until somebody adds an endpoint in a
 * hurry.
 */

export type MailListPage = {
  items: MailRecord[]
  total: number
  page: number
  perPage: number
}

export async function listMail(query: ListMailQuery): Promise<MailListPage> {
  const { rows, total } = await listMailMessages(db, {
    status: query.status,
    template: query.template,
    q: query.q,
    page: query.page,
    perPage: query.perPage,
    sort: query.sort,
    order: query.order,
  })

  return { items: rows, total, page: query.page, perPage: query.perPage }
}

export async function getMail(id: string): Promise<MailRecord> {
  const message = await findMailMessage(db, id)
  if (!message) throw notFound('Message not found.')

  return message
}

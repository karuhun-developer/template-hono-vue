import { env } from '#env'
import { createLogMailer } from '#mail/driver/log'
import { createSmtpMailer } from '#mail/driver/smtp'

/**
 * The transport, from the caller's side — except that there is no caller.
 *
 * **Nothing in `modules/` imports this.** The only way to send is `queueMail()` in
 * `mail/outbox.ts`, which writes the row inside the caller's transaction and enqueues the
 * send. A service that reached for `mailer.send()` directly would be sending inside a
 * transaction that might still roll back, which is the exact failure the outbox exists to
 * prevent — so the door is narrow on purpose.
 *
 * This file must not import `#queue/*`. The send job imports both, which is what keeps
 * `#mail` and `#queue` from becoming a cycle; `outbox.ts` carries the same note.
 */

export type MailKind = 'log' | 'smtp'

export type MailAddress = {
  email: string
  name: string | null
}

/** A message that has been rendered and is ready to leave. Bodies here are **unmasked**. */
export type OutgoingMail = {
  to: MailAddress
  from: MailAddress
  subject: string
  text: string
  html: string
}

export type SendResult = {
  /** Whatever the transport calls its own id, when it has one. */
  providerMessageId: string | null
}

export type MailDriver = {
  readonly kind: MailKind
  send: (message: OutgoingMail) => Promise<SendResult>
}

/** The `From:` header, assembled once so every driver formats it identically. */
export function formatAddress(address: MailAddress): string {
  if (!address.name) return address.email
  // Quote the display name: a comma in it would otherwise read as a second recipient.
  return `"${address.name.replaceAll('"', '')}" <${address.email}>`
}

export function senderAddress(): MailAddress {
  return { email: env.MAIL_FROM, name: env.MAIL_FROM_NAME ?? null }
}

function createMailerFromEnv(): MailDriver {
  switch (env.MAIL_DRIVER) {
    case 'log':
      return createLogMailer()
    case 'smtp':
      return createSmtpMailer()
  }
}

/**
 * The process-wide driver. Constructing it opens nothing — a transport that connected at
 * boot would make a mail server being briefly down into an API that refuses to start.
 */
export const mailer: MailDriver = createMailerFromEnv()

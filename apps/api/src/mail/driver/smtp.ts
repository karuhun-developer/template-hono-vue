import type { Transporter } from 'nodemailer'
import type SMTPPool from 'nodemailer/lib/smtp-pool'

import { env } from '#env'
import { logger as defaultLogger } from '#lib/logger'
import { onShutdown } from '#lib/shutdown'
import { formatAddress, type MailDriver, type OutgoingMail, type SendResult } from '#mail/mailer'

/**
 * The driver for when mail has to actually arrive somewhere.
 *
 * `nodemailer` rather than a provider SDK: an SDK ties the template layer to one vendor, and
 * every vendor worth using speaks SMTP anyway. Rather than `node:net` directly, because the
 * part that would have to be hand-written is STARTTLS negotiation and AUTH — two things that
 * are only ever noticed when they are wrong.
 *
 * **`verify()` is deliberately never called**, at boot or anywhere else. A mail server having
 * a bad afternoon must not be an API that refuses to start; the failure belongs where every
 * other transient failure in this codebase belongs, which is a job that retries. `nodemailer`
 * is loaded through `await import()` for the same reason `bullmq` is: `mailer.ts` builds a
 * driver synchronously at boot, and the default installation sends through `log` and must not
 * pay to parse a transport it will never open.
 */

export type SmtpSettings = {
  host: string
  port: number
  /** Unset means "decide from the port" — see `smtpTransportOptions`. */
  secure?: boolean | undefined
  user?: string | undefined
  password?: string | undefined
  /**
   * The size of the connection pool. One per job that can be sending at the same instant:
   * more would be connections a mail server counts against us for nothing.
   */
  maxConnections?: number | undefined
}

/** Exactly what `nodemailer.createTransport` is handed. Separated so it can be asserted on. */
export type SmtpTransportOptions = {
  host: string
  port: number
  secure: boolean
  pool: true
  maxConnections: number
  auth?: { user: string; pass: string }
}

/**
 * The whole of the configuration logic, as a pure function, because it is the whole of what
 * is worth testing here — a unit test that pretended to reach a mail server would be testing
 * nodemailer.
 */
export function smtpTransportOptions(settings: SmtpSettings): SmtpTransportOptions {
  const { host, port, maxConnections = 5 } = settings

  return {
    host,
    port,
    /**
     * Port 465 is implicit TLS: the socket is encrypted before a single SMTP verb is spoken,
     * and a client that opens it in the clear hangs rather than failing. 587 is the opposite
     * — plaintext first, then `STARTTLS`, which nodemailer performs on its own when `secure`
     * is false. Guessing from the port is what makes the common two cases need no setting at
     * all; `SMTP_SECURE` exists for the relay that put implicit TLS somewhere else.
     */
    secure: settings.secure ?? port === 465,
    // Every send is a job, and jobs arrive in bursts. Reconnecting per message turns a
    // handshake into the expensive part of sending an email.
    pool: true,
    maxConnections,
    /**
     * Absent, not `{ user: undefined }`. A relay that authenticates by IP — the usual shape
     * of an internal one — is offered no credentials at all here; passing an empty pair would
     * make nodemailer attempt `AUTH` and be refused, which reads as a password problem on a
     * server that never wanted a password.
     */
    ...(settings.user === undefined
      ? {}
      : { auth: { user: settings.user, pass: settings.password ?? '' } }),
  }
}

export type SmtpMailerOptions = Partial<SmtpSettings> & {
  logger?: typeof defaultLogger
}

export function createSmtpMailer(options: SmtpMailerOptions = {}): MailDriver {
  const { logger = defaultLogger } = options

  const host = options.host ?? env.SMTP_HOST
  if (!host) {
    // Unreachable through `mailer.ts` — `env.ts` refuses to boot with MAIL_DRIVER=smtp and no
    // SMTP_HOST. Reachable by a caller constructing the factory directly, which is exactly
    // who benefits from being told which setting is missing.
    throw new Error('SMTP_HOST is required by the smtp mail driver')
  }

  const settings: SmtpSettings = {
    host,
    port: options.port ?? env.SMTP_PORT,
    secure: options.secure ?? env.SMTP_SECURE,
    user: options.user ?? env.SMTP_USER,
    password: options.password ?? env.SMTP_PASSWORD,
    maxConnections: options.maxConnections ?? env.QUEUE_CONCURRENCY,
  }

  let pending: Promise<Transporter<SMTPPool.SentMessageInfo>> | null = null

  /**
   * Open at most one pool, on the first send rather than at construction — the contract
   * `mailer.ts` states is that building a driver opens nothing.
   */
  const transport = (): Promise<Transporter<SMTPPool.SentMessageInfo>> => {
    pending ??= (async () => {
      const { createTransport } = await import('nodemailer')
      const created = createTransport(smtpTransportOptions(settings))

      // Registered here, so a driver that never sent anything registers no task. The pool
      // holds open TCP connections; leaving them to the process exiting is how a graceful
      // shutdown becomes a mail server logging a dropped connection every deploy.
      onShutdown('mail:smtp', () => {
        created.close()
      })

      logger.info({ host: settings.host, port: settings.port }, 'smtp transport opened')
      return created
    })()

    return pending
  }

  return {
    kind: 'smtp',

    async send(message: OutgoingMail): Promise<SendResult> {
      const info = await (
        await transport()
      ).sendMail({
        from: formatAddress(message.from),
        to: formatAddress(message.to),
        subject: message.subject,
        text: message.text,
        html: message.html,
      })

      // The server's own id, kept so a bounce report or a support question can be traced
      // back to a row in `mail_messages` without guessing from a timestamp.
      return { providerMessageId: info.messageId }
    },
  }
}

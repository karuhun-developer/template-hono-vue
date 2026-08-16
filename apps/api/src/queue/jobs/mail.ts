import { db } from '#db/client'
import { env } from '#env'
import {
  findMailForSend,
  findStuckMail,
  markMailFailed,
  markMailSent,
  pruneMailMessages,
} from '#mail/mail.repo'
import { mailer, senderAddress, type MailDriver } from '#mail/mailer'
import { renderTemplate } from '#mail/templates'
import { enqueue } from '#queue/queue'
import type { JobContext } from '#queue/registry'

/**
 * The three jobs behind `mail/`.
 *
 * This is the file where `#mail` and `#queue` meet. Both sides are careful not to import
 * the other — `mailer.ts` never enqueues, `outbox.ts` never sends — so the dependency
 * between the two subsystems exists here and only here.
 */

/**
 * How long a message may sit `queued` before the sweep assumes its dispatch was lost.
 *
 * Five minutes rather than five seconds: a queue with a backlog is not a queue with a
 * problem, and re-enqueueing something a busy worker was about to pick up would turn a slow
 * afternoon into a duplicate-email afternoon.
 */
const STUCK_AFTER_MS = 5 * 60_000

/** One sweep does not try to fix the whole backlog. Whatever is left is still there in five minutes. */
const SWEEP_BATCH = 100

/**
 * Send one message.
 *
 * The row is **re-read**, never carried in the job payload: a retry after a half-finished
 * attempt must see what actually happened, and a message that has already been sent is
 * skipped rather than sent twice. The body is **re-rendered** from `template` + `payload`
 * rather than taken from `text_body`, because what is stored there has been masked — that
 * is the whole point of storing it that way, and it is why a stolen database dump cannot be
 * replayed into a working invitation link.
 *
 * The `driver` argument is the seam every subsystem here has beside its singleton: `env` is
 * frozen at boot, so a test that wants to capture what was sent has no other way in.
 */
export async function sendMailJob(
  payload: { messageId: string },
  ctx: JobContext,
  driver: MailDriver = mailer,
): Promise<void> {
  const message = await findMailForSend(db, payload.messageId)

  if (!message) {
    // Retention swept it, or somebody deleted it. Nothing to send and nothing to record;
    // failing would only put a permanent error in the Jobs page.
    ctx.logger.warn({ messageId: payload.messageId }, 'mail message is gone — nothing to send')
    return
  }

  if (message.status === 'sent') {
    ctx.logger.debug({ messageId: message.id }, 'mail message has already been sent')
    return
  }

  if (!message.payload) {
    // A terminal state nulls the payload, so there is nothing left to render from. This is
    // reachable by retrying a message that had already given up, and the honest answer is
    // to stop rather than to send a blank email.
    await markMailFailed(db, message.id, {
      error:
        'the payload was cleared at a terminal state, so the message can no longer be rendered',
      terminal: true,
    })
    return
  }

  const lastAttempt = ctx.attempt >= ctx.maxAttempts

  let rendered
  try {
    rendered = renderTemplate(message.template, message.payload).rendered
  } catch (err) {
    // Terminal on purpose, whatever the attempt budget says: the same bytes will not render
    // on the next attempt either, and three identical failures is one confusing log line
    // repeated rather than any more information.
    await markMailFailed(db, message.id, { error: describe(err), terminal: true })
    throw err
  }

  try {
    const result = await driver.send({
      to: { email: message.toEmail, name: message.toName },
      from: { email: message.fromEmail, name: senderAddress().name },
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    })

    await markMailSent(db, message.id, {
      providerMessageId: result.providerMessageId,
      driver: driver.kind,
    })

    ctx.logger.info({ messageId: message.id, to: message.toEmail }, 'mail sent')
  } catch (err) {
    // `terminal` follows the queue's own accounting rather than a second budget here. The
    // job is what retries; this row is a record of what the job did, and the two disagreeing
    // is how a message ends up marked failed while a worker is still trying to send it.
    await markMailFailed(db, message.id, { error: describe(err), terminal: lastAttempt })
    // Rethrown, so the queue records the failure and applies its backoff. Swallowing it
    // here would leave a job that "succeeded" beside a message that did not.
    throw err
  }
}

/**
 * Re-enqueue messages whose send was never dispatched.
 *
 * This is what makes the non-transactional queue drivers safe for mail. Under `redis` the
 * enqueue happens after the commit, so a crash in between loses the job — but not the row,
 * which was written inside the transaction. Under `database` this should find nothing, and
 * the day it does, something is wrong with the worker rather than with the outbox.
 */
export async function sweepStuckMailJob(_payload: unknown, ctx: JobContext): Promise<void> {
  const stuck = await findStuckMail(db, { olderThanMs: STUCK_AFTER_MS, limit: SWEEP_BATCH })

  for (const row of stuck) {
    await enqueue('mail.send', { messageId: row.id })
  }

  if (stuck.length > 0) {
    ctx.logger.warn({ count: stuck.length }, 're-enqueued mail that was never dispatched')
  }
}

/** Retention. Finished messages only — `queued` ones are the sweep's business. */
export async function pruneMailJob(_payload: unknown, ctx: JobContext): Promise<void> {
  const removed = await pruneMailMessages(db, {
    olderThanMs: env.MAIL_RETENTION_DAYS * 86_400_000,
  })
  ctx.logger.info({ removed }, 'pruned old mail messages')
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

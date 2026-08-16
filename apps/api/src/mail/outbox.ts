import type { Transaction } from '#db/client'
import type { Defer } from '#db/tx'
import { insertMailMessage } from '#mail/mail.repo'
import { mailer, senderAddress } from '#mail/mailer'
import {
  maskSecrets,
  renderTemplate,
  type TemplateName,
  type TemplatePayload,
} from '#mail/templates'
import { enqueue } from '#queue/queue'

/**
 * **The only public way to send an email.**
 *
 * ```ts
 * await transaction(async (tx, defer) => {
 *   const user = await inviteUser(tx, input)
 *   await queueMail(tx, defer, {
 *     to: { email: user.email, name: user.name },
 *     template: 'invitation',
 *     payload: { name: user.name, token, expiresAt: expiresAt.toISOString() },
 *   })
 * })
 * ```
 *
 * Three things happen here, in this order, and the order is the design:
 *
 * 1. **Render**, so a template that cannot render fails inside the caller's transaction
 *    rather than three retries later in a worker log.
 * 2. **Store the masked body** through the caller's `tx`. The row commits with the change
 *    that caused it, which is what makes this an outbox: there is no way to have a message
 *    for an account that rolled back, and no way to lose a message for one that did not.
 * 3. **Enqueue the send**, passing both `tx` and `defer` so the driver honours whichever it
 *    can. Under `redis` the dispatch happens after the commit and can therefore be lost —
 *    which is exactly what `mail.sweep-stuck` picks up, because step 2 already committed.
 *
 * Note what is *not* here: sending. Nothing on a request path talks to a mail server, so a
 * provider having a slow afternoon is a queue depth rather than a timeout in somebody's
 * browser.
 *
 * `mailer` is imported for its `kind` alone. This file must not send, and `mail/mailer.ts`
 * must not import `#queue/*` — between them that is what keeps `#mail` and `#queue` from
 * becoming an import cycle.
 */

export type QueueMailInput<N extends TemplateName> = {
  to: { email: string; name?: string | null }
  template: N
  payload: TemplatePayload<N>
}

export async function queueMail<N extends TemplateName>(
  tx: Transaction,
  defer: Defer,
  input: QueueMailInput<N>,
): Promise<string> {
  const { rendered, payload } = renderTemplate(input.template, input.payload)
  const from = senderAddress()

  const messageId = await insertMailMessage(tx, {
    toEmail: input.to.email,
    toName: input.to.name ?? null,
    fromEmail: from.email,
    subject: rendered.subject,
    template: input.template,
    payload,
    // Masked, always, and at the only place a body is written. The unmasked render exists
    // for the length of this function and is then thrown away — the send job renders its
    // own from `template` + `payload`.
    textBody: maskSecrets(rendered.text, rendered.secrets),
    htmlBody: maskSecrets(rendered.html, rendered.secrets),
    driver: mailer.kind,
  })

  await enqueue('mail.send', { messageId }, { tx, defer })

  return messageId
}

/**
 * May a one-time link be handed back to whoever asked for it?
 *
 * Only under `MAIL_DRIVER=log`, where nothing actually reaches an inbox. A fresh clone has
 * no transport and the first thing anybody does with this template is invite somebody, so
 * the link has to come from somewhere — and with the log driver the response is the only
 * somewhere there is.
 *
 * The moment a real transport is configured the field goes `null`: the recipient has the
 * link, and answering the caller with a second copy of somebody else's credential is a
 * thing to stop doing rather than a convenience to keep.
 *
 * Written once, here, because the two callers that reveal a token — invitations and
 * admin-triggered resets — must not be able to disagree about the rule. `POST
 * /auth/forgot-password` never returns one under any driver; that is a different rule and
 * it belongs to that endpoint, which would otherwise hand the link to whoever asked.
 */
export function revealTokens(): boolean {
  return mailer.kind === 'log'
}

import { index, integer, jsonb, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'

import { primaryId, timestamps, timestamptz } from '#db/columns'

/**
 * Every message this application has tried to send.
 *
 * It is two things at once, and both are deliberate. It is the **outbox**: the row is
 * written inside the transaction that decided to send, so a message can never exist for a
 * change that then rolled back, and a message left `queued` is a message the sweep can
 * pick up. It is also the **record**, which is what the Mail log page reads — "did that
 * invitation ever go out" is a support question, and answering it from the log aggregator
 * means answering it only for as long as the retention there allows.
 *
 * > **A mail log that shows the rendered body is, naively implemented, an
 * > account-takeover feature.** The invitation body contains a live `inv_…` link, so
 * > anyone who can read a stored body could accept somebody else's invitation. Three
 * > mechanisms close that, and **all three are required**:
 * >
 * > 1. the template declares its `secrets`, and the outbox stores the body with each of
 * >    them replaced by `[redacted]` while the driver sends the unmasked render;
 * > 2. `payload` is absent from `mailColumns`, the way `passwordHash` is absent from
 * >    `userColumns`, so no read path can select it;
 * > 3. `payload` is set to `NULL` the moment the message reaches a terminal state, so a
 * >    token cannot outlive its send.
 */

/**
 * `queued` is the default because the row is written before anything is sent — that is
 * what makes it an outbox rather than a log.
 *
 * There is no `cancelled`: nothing cancels a message. A send that is no longer wanted is a
 * send that should not have been enqueued, and the row stays as the evidence that it was.
 */
export const mailStatus = pgEnum('mail_status', ['queued', 'sent', 'failed'])

export type MailStatus = (typeof mailStatus.enumValues)[number]

export const mailMessages = pgTable(
  'mail_messages',
  {
    id: primaryId(),

    toEmail: text('to_email').notNull(),
    toName: text('to_name'),

    /**
     * Copied from `MAIL_FROM` at the moment of sending rather than read back from the
     * environment. A row that renders today's sender for a message sent under last year's
     * domain is a record of something that never happened.
     */
    fromEmail: text('from_email').notNull(),

    subject: text('subject').notNull(),

    /** A key in the `TEMPLATES` registry — see `src/mail/templates/index.ts`. */
    template: text('template').notNull(),

    /**
     * The template data, which for an invitation **contains the live token**.
     *
     * It is here because the send re-renders from it: the stored body is masked, so it is
     * not something that can be sent. It is never in any SELECT the read API performs, and
     * it is nulled at a terminal state. See the three mechanisms above.
     */
    payload: jsonb('payload').$type<Record<string, unknown>>(),

    /** The rendered copy **with every secret replaced** — this is the part safe to display. */
    textBody: text('text_body'),
    htmlBody: text('html_body'),

    status: mailStatus('status').notNull().default('queued'),

    /**
     * Which driver carried it, recorded per message rather than inferred from the current
     * `MAIL_DRIVER`. "It says sent, but did it reach a server" is a different question when
     * the answer is `log`.
     */
    driver: text('driver').notNull(),

    attempts: integer('attempts').notNull().default(0),
    error: text('error'),

    /** Whatever the transport calls its own id — the thread to pull in a provider's logs. */
    providerMessageId: text('provider_message_id'),

    sentAt: timestamptz('sent_at'),

    ...timestamps(),
  },
  (table) => [
    /** The page's default view, and the sweep's query: what is stuck, newest first. */
    index('mail_messages_status_created_idx').on(table.status, table.createdAt.desc()),

    /** "What have we sent this person" — the support question, asked by address. */
    index('mail_messages_to_created_idx').on(table.toEmail, table.createdAt.desc()),

    /** The template facet on the Mail log page. */
    index('mail_messages_template_created_idx').on(table.template, table.createdAt.desc()),
  ],
)

export type MailMessage = typeof mailMessages.$inferSelect
export type NewMailMessage = typeof mailMessages.$inferInsert

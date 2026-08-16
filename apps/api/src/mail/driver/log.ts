import { randomUUID } from 'node:crypto'

import { isProduction } from '#env'
import { logger } from '#lib/logger'
import type { MailDriver, OutgoingMail, SendResult } from '#mail/mailer'

/**
 * The default driver, and a real one rather than a stub.
 *
 * A fresh clone has no SMTP server, no provider account and no API key, and the first thing
 * anybody does with this template is invite somebody. With this driver that works: the row
 * lands in `mail_messages`, the Mail log page shows it, and the link is in the terminal
 * running `make dev`.
 *
 * It is **allowed in production** — some installations genuinely want no outbound mail —
 * and `src/index.ts` warns at boot when it is, because the other reason to be running it
 * there is having forgotten to configure a transport.
 */
export function createLogMailer(): MailDriver {
  return {
    kind: 'log',

    send(message: OutgoingMail): Promise<SendResult> {
      const id = randomUUID()

      logger.info(
        {
          mailId: id,
          to: message.to.email,
          subject: message.subject,
          // Outside production, the text part — which contains the live link. That is the
          // point of the driver in development, and it is also why this branch exists at
          // all: a production log carrying invitation links is a credential store nobody
          // is treating as one.
          ...(isProduction ? {} : { body: message.text }),
        },
        'mail (log driver) — not actually sent',
      )

      return Promise.resolve({ providerMessageId: id })
    },
  }
}

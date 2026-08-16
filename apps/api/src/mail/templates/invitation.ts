import { z } from 'zod'

import {
  consoleLink,
  renderLayout,
  type RenderedTemplate,
  type TemplateContext,
} from '#mail/templates/layout'

/**
 * "You have been invited" — the message behind `POST /users` and `POST /users/:id/resend`.
 *
 * The payload is **JSON and only JSON**, for the same reason a job payload is: it is stored
 * in `jsonb` and re-parsed when the send job runs, so a `Date` written here would come back
 * as a string and every reader would be quietly wrong.
 */

export const invitationPayload = z.object({
  name: z.string(),
  token: z.string(),
  expiresAt: z.iso.datetime(),
})

export type InvitationPayload = z.infer<typeof invitationPayload>

/**
 * The window, said in a way somebody can act on.
 *
 * A UTC timestamp in an email is a support ticket; "in 7 days" is not, and it stays true
 * whatever the reader's timezone is — which is the one thing we cannot know here.
 */
export function describeWindow(fromIso: string, untilIso: string): string {
  const ms = new Date(untilIso).getTime() - new Date(fromIso).getTime()
  const hours = Math.max(1, Math.round(ms / 3_600_000))

  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`

  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

export function renderInvitation(
  payload: InvitationPayload,
  context: TemplateContext,
): RenderedTemplate {
  const url = consoleLink(context, `/invitation/${payload.token}`)
  const window = describeWindow(new Date().toISOString(), payload.expiresAt)

  const { text, html } = renderLayout({
    context,
    heading: `You have been invited to ${context.appName}`,
    paragraphs: [
      `Hello ${payload.name},`,
      `Somebody has created an account for you on ${context.appName}. Follow the link below to choose a password and sign in.`,
      `The link works once and expires in about ${window}.`,
    ],
    action: { label: 'Accept the invitation', url },
    footer:
      'If you were not expecting this, you can ignore this email — nothing happens until the link is used.',
  })

  return {
    subject: `You have been invited to ${context.appName}`,
    text,
    html,
    // The token, not the URL. Masking the token blanks it inside the URL as well, which is
    // the occurrence that matters: the link is what a reader of the stored copy would click.
    secrets: [payload.token],
  }
}

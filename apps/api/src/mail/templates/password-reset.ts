import { z } from 'zod'

import { describeWindow } from '#mail/templates/invitation'
import {
  consoleLink,
  renderLayout,
  type RenderedTemplate,
  type TemplateContext,
} from '#mail/templates/layout'

/**
 * "Reset your password" — behind both `POST /auth/forgot-password` and the admin-triggered
 * `POST /users/:id/reset-password`.
 *
 * One template for both, and `triggeredByAdmin` is the only difference: the person needs to
 * know whether the link arrived because they asked for it or because somebody else did.
 * Two templates would be two places to fix the day the wording changes.
 */

export const passwordResetPayload = z.object({
  name: z.string(),
  token: z.string(),
  expiresAt: z.iso.datetime(),
  triggeredByAdmin: z.boolean().default(false),
})

export type PasswordResetPayload = z.infer<typeof passwordResetPayload>

export function renderPasswordReset(
  payload: PasswordResetPayload,
  context: TemplateContext,
): RenderedTemplate {
  const url = consoleLink(context, `/reset-password/${payload.token}`)
  const window = describeWindow(new Date().toISOString(), payload.expiresAt)

  const reason = payload.triggeredByAdmin
    ? `An administrator has started a password reset for your ${context.appName} account.`
    : `Somebody asked to reset the password for your ${context.appName} account.`

  const { text, html } = renderLayout({
    context,
    heading: 'Reset your password',
    paragraphs: [
      `Hello ${payload.name},`,
      reason,
      `The link works once and expires in about ${window}. Using it signs you out everywhere else.`,
    ],
    action: { label: 'Choose a new password', url },
    footer: payload.triggeredByAdmin
      ? 'If you were not expecting this, speak to whoever administers your account — your current password still works until the link is used.'
      : 'If this was not you, ignore this email. Your password has not changed and nothing happens until the link is used.',
  })

  return {
    subject: `Reset your ${context.appName} password`,
    text,
    html,
    secrets: [payload.token],
  }
}

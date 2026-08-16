import { z } from 'zod'

import { invitationPayload, renderInvitation } from '#mail/templates/invitation'
import {
  templateContext,
  type RenderedTemplate,
  type TemplateContext,
} from '#mail/templates/layout'
import { passwordResetPayload, renderPasswordReset } from '#mail/templates/password-reset'

/**
 * The catalog of everything this application can send.
 *
 * The third `as const satisfies` registry in the codebase, after `PERMISSIONS` and `JOBS`,
 * and for the same reason: `TemplateName` and `TemplatePayload<N>` are **derived**, so
 * `queueMail(tx, defer, { template: 'invitaton', … })` is a compile error rather than a
 * message nobody can render.
 *
 * Templates live here rather than beside the service that sends them because more than one
 * module already sends the same kinds of mail — a password reset is triggered from `auth`
 * and from `users` — and a template owned by one caller is a template the second caller
 * copies.
 *
 * A `templates.ts` beside a `templates/` directory rather than a `templates/index.ts`, for
 * the reason `db/schema.ts` gives: the `#*` alias maps one-to-one onto files and does no
 * directory resolution.
 */

/**
 * `never` as the payload parameter, the same trick `JobDefinition` uses: parameters are
 * contravariant, so every concrete renderer is assignable to this and the catalog can hold
 * templates of different payload types without a cast.
 */
export type MailTemplate = {
  readonly payload: z.ZodType
  readonly render: (payload: never, context: TemplateContext) => RenderedTemplate
}

export type TemplateCatalog = Record<string, MailTemplate>

export const TEMPLATES = {
  invitation: { payload: invitationPayload, render: renderInvitation },
  'password-reset': { payload: passwordResetPayload, render: renderPasswordReset },
} as const satisfies TemplateCatalog

export type TemplateName = keyof typeof TEMPLATES

export type TemplatePayload<N extends TemplateName> = z.input<(typeof TEMPLATES)[N]['payload']>

export function isTemplateName(value: string): value is TemplateName {
  return Object.hasOwn(TEMPLATES, value)
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[]

export type PreparedMail = {
  rendered: RenderedTemplate
  /**
   * The payload as it will be stored: parsed, defaults applied, and put through JSON once
   * here. What a re-render sees is then identical whether it happened in the same process
   * or three retries later out of `jsonb`.
   */
  payload: Record<string, unknown>
}

/**
 * Render a message — on the way in, and again on the way out.
 *
 * The payload is re-parsed rather than trusted, because on the second call it came out of
 * `jsonb` and may have been written by an older build. A row whose payload no longer parses
 * is a **terminal** failure rather than a retry: the same bytes will not parse next time
 * either.
 */
export function renderTemplate(name: string, payload: unknown): PreparedMail {
  if (!isTemplateName(name)) {
    throw new Error(`unknown mail template "${name}" — add it to TEMPLATES in src/mail/templates`)
  }

  const template: MailTemplate = TEMPLATES[name]
  const parsed = template.payload.safeParse(payload)
  if (!parsed.success) {
    throw new Error(
      `the payload for the "${name}" template is invalid: ${z.prettifyError(parsed.error)}`,
    )
  }

  return {
    rendered: template.render(parsed.data as never, templateContext()),
    payload: JSON.parse(JSON.stringify(parsed.data)) as Record<string, unknown>,
  }
}

/**
 * Replace every declared secret with `[redacted]`, everywhere it occurs.
 *
 * This is what makes a stored body safe to display. It runs over the **rendered** strings,
 * so a token interpolated into a URL is masked inside that URL too — which is the whole
 * point, because the link is the part somebody reading the mail log would click.
 *
 * Anything shorter than eight characters is **skipped**, and that is a deliberate refusal
 * rather than an optimisation: a template that declared `''` or a person's initials would
 * otherwise shred the whole body into `[redacted]`, and a body nobody can read is not a
 * safer body — it is a mail log that stops being worth having. A real secret here is a
 * 43-character token.
 */
export function maskSecrets(body: string, secrets: readonly string[]): string {
  let masked = body
  for (const secret of secrets) {
    if (secret.length < 8) continue
    masked = masked.replaceAll(secret, '[redacted]')
  }
  return masked
}

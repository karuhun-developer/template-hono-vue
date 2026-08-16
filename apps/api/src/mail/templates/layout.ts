import { env } from '#env'

/**
 * The shell every message is rendered into, and the shape every template returns.
 *
 * Plain TypeScript — no MJML, no `react-email`. A template here is a function from a
 * payload to four strings, which means it is unit-testable without a renderer and readable
 * without knowing a second templating language. When the marketing team wants a designed
 * newsletter, that is a different system; this one sends six transactional messages.
 */

export type RenderedTemplate = {
  subject: string
  /** The plain-text part. Never optional: text-only is a spam score, but HTML-only is worse. */
  text: string
  html: string
  /**
   * Every substring in `text`/`html` that must not be stored.
   *
   * Declared by the template rather than detected by the outbox, because only the template
   * knows which of the strings it was handed is a credential. A token listed here is masked
   * everywhere it occurs — including **inside the URL it was interpolated into**, which is
   * the occurrence a naive implementation misses.
   */
  secrets: string[]
}

/** What every template is given for free, so none of them reads `env` directly. */
export type TemplateContext = {
  appName: string
  consoleUrl: string
}

export function templateContext(): TemplateContext {
  return { appName: env.APP_NAME, consoleUrl: env.CONSOLE_URL }
}

/**
 * Build an absolute link into the console.
 *
 * Absolute because the reader is in a mail client, where there is no origin to be relative
 * to, and built from `CONSOLE_URL` because the code doing the building runs in a worker
 * where `window` does not exist.
 */
export function consoleLink(context: TemplateContext, path: string): string {
  return new URL(path, context.consoleUrl).toString()
}

/** Escape for interpolation into the HTML part. A person's name is attacker-influenced text. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

export type LayoutInput = {
  context: TemplateContext
  heading: string
  /** Paragraphs, in order. Plain text — escaped on the way into the HTML part. */
  paragraphs: string[]
  action?: { label: string; url: string }
  /** The last line, usually the "if you were not expecting this" one. */
  footer?: string
}

/**
 * One layout for both parts, so the two cannot drift into saying different things.
 *
 * The HTML is deliberately unremarkable: tables and inline styles, because the clients
 * that matter still parse a subset of CSS from 2005. Nothing here is loaded from a CDN —
 * a mail client that blocks remote content would otherwise render a blank rectangle.
 */
export function renderLayout(input: LayoutInput): { text: string; html: string } {
  const { context, heading, paragraphs, action, footer } = input

  const textParts = [
    heading,
    '',
    ...paragraphs,
    ...(action ? ['', `${action.label}: ${action.url}`] : []),
    ...(footer ? ['', footer] : []),
    '',
    `— ${context.appName}`,
  ]

  const htmlParagraphs = paragraphs
    .map((paragraph) => `<p style="margin:0 0 16px;">${escapeHtml(paragraph)}</p>`)
    .join('\n      ')

  const htmlAction = action
    ? `<p style="margin:24px 0;">
        <a href="${escapeHtml(action.url)}" style="background:#18181b;border-radius:6px;color:#fafafa;display:inline-block;padding:10px 18px;text-decoration:none;">${escapeHtml(action.label)}</a>
      </p>
      <p style="color:#71717a;font-size:13px;margin:0 0 16px;word-break:break-all;">Or paste this into your browser: ${escapeHtml(action.url)}</p>`
    : ''

  const htmlFooter = footer
    ? `<p style="color:#71717a;font-size:13px;margin:24px 0 0;">${escapeHtml(footer)}</p>`
    : ''

  const html = `<!doctype html>
<html lang="en">
  <body style="background:#f4f4f5;color:#18181b;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;margin:0;padding:24px;">
    <div style="background:#ffffff;border-radius:10px;margin:0 auto;max-width:560px;padding:32px;">
      <h1 style="font-size:20px;margin:0 0 20px;">${escapeHtml(heading)}</h1>
      ${htmlParagraphs}
      ${htmlAction}
      ${htmlFooter}
      <p style="color:#a1a1aa;font-size:13px;margin:24px 0 0;">— ${escapeHtml(context.appName)}</p>
    </div>
  </body>
</html>`

  return { text: textParts.join('\n'), html }
}

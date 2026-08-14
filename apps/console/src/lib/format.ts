/**
 * Display formatting.
 *
 * The locale is left **undefined** on purpose, so `Intl` follows the browser: a template
 * has no idea where it will be deployed, and hard-coding `en-US` would show an American
 * date order to somebody in Jakarta or Berlin. If your application does have one correct
 * locale, name it here — in one place rather than at every call site.
 */

const DATE_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
const DATE_ONLY = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

export function formatDateTime(value: string | null | undefined, fallback = '—'): string {
  const date = parse(value)
  return date ? DATE_TIME.format(date) : fallback
}

export function formatDate(value: string | null | undefined, fallback = '—'): string {
  const date = parse(value)
  return date ? DATE_ONLY.format(date) : fallback
}

/**
 * A date that cannot be read comes back as `null`, not as `Invalid Date` — `Intl` renders
 * the latter as the literal text "Invalid Date" in the middle of a table.
 */
function parse(value: string | null | undefined): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

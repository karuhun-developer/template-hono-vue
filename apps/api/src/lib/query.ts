import { z } from 'zod'

/**
 * Helpers for reading query strings.
 *
 * A query string is not a JSON body: everything in it is text, and a key may appear more
 * than once. Both facts are handled here rather than in each module's schema, so that
 * every list endpoint in this API answers the same way to the same URL.
 */

/**
 * A filter that may be given more than once.
 *
 * `?status=active&status=invited` reaches the handler as an array and `?status=active` as
 * a plain string; both mean a set, so this flattens them into one and the repository only
 * ever sees a list. Without it the second value would either be dropped silently or make
 * the whole request invalid — and a filter that quietly ignores half of what was picked is
 * worse than one that refuses.
 *
 * ```ts
 * status: repeatable(z.enum(['invited', 'active', 'disabled'])).optional()
 * ```
 */
export function repeatable<T extends z.ZodTypeAny>(value: T) {
  return z
    .union([value, z.array(value)])
    .transform((given) => (Array.isArray(given) ? given : [given]) as z.output<T>[])
}

/**
 * Make a search term safe to drop between two `%` signs.
 *
 * `%` and `_` are wildcards to `LIKE`, so an unescaped `%` typed into a search box is a
 * query that matches everything and a `_` is one that quietly matches too much. Neither is
 * an injection — the value is still a bound parameter — which is exactly why it goes
 * unnoticed: the endpoint answers 200 with the wrong rows.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

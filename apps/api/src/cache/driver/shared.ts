/**
 * The two things every cache driver does the same way.
 *
 * Both exist so that swapping `CACHE_DRIVER` changes where an entry lives and nothing else.
 * A driver that stored the caller's object by reference would hand back something the
 * others could not — a `Date`, a `Map`, or an object a previous caller has since mutated —
 * and the difference would only show up on the deploy that changed the setting.
 */

/**
 * A cache value as it is stored: JSON text.
 *
 * The `undefined` check is not defensive noise. `JSON.stringify(undefined)` is `undefined`,
 * not `"undefined"`, so without it the value written would be nothing at all — and since
 * `undefined` is how `get` spells "not here", the entry would read back as a permanent
 * miss that nonetheless occupies a key. Cache `null` instead, and hear about it here rather
 * than three layers away.
 */
export function encode(value: unknown): string {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) {
    throw new Error(
      'a cache value must be JSON-serialisable and not undefined — cache null instead',
    )
  }
  return encoded
}

export function decode<T>(raw: string): T {
  return JSON.parse(raw) as T
}

/**
 * The same round trip, stopping at the parsed value rather than the text.
 *
 * For the database driver, whose column is `jsonb`: the value has to arrive as data that
 * `pg` can serialise, and it has to be normalised in exactly the way the other two drivers
 * normalise it.
 */
export function normalise(value: unknown): unknown {
  return JSON.parse(encode(value)) as unknown
}

import type { CacheDriver } from '#cache/cache'
import { decode, encode } from '#cache/driver/shared'
import { env } from '#env'

/**
 * The default driver: a `Map` in this process.
 *
 * **Correct for one process only.** Nothing here is shared, so with two replicas an entry
 * written by one is invisible to the other, and — the part that actually bites —
 * `deletePrefix` on one replica leaves the other serving the value it was asked to drop.
 * That is fine for a template, fine for a single container, and the reason
 * `CACHE_ACCESS_PERMISSIONS` warns at boot when it is switched on with this driver.
 *
 * Entries are stored as **JSON text**, not as the caller's object. It costs a parse per
 * read and buys two things: the value cannot be mutated through a reference somebody kept,
 * and what comes back is identical to what the database and redis drivers would have
 * returned. See `shared.ts`.
 */

export type MemoryCacheOptions = {
  /** Defaults to `CACHE_MAX_ENTRIES`. Constructed directly by tests, because `env` is frozen. */
  maxEntries?: number
  /** Defaults to `CACHE_PREFIX`. */
  prefix?: string
}

type Entry = { value: string; expiresAt: number }

export function createMemoryCache(options: MemoryCacheOptions = {}): CacheDriver {
  const maxEntries = options.maxEntries ?? env.CACHE_MAX_ENTRIES
  const prefix = options.prefix ?? env.CACHE_PREFIX

  const entries = new Map<string, Entry>()

  const read = (key: string): Entry | undefined => {
    const entry = entries.get(prefix + key)
    if (!entry) return undefined

    // Lazy expiry. There is no sweeper here — an expired entry costs one map slot until
    // somebody asks for it or the cap evicts it, and a timer per entry would cost more.
    if (entry.expiresAt <= Date.now()) {
      entries.delete(prefix + key)
      return undefined
    }

    return entry
  }

  return {
    kind: 'memory',

    get: <T>(key: string) => {
      const entry = read(key)
      return Promise.resolve(entry === undefined ? undefined : decode<T>(entry.value))
    },

    /**
     * The body is inside a `then` for one reason: `encode` throws on a value that is not
     * JSON, and a driver whose `set` throws synchronously while the other two reject is two
     * error paths at every call site. This one is nothing but synchronous work, so it has
     * nothing to `await` and cannot be written `async`.
     */
    set: (key, value, ttlMs) =>
      Promise.resolve().then(() => {
        const full = prefix + key

        // Delete first, so a rewrite moves the entry to the back of the insertion order.
        // The entry evicted below is then the one written longest ago rather than the one
        // first created — a key rewritten every minute for a day is not the one to lose.
        entries.delete(full)
        entries.set(full, { value: encode(value), expiresAt: Date.now() + ttlMs })

        while (entries.size > maxEntries) {
          const oldest = entries.keys().next()
          if (oldest.done === true) break
          entries.delete(oldest.value)
        }
      }),

    delete: (key) => {
      entries.delete(prefix + key)
      return Promise.resolve()
    },

    deletePrefix: (keyPrefix) => {
      const full = prefix + keyPrefix
      let removed = 0

      for (const key of entries.keys()) {
        if (!key.startsWith(full)) continue
        entries.delete(key)
        removed += 1
      }

      return Promise.resolve(removed)
    },

    clear: () => {
      // Only what this installation put here. `entries.clear()` would be the same thing
      // today — the map holds nothing else — and would stop being the same thing the day
      // two caches shared one map, so the prefix is honoured here as well.
      for (const key of entries.keys()) {
        if (key.startsWith(prefix)) entries.delete(key)
      }
      return Promise.resolve()
    },

    close: () => Promise.resolve(),
  }
}

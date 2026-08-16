import type { Redis } from 'ioredis'
import type { Logger } from 'pino'

import type { CacheDriver } from '#cache/cache'
import { decode, encode } from '#cache/driver/shared'
import { env } from '#env'
import { logger as defaultLogger } from '#lib/logger'

/**
 * The driver for when the cache should be shared and fast.
 *
 * `ioredis` is already here — BullMQ brought it in Phase 3 — so this driver adds no
 * dependency of its own. It does **not** share BullMQ's connection: a cache `GET` behind a
 * worker's blocking `BZPOPMIN` would wait for it, and the two have opposite settings for
 * `maxRetriesPerRequest` for exactly that reason (see `queue/driver/redis.ts`).
 *
 * Loaded through `await import()`, never at module scope, for the same reason as the queue
 * driver: `cache.ts` picks a driver synchronously at boot, and an installation on the
 * default `memory` driver must not pay to parse a Redis client it will never use.
 *
 * Redis does expiry itself, through `PX`, so there is nothing here for `cache.sweep` to do
 * and no way to serve a stale entry.
 */

export type RedisCacheOptions = {
  /** Defaults to `REDIS_URL`. Constructed directly by tests, because `env` is frozen. */
  url?: string
  /** Defaults to `CACHE_PREFIX`. Every key this driver touches begins with it. */
  prefix?: string
  logger?: Logger
}

/** Same memoiser as the queue driver, and written as a generic for the same reason. */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null
  return () => (pending ??= load())
}

/**
 * Make a literal string safe to hand to `SCAN MATCH`.
 *
 * `*`, `?` and `[…]` are glob metacharacters there, and a prefix is built from application
 * data — so an unescaped one would invalidate keys nobody asked about. The same class of
 * bug as `escapeLike`, in a different matcher's syntax.
 */
function escapeGlob(value: string): string {
  return value.replace(/[[\]\\?*]/g, (match) => `\\${match}`)
}

export function createRedisCache(options: RedisCacheOptions = {}): CacheDriver {
  const { logger = defaultLogger } = options
  const prefix = options.prefix ?? env.CACHE_PREFIX

  const url = options.url ?? env.REDIS_URL
  if (!url) {
    // Unreachable through `cache.ts` — `env.ts` refuses to boot with CACHE_DRIVER=redis and
    // no REDIS_URL. Reachable by a test constructing the factory directly, which is exactly
    // who benefits from being told which setting is missing.
    throw new Error('REDIS_URL is required by the redis cache driver')
  }

  let client: Redis | null = null

  const connect = once(async (): Promise<Redis> => {
    const { default: RedisClient } = await import('ioredis')
    const connection = new RedisClient(url)

    connection.on('error', (err: unknown) => {
      // ioredis reconnects on its own. An unhandled 'error' event would take the process
      // down instead, which is a strange way to survive a Redis restart — and a cache that
      // can kill the API is worse than no cache.
      logger.error({ err }, 'redis cache connection error')
    })

    client = connection
    return connection
  })

  /**
   * Delete every key under a pattern, in batches.
   *
   * `SCAN` rather than `KEYS`, because `KEYS` is a single blocking command over the whole
   * keyspace and this is the one operation whose cost grows with how much *else* is in
   * Redis. `UNLINK` rather than `DEL` so the freeing happens on a background thread.
   *
   * Not exact under concurrent writes — a key created after the cursor passed its slot
   * survives. That is acceptable for invalidation of a cache, and it is why `deletePrefix`
   * is documented as invalidation and not as a guarantee.
   */
  const scanDelete = async (pattern: string): Promise<number> => {
    const connection = await connect()
    let cursor = '0'
    let removed = 0

    do {
      const [next, keys] = await connection.scan(cursor, 'MATCH', pattern, 'COUNT', 500)
      cursor = next

      if (keys.length > 0) {
        await connection.unlink(...keys)
        removed += keys.length
      }
    } while (cursor !== '0')

    return removed
  }

  return {
    kind: 'redis',

    get: async <T>(key: string) => {
      const raw = await (await connect()).get(prefix + key)
      return raw === null ? undefined : decode<T>(raw)
    },

    set: async (key, value, ttlMs) => {
      // `PX` and not `EX`: a sub-second TTL rounded up to a second is a test that passes
      // because the entry outlived the assertion.
      await (await connect()).set(prefix + key, encode(value), 'PX', Math.max(1, Math.round(ttlMs)))
    },

    delete: async (key) => {
      await (await connect()).unlink(prefix + key)
    },

    deletePrefix: (keyPrefix) => scanDelete(`${escapeGlob(prefix + keyPrefix)}*`),

    clear: async () => {
      // Not `FLUSHDB`. This installation may be sharing the instance with BullMQ's own keys
      // — and with somebody else's application entirely.
      await scanDelete(`${escapeGlob(prefix)}*`)
    },

    /** Shutdown only. The memoised connection is not reopened, so a read after this throws. */
    close: async () => {
      const open = client
      client = null
      if (!open) return

      await open.quit().catch(() => {
        open.disconnect()
      })
    },
  }
}

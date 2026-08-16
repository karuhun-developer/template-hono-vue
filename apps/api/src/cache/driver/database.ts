import type { CacheDriver } from '#cache/cache'
import {
  deleteCacheEntriesWithPrefix,
  deleteCacheEntry,
  readCacheEntry,
  writeCacheEntry,
} from '#cache/cache.repo'
import { normalise } from '#cache/driver/shared'
import { db as defaultDb, type Database } from '#db/client'
import { env } from '#env'

/**
 * The driver for when the cache has to be shared and there is no Redis.
 *
 * Which is most installations: a second replica is a much smaller decision than a second
 * piece of infrastructure, and this driver makes invalidation work across replicas using
 * the database that is already there. It is slower than `memory` and slower than `redis`,
 * and that is the trade — a cache miss here still costs a round trip to Postgres, so this
 * is worth it for a value that is expensive to compute, not for one that is merely awkward
 * to reach.
 *
 * All the SQL is in `cache.repo.ts`, including the reason expiry is filtered on the read.
 */

export type DatabaseCacheOptions = {
  /** Defaults to the process pool. Passed directly by tests. */
  database?: Database
  /** Defaults to `CACHE_PREFIX`. */
  prefix?: string
}

export function createDatabaseCache(options: DatabaseCacheOptions = {}): CacheDriver {
  const database = options.database ?? defaultDb
  const prefix = options.prefix ?? env.CACHE_PREFIX

  return {
    kind: 'database',

    get: async <T>(key: string) => {
      const wrapped = await readCacheEntry(database, prefix + key)
      // `null` is the missing row; `{ v: null }` is a cached null. The wrapper exists to
      // keep those two apart — see `db/schema/cache.ts`.
      return wrapped === null ? undefined : (wrapped.v as T)
    },

    set: async (key, value, ttlMs) => {
      await writeCacheEntry(database, {
        key: prefix + key,
        // Computed from this process's clock while the read compares against the
        // database's. A container running a minute fast therefore writes entries that live
        // a minute less, which is the harmless direction — and the alternative,
        // `now() + interval`, would put a TTL in SQL where nothing type-checks it.
        value: { v: normalise(value) },
        expiresAt: new Date(Date.now() + ttlMs),
      })
    },

    delete: (key) => deleteCacheEntry(database, prefix + key),

    deletePrefix: (keyPrefix) => deleteCacheEntriesWithPrefix(database, prefix + keyPrefix),

    clear: async () => {
      await deleteCacheEntriesWithPrefix(database, prefix)
    },

    // The pool is not this driver's to close: `db/client.ts` registered it with the
    // shutdown registry long before anything asked for a cache.
    close: () => Promise.resolve(),
  }
}

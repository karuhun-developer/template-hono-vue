import { createDatabaseCache } from '#cache/driver/database'
import { createMemoryCache } from '#cache/driver/memory'
import { createRedisCache } from '#cache/driver/redis'
import { env } from '#env'
import { onShutdown } from '#lib/shutdown'

/**
 * The cache, from the caller's side.
 *
 * `remember(key, ttlMs, load)` is the whole API most call sites need. Which driver holds
 * the entry, and whether it is shared with the replica next door, is configuration — see
 * `docs/features/cache.md` for what each one guarantees.
 *
 * Two rules run through every driver here, because a cache whose behaviour depends on its
 * driver is a cache that works in the test suite and not in production:
 *
 * 1. **A value is JSON**, and it goes through a serialise/parse round trip on the way in
 *    even in memory. A `Date` therefore comes back as a string from every driver, rather
 *    than surviving `memory` and arriving as a string from `redis`.
 * 2. **Keys are namespaced by `CACHE_PREFIX`**, inside the driver. Two installations
 *    sharing one Redis or one Postgres do not read each other's entries, and `clear()`
 *    empties what this installation put there and nothing else.
 *
 * There is no `tags` concept and there will not be one: a tag index is a second thing to
 * keep correct inside every driver, and it is where "the cache is wrong" usually comes
 * from. Invalidating a group is `deletePrefix`, or an explicit fan-out written at the call
 * site where it can be read — see `forgetAccessForRole` for the one place that needs it.
 */

export type CacheKind = 'memory' | 'database' | 'redis'

export type CacheDriver = {
  readonly kind: CacheKind
  /** `undefined` means "not here" — including "here but expired". */
  get: <T>(key: string) => Promise<T | undefined>
  set: <T>(key: string, value: T, ttlMs: number) => Promise<void>
  delete: (key: string) => Promise<void>
  /**
   * Invalidation only. O(n) on redis (`SCAN`) and on memory; never on a request path.
   *
   * Returns how many entries went, which is what makes an invalidation visible in a log
   * line rather than something you have to infer from the next request.
   */
  deletePrefix: (prefix: string) => Promise<number>
  /** Everything under `CACHE_PREFIX`. Never the whole store — see the note above. */
  clear: () => Promise<void>
  /**
   * Release whatever the driver holds open. Safe to call twice, and safe on a driver that
   * holds nothing — which is every driver but `redis`.
   *
   * Not in the plan's interface, and added deliberately: without it the redis driver's
   * connection is the one thing that would keep a shut-down process alive.
   */
  close: () => Promise<void>
}

function createCacheFromEnv(): CacheDriver {
  switch (env.CACHE_DRIVER) {
    case 'memory':
      return createMemoryCache()
    case 'database':
      return createDatabaseCache()
    case 'redis':
      return createRedisCache()
  }
}

/**
 * The process-wide driver.
 *
 * Constructing it connects to nothing: the redis driver opens its connection at the first
 * `get`, so an API replica configured for redis and serving only cached-nothing requests
 * never opens one.
 */
export const cache: CacheDriver = createCacheFromEnv()

onShutdown('cache', () => cache.close())

/**
 * The loads that are in flight right now, per driver.
 *
 * Keyed by driver rather than module-global so a suite constructing its own driver does not
 * share a flight with the singleton — two caches that happen to use the same key would
 * otherwise hand each other's value back, which is the kind of bug that only appears when
 * the tests run in one process.
 */
const inFlight = new WeakMap<CacheDriver, Map<string, Promise<unknown>>>()

function flights(driver: CacheDriver): Map<string, Promise<unknown>> {
  let map = inFlight.get(driver)
  if (!map) {
    map = new Map()
    inFlight.set(driver, map)
  }
  return map
}

/**
 * Read through the cache, and compute the value at most once.
 *
 * The single-flight map is the part worth understanding. A cold key hit by fifty concurrent
 * requests would otherwise run the loader fifty times — a stampede, and the load is
 * expensive by definition or it would not be cached. The map de-duplicates the *loads*, not
 * the lookups: every caller still asks the driver, which is cheap, and then all but one of
 * them wait on the same promise. Same trick as `bootstrap()` in the console's session store.
 *
 * A loader that throws rejects every caller waiting on it and caches nothing, so the next
 * request tries again rather than inheriting a failure for a whole TTL.
 *
 * `load` returning `undefined` is not cached — `undefined` is how this API spells "not
 * here", and storing it would make a hit indistinguishable from a miss. Cache `null`.
 */
export function remember<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
  driver: CacheDriver = cache,
): Promise<T> {
  return (async () => {
    const hit = await driver.get<T>(key)
    if (hit !== undefined) return hit

    const pending = flights(driver)
    const existing = pending.get(key) as Promise<T> | undefined
    if (existing) return existing

    const flight = (async () => {
      const value = await load()
      if (value !== undefined) await driver.set(key, value, ttlMs)
      return value
    })().finally(() => pending.delete(key))

    pending.set(key, flight)
    return flight
  })()
}

/** Drop one entry. Call it from `defer`, after the commit — never before it. */
export function forget(key: string, driver: CacheDriver = cache): Promise<void> {
  return driver.delete(key)
}

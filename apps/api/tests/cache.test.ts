import { like } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { remember, type CacheDriver } from '#cache/cache'
import { deleteExpiredCacheEntries, writeCacheEntry } from '#cache/cache.repo'
import { createDatabaseCache } from '#cache/driver/database'
import { createMemoryCache } from '#cache/driver/memory'
import { closeDatabase, db } from '#db/client'
import { cacheEntries } from '#db/schema'

/**
 * The cache, one suite run against **both** drivers that can be run here.
 *
 * Table-driven on purpose. The whole promise of this subsystem is that swapping
 * `CACHE_DRIVER` changes where an entry lives and nothing else, and the only way to keep
 * that promise honest is to make one set of assertions answer for every driver — otherwise
 * "works on memory" is exactly the shape the first bug takes.
 *
 * `redis` is absent for the reason the redis queue suite exists separately: it needs a
 * server, and a suite that quietly skips when its dependency is missing is worse than one
 * that fails. It is covered by `queue.redis.test.ts`'s sibling work in the driver itself.
 *
 * Both drivers are constructed **directly**, with their own prefix — `env` is parsed once
 * and frozen at boot, so a test cannot flip `CACHE_DRIVER`, and a shared prefix would let
 * one case's entries be found by the next.
 */

const PREFIX = 'cachetest:'

const DRIVERS: readonly { name: string; make: () => CacheDriver }[] = [
  { name: 'memory', make: () => createMemoryCache({ prefix: PREFIX, maxEntries: 100 }) },
  { name: 'database', make: () => createDatabaseCache({ prefix: PREFIX, database: db }) },
]

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function cleanRows(): Promise<void> {
  await db.delete(cacheEntries).where(like(cacheEntries.key, `${PREFIX}%`))
}

beforeAll(cleanRows)
afterAll(async () => {
  await cleanRows()
  await closeDatabase()
})

describe.each(DRIVERS)('the $name cache driver', ({ make }) => {
  let cache: CacheDriver

  beforeAll(() => {
    cache = make()
  })

  afterEach(async () => {
    await cache.clear()
  })

  it('gives back what was put in, and undefined for what was not', async () => {
    await cache.set('greeting', { hello: 'world' }, 60_000)

    expect(await cache.get('greeting')).toEqual({ hello: 'world' })
    expect(await cache.get('nothing-here')).toBeUndefined()
  })

  it('keeps a cached null apart from a missing key', async () => {
    // The distinction the `{ v: … }` wrapper in `db/schema/cache.ts` exists for. Without it
    // "this user has no roles" and "nobody has asked yet" would be the same answer.
    await cache.set('nullable', null, 60_000)

    expect(await cache.get('nullable')).toBeNull()
    expect(await cache.get('absent')).toBeUndefined()
  })

  it('stores a value as JSON, so every driver hands back the same shape', async () => {
    const when = new Date('2026-01-01T00:00:00.000Z')
    await cache.set('dated', { when }, 60_000)

    // A `Date` in is a string out — from memory as well, which is the point. A driver that
    // kept the object would pass here and fail the day somebody set CACHE_DRIVER=redis.
    expect(await cache.get('dated')).toEqual({ when: '2026-01-01T00:00:00.000Z' })
  })

  it('does not hand back a reference the caller can mutate', async () => {
    const value = { items: ['a'] }
    await cache.set('mutable', value, 60_000)
    value.items.push('b')

    expect(await cache.get<typeof value>('mutable')).toEqual({ items: ['a'] })
  })

  it('refuses to store undefined rather than storing a permanent miss', async () => {
    await expect(cache.set('void', undefined, 60_000)).rejects.toThrow(/undefined/)
  })

  it('stops answering once the ttl has passed', async () => {
    await cache.set('brief', 'here', 30)
    expect(await cache.get('brief')).toBe('here')

    await sleep(60)
    expect(await cache.get('brief')).toBeUndefined()
  })

  it('deletes one key without touching its neighbours', async () => {
    await cache.set('keep', 1, 60_000)
    await cache.set('drop', 2, 60_000)

    await cache.delete('drop')

    expect(await cache.get('keep')).toBe(1)
    expect(await cache.get('drop')).toBeUndefined()
  })

  it('deletes a whole prefix and says how many went', async () => {
    await cache.set('access:one', 1, 60_000)
    await cache.set('access:two', 2, 60_000)
    await cache.set('other:three', 3, 60_000)

    expect(await cache.deletePrefix('access:')).toBe(2)
    expect(await cache.get('access:one')).toBeUndefined()
    expect(await cache.get('other:three')).toBe(3)
  })

  it('treats an underscore in a prefix as a character, not a wildcard', async () => {
    // `_` matches any single character in `LIKE`, and the database driver builds one from
    // application data. Unescaped, this call would take `axb:` with it — a 200 with the
    // wrong cache, which is the hardest kind of wrong to notice.
    await cache.set('a_b:one', 1, 60_000)
    await cache.set('axb:two', 2, 60_000)

    expect(await cache.deletePrefix('a_b:')).toBe(1)
    expect(await cache.get('axb:two')).toBe(2)
  })

  it('clears everything under its own prefix', async () => {
    await cache.set('one', 1, 60_000)
    await cache.set('two', 2, 60_000)

    await cache.clear()

    expect(await cache.get('one')).toBeUndefined()
    expect(await cache.get('two')).toBeUndefined()
  })

  describe('remember', () => {
    it('calls the loader once and serves the rest from the entry', async () => {
      let calls = 0
      const load = (): Promise<number> => {
        calls += 1
        return Promise.resolve(calls)
      }

      expect(await remember('counted', 60_000, load, cache)).toBe(1)
      expect(await remember('counted', 60_000, load, cache)).toBe(1)
      expect(calls).toBe(1)
    })

    it('runs one load for fifty concurrent callers', async () => {
      let calls = 0
      const load = async (): Promise<string> => {
        calls += 1
        await sleep(20)
        return 'loaded'
      }

      const answers = await Promise.all(
        Array.from({ length: 50 }, () => remember('stampede', 60_000, load, cache)),
      )

      // The single-flight map. Without it this is fifty of whatever the loader does — and
      // the loader is expensive by definition, or nobody would be caching it.
      expect(calls).toBe(1)
      expect(new Set(answers)).toEqual(new Set(['loaded']))
    })

    it('caches nothing when the loader throws, and lets the next caller try again', async () => {
      let calls = 0
      const load = (): Promise<string> => {
        calls += 1
        return calls === 1 ? Promise.reject(new Error('nope')) : Promise.resolve('second time')
      }

      await expect(remember('flaky', 60_000, load, cache)).rejects.toThrow('nope')
      expect(await remember('flaky', 60_000, load, cache)).toBe('second time')
    })
  })
})

describe('the database driver specifically', () => {
  const cache = createDatabaseCache({ prefix: PREFIX, database: db })

  afterEach(cleanRows)

  it('never serves an expired row, even before the sweep has run', async () => {
    // Written straight through the repo with an expiry in the past, which is the state a
    // sweep that has been down for a week leaves behind. The filter is in SQL, so the row
    // is unreachable while it sits there.
    await writeCacheEntry(db, {
      key: `${PREFIX}stale`,
      value: { v: 'from last week' },
      expiresAt: new Date(Date.now() - 1000),
    })

    expect(await cache.get('stale')).toBeUndefined()

    const rows = await db
      .select()
      .from(cacheEntries)
      .where(like(cacheEntries.key, `${PREFIX}%`))
    expect(rows).toHaveLength(1)
  })

  it('sweeps the expired rows and leaves the live ones', async () => {
    await writeCacheEntry(db, {
      key: `${PREFIX}gone`,
      value: { v: 1 },
      expiresAt: new Date(Date.now() - 1000),
    })
    await cache.set('alive', 2, 60_000)

    expect(await deleteExpiredCacheEntries(db)).toBeGreaterThanOrEqual(1)
    expect(await cache.get('alive')).toBe(2)

    const rows = await db
      .select()
      .from(cacheEntries)
      .where(like(cacheEntries.key, `${PREFIX}%`))
    expect(rows.map((row) => row.key)).toEqual([`${PREFIX}alive`])
  })

  it('replaces an entry rather than writing a second row for the key', async () => {
    await cache.set('same', 'first', 60_000)
    await cache.set('same', 'second', 60_000)

    expect(await cache.get('same')).toBe('second')
    const rows = await db
      .select()
      .from(cacheEntries)
      .where(like(cacheEntries.key, `${PREFIX}same`))
    expect(rows).toHaveLength(1)
  })
})

describe('the memory driver specifically', () => {
  it('evicts the entry written longest ago once the cap is reached', async () => {
    const cache = createMemoryCache({ prefix: PREFIX, maxEntries: 2 })

    await cache.set('first', 1, 60_000)
    await cache.set('second', 2, 60_000)
    // Rewriting `first` moves it to the back, so `second` is now the oldest write.
    await cache.set('first', 11, 60_000)
    await cache.set('third', 3, 60_000)

    expect(await cache.get('second')).toBeUndefined()
    expect(await cache.get('first')).toBe(11)
    expect(await cache.get('third')).toBe(3)
  })

  it('writes no row, whatever else is configured', async () => {
    const cache = createMemoryCache({ prefix: PREFIX })
    await cache.set('in-process', 'only', 60_000)

    const rows = await db
      .select()
      .from(cacheEntries)
      .where(like(cacheEntries.key, `${PREFIX}%`))
    expect(rows).toHaveLength(0)
  })
})

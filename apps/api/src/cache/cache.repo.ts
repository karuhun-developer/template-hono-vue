import { and, eq, gt, like, lte, sql } from 'drizzle-orm'

import type { Database } from '#db/client'
import { cacheEntries } from '#db/schema'
import { escapeLike } from '#lib/query'

/**
 * Every read and write of `cache_entries`.
 *
 * The one thing to keep straight while reading this file: **expiry is enforced in SQL, on
 * the read**. `readCacheEntry` filters on `expires_at > now()`, so an expired row can never
 * be served no matter how long the sweep has been down. That is what makes `cache.sweep`
 * hygiene rather than correctness — the same split as `purgeExpiredInvites`, and worth
 * saying out loud, because the day the sweep stops running nothing breaks, which is exactly
 * why nobody would notice.
 *
 * `now()` is the database's clock, deliberately. Every replica writing here already agrees
 * on it, whereas `new Date()` would make an entry's lifetime depend on which container
 * happened to read it.
 */

/** The stored shape. See `db/schema/cache.ts` for why the value is wrapped. */
type Wrapped = { v: unknown }

export async function readCacheEntry(database: Database, key: string): Promise<Wrapped | null> {
  const [row] = await database
    .select({ value: cacheEntries.value })
    .from(cacheEntries)
    .where(and(eq(cacheEntries.key, key), gt(cacheEntries.expiresAt, sql`now()`)))
    .limit(1)

  return row?.value ?? null
}

/**
 * Write, or replace what is there.
 *
 * `ON CONFLICT (key) DO UPDATE` rather than delete-then-insert: two requests racing to fill
 * the same cold key would otherwise be able to interleave into a row that has a value from
 * one and an expiry from the other.
 */
export async function writeCacheEntry(
  database: Database,
  entry: { key: string; value: Wrapped; expiresAt: Date },
): Promise<void> {
  await database
    .insert(cacheEntries)
    .values(entry)
    .onConflictDoUpdate({
      target: cacheEntries.key,
      set: { value: entry.value, expiresAt: entry.expiresAt },
    })
}

export async function deleteCacheEntry(database: Database, key: string): Promise<void> {
  await database.delete(cacheEntries).where(eq(cacheEntries.key, key))
}

/**
 * Invalidation by prefix.
 *
 * `escapeLike` matters more here than in a search box: a prefix is built from application
 * data — `access:` plus a user id today, something with a `_` in it tomorrow — and an
 * unescaped `_` matches any single character, so `deletePrefix('a_b:')` would quietly take
 * `axb:` with it.
 */
export async function deleteCacheEntriesWithPrefix(
  database: Database,
  prefix: string,
): Promise<number> {
  const deleted = await database
    .delete(cacheEntries)
    .where(like(cacheEntries.key, `${escapeLike(prefix)}%`))
    .returning({ key: cacheEntries.key })

  return deleted.length
}

/**
 * Retention, and the only thing `cache.sweep` does.
 *
 * Not `TRUNCATE` and not a prefix: an expired row belongs to nobody, so a sweep that ran
 * for one installation on a shared database has done the other one a favour.
 */
export async function deleteExpiredCacheEntries(database: Database): Promise<number> {
  const deleted = await database
    .delete(cacheEntries)
    .where(lte(cacheEntries.expiresAt, sql`now()`))
    .returning({ key: cacheEntries.key })

  return deleted.length
}

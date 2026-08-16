import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'

import { timestamptz } from '#db/columns'

/**
 * The `database` cache driver's storage.
 *
 * Only that driver reads this table. `CACHE_DRIVER=memory` — the default — never touches
 * it, and `redis` keeps its entries in Redis, so an empty `cache_entries` is the normal
 * state of most installations rather than a sign that nothing is caching.
 *
 * **No `...timestamps()`**, which is the one deliberate departure from every other table
 * here. An entry is written, replaced wholesale, or deleted; it is never edited, so an
 * `updated_at` would say exactly what `expires_at` already says, one TTL earlier. What a
 * cache row needs to know about time is when it stops being true.
 */

export const cacheEntries = pgTable(
  'cache_entries',
  {
    /**
     * The natural key, exactly like `permissions.key`: the string the caller asked for,
     * `CACHE_PREFIX` included. A surrogate id would buy a second lookup on every `get`.
     */
    key: text('key').primaryKey(),

    /**
     * Whatever was cached, as JSON, **wrapped in `{ "v": … }`**.
     *
     * `jsonb` rather than `text` so an entry is readable in `psql` when somebody is working
     * out why a stale value is being served — which is the only reason anybody ever opens
     * this table. The wrapper is what makes a cached `null` storable: unwrapped, it would
     * reach the driver as a SQL `NULL` and be rejected by `notNull`, so "this key holds
     * null" and "this key holds nothing" would be the same row.
     */
    value: jsonb('value').$type<{ v: unknown }>().notNull(),

    /**
     * When the entry stops being true.
     *
     * Every read filters on this **in SQL**, so an expired row can never be served no
     * matter how long the sweep has been down. That makes `cache.sweep` hygiene rather than
     * correctness — the same split as `purgeExpiredInvites`, and worth keeping straight for
     * the same reason: the day it stops running, nothing breaks, which is precisely why
     * nobody would notice.
     */
    expiresAt: timestamptz('expires_at').notNull(),
  },
  (table) => [
    /** What the sweep scans, and nothing else. A read goes straight at the primary key. */
    index('cache_entries_expires_at_idx').on(table.expiresAt),
  ],
)

export type CacheEntry = typeof cacheEntries.$inferSelect
export type NewCacheEntry = typeof cacheEntries.$inferInsert

# Cache

Three drivers behind one setting, one method most call sites need, and a default that caches nothing anywhere.

| Concern                      | File                                                   |
| ---------------------------- | ------------------------------------------------------ |
| The interface and `remember` | `apps/api/src/cache/cache.ts`                          |
| Drivers                      | `apps/api/src/cache/driver/{memory,database,redis}.ts` |
| Row access                   | `apps/api/src/cache/cache.repo.ts`                     |
| Serialisation                | `apps/api/src/cache/driver/shared.ts`                  |
| The `cache_entries` table    | `apps/api/src/db/schema/cache.ts`                      |
| The sweep                    | `apps/api/src/queue/jobs/cleanup.ts`                   |

## The API

```ts
const roles = await remember(`roles:${userId}`, 30_000, () => loadRoles(userId))
```

`remember(key, ttlMs, load)` is the whole thing. It reads, and on a miss it runs the loader, stores what came back and hands it to you. `cache.get` / `set` / `delete` / `deletePrefix` / `clear` are there underneath for the cases that genuinely need them — invalidation, mostly.

**Invalidate through `defer`, after the commit.** Dropping an entry inside the transaction that changed the row means something can re-read the old value and cache it again in the window before the commit, at which point the cache is wrong and nothing will correct it until the TTL. That is what `transaction(async (tx, defer) => …)` is for, and it is the same rule the queue follows for the same reason.

## Single flight

A cold key hit by fifty concurrent requests runs the loader **once**.

That is not an optimisation, it is the point: a value is cached because computing it is expensive, so the moment it expires under load is exactly the moment fifty processes decide to compute it at the same time. `remember` keeps a process-local map of the loads in flight; the first caller starts one and the other forty-nine wait on the same promise. Same trick as `bootstrap()` in the console's session store.

The map de-duplicates the **loads**, not the lookups — every caller still asks the driver, which is the cheap half. A loader that throws rejects everyone waiting and caches nothing, so the next request tries again rather than inheriting a failure for a whole TTL.

## The drivers

| Driver     | Shared across replicas | Expiry                | Needs                      |
| ---------- | ---------------------- | --------------------- | -------------------------- |
| `memory`   | **No**                 | Lazily, on read       | Nothing                    |
| `database` | Yes                    | In SQL, on every read | The Postgres already there |
| `redis`    | Yes                    | Redis, through `PX`   | `REDIS_URL`                |

> **`memory` is correct for one process only.** Nothing is shared, so an entry written by one replica is invisible to the other — and, the part that actually bites, an entry **invalidated** on one replica stays served by the other until its TTL runs out. It is the default because it needs nothing and because nothing in this template caches anything by default. The moment you cache something that must be revocable, this is the setting to think about first.

`database` is the one most installations should reach for: a second replica is a much smaller decision than a second piece of infrastructure. The cost is honest — a miss still costs a round trip to Postgres, so it is worth it for a value that is expensive to compute, not for one that is merely awkward to reach.

`redis` reuses the `ioredis` that BullMQ already brought in for the queue driver, so it adds **no new dependency**. It does not reuse the connection: a cache `GET` queued behind a worker's blocking `BZPOPMIN` would wait for it, and the two need opposite settings for `maxRetriesPerRequest` anyway.

## A value is JSON, in every driver

`set` serialises, `get` parses — in the memory driver too, where it would have been free to keep the object.

```ts
await cache.set('k', { when: new Date() }, 60_000)
await cache.get('k') // { when: '2026-01-01T00:00:00.000Z' } — from every driver
```

Free, and wrong. A `Date` that survived `memory` and arrived as a string from `redis` is a difference between a test run and production, and it is the same class of bug as a job payload — see the note at the top of `queue/registry.ts`. The round trip also means a caller who kept a reference to what they cached cannot mutate what the next reader sees.

`undefined` is not storable. `undefined` is how `get` spells "not here", so an entry holding it would be a permanent miss occupying a key; `set` throws instead, naming the rule. Cache `null` — which **is** storable, and which the `database` driver keeps apart from a missing row by wrapping every value in `{ "v": … }`.

## Keys and prefixes

Every key is namespaced with `CACHE_PREFIX` (default `app:`) inside the driver. Two installations sharing one Redis or one database do not read each other's entries, and `clear()` empties what this installation put there rather than everything in the store — it is a `SCAN` + `UNLINK` on redis and a prefixed `DELETE` on Postgres, never `FLUSHDB` and never `TRUNCATE`.

`deletePrefix` is the only grouping mechanism, and there is deliberately **no tag support**. A tag index is a second structure to keep correct inside every driver, and it is where "the cache is wrong" usually comes from. When a group genuinely has to be invalidated and a prefix will not describe it, the answer is an explicit fan-out written at the call site, where it can be read.

It escapes what it is given, in both matchers: `_` and `%` are wildcards to `LIKE`, `*` and `?` are wildcards to `SCAN MATCH`. Neither is an injection — the value is still a bound parameter — which is exactly why an unescaped one goes unnoticed, right up until `deletePrefix('a_b:')` quietly takes `axb:` with it.

## Expiry, and what the sweep is for

The `database` driver filters `expires_at > now()` **in the read itself**. An expired row is therefore unreachable the instant it expires, whether or not anything has deleted it.

Which makes `cache.sweep` — the `*/10 * * * *` schedule — **hygiene, not correctness**. It stops the table growing; it does not stop a stale value being served, because nothing could. That distinction is worth keeping straight for the same reason it is in `purgeExpiredInvites`: the day it stops running, nothing breaks, which is precisely why nobody would notice.

It is a no-op under `memory` (which expires lazily in the process) and under `redis` (which expires entries itself), because neither writes a row for it to find.

`memory` has one extra rule, `CACHE_MAX_ENTRIES`: past the cap it evicts the entry written longest ago. A `Map` with no ceiling is a memory leak wearing a cache's clothes — slow, invisible, and fatal on the one process that happens to see unusual traffic.

## Settings

| Variable            | Default  | Means                                                   |
| ------------------- | -------- | ------------------------------------------------------- |
| `CACHE_DRIVER`      | `memory` | `memory` · `database` · `redis`                         |
| `CACHE_PREFIX`      | `app:`   | In front of every key this installation writes          |
| `CACHE_MAX_ENTRIES` | `10000`  | The ceiling on the memory driver; ignored by the others |

`REDIS_URL` is required when `CACHE_DRIVER=redis`, and the API refuses to boot without it — the same cross-field rule the queue has, and for the same reason: the alternative is a failure at the first cache read, which is a request, in production, at the worst moment.

## Testing

`cache.test.ts` runs **one** set of assertions against both the memory and the database driver, through `describe.each`. That is the only way the promise of this subsystem — that swapping the driver changes where an entry lives and nothing else — stays true, because "works on memory" is exactly the shape the first bug takes.

Every driver ships a **factory beside the singleton** (`createMemoryCache`, `createDatabaseCache`, `createRedisCache`), because `env` is parsed once and frozen at boot: a test cannot flip `CACHE_DRIVER`. `remember` takes its driver as a last argument defaulting to the singleton, for the same reason.

## Conventions

- Cache what is expensive to compute, not what is awkward to reach.
- Invalidate through `defer`, after the commit. Never inside the transaction.
- A key is namespaced by the driver. Do not build `CACHE_PREFIX` into a key by hand.
- Values are JSON. A `Date` in is a string out — put an ISO string or an id in the value, and do not be surprised by it.
- `deletePrefix` and `clear` are invalidation. They are O(n), and they never belong on a request path.

# Add multi-tenancy

The template is **single-tenant**: one installation, one organisation, one flat set of permissions. The reasoning is in [ADR-0003](../decisions/ADR-0003-single-tenant-core.md) — the short version is that adding tenancy later is a known, mechanical path, while removing it is a rewrite.

This guide is that path, complete. It includes the full source of the two files the template deliberately does not ship, because the recipe is only useful if it is copy-pasteable.

> **The code below is not compiled by this repository, so it can rot.** It was extracted from a production application running **`drizzle-orm` 0.44** — the same version this template pins. It leans on Drizzle internals (`getTableColumns`, builders that return `this`), so if your Drizzle is much newer, read the annotations rather than the source: each one says _why_ a line is written that way, which is what you need in order to adapt it.

**Read [What this costs you](#what-this-costs-you) before step 1.** Multi-tenancy is not a feature you add on a Tuesday afternoon; it changes what every query in the application means.

## The shape of the decision

There are three ways to isolate tenants, and this guide takes the third:

| Approach               | Isolation                          | Cost                                                                                       |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------ |
| Database per tenant    | Strongest                          | Migrations × N, connection pools × N, no cross-tenant query at all                         |
| Schema per tenant      | Strong                             | `search_path` juggling, awkward migrations, Postgres struggles past a few thousand schemas |
| **`tenant_id` column** | **Only as strong as your queries** | **One database, one migration — and one forgotten `WHERE` is a breach**                    |

The last row is the reason for everything below. If isolation depends on remembering a `WHERE` clause, it will fail — not today, but on the day somebody adds a query at 18:40 on a Friday. So it must not depend on remembering: the filter goes **into the query builder**, before any handler touches it.

## 1. The tenants table

`apps/api/src/db/schema/tenancy.ts`:

```ts
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'

import { primaryId, timestamps, timestamptz } from '#db/columns'

export const tenants = pgTable(
  'tenants',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    deletedAt: timestamptz('deleted_at'),
    ...timestamps(),
  },
  (table) => [uniqueIndex('tenants_slug_key').on(table.slug)],
)
```

Export it from `apps/api/src/db/schema.ts`, or it will never be migrated.

## 2. `tenant_id` on every table that holds customer data

```ts
export const users = pgTable(
  'users',
  {
    id: primaryId(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    // ...
  },
  (table) => [
    // The uniqueness rules become per-tenant. This is the change people forget, and it
    // is the one that decides whether the same person can exist in two organisations.
    uniqueIndex('users_email_key').on(table.tenantId, sql`lower(${table.email})`),
    index('users_tenant_idx').on(table.tenantId),
  ],
)
```

Which tables get the column:

| Table                                                                        | `tenant_id`?                                   |
| ---------------------------------------------------------------------------- | ---------------------------------------------- |
| `users`, `sessions`, `roles`, `role_permissions`, `user_roles`, `audit_logs` | **yes**                                        |
| `permissions`                                                                | no — system vocabulary, identical for everyone |
| `tenants`                                                                    | no — it is filtered by its own `id`            |
| `__drizzle_migrations`                                                       | no                                             |

> **Every unique index that is not already tenant-scoped is a bug.** `lower(email)` unique across the whole table means one person can never belong to two organisations. Decide that deliberately, per index, rather than discovering it in production.

Then `make generate name=add_tenancy` and read the SQL. Backfilling an existing database means creating a tenant row, setting `tenant_id` on every row, and only then adding the `NOT NULL` — three statements in the migration, in that order.

## 3. `apps/api/src/db/tenant-scope.ts`

Pure decisions: which column filters a table, and what happens when it cannot be answered. No I/O, so every rule can be unit-tested without a database.

```ts
import {
  eq,
  getTableColumns,
  getTableName,
  sql,
  type Column,
  type SQL,
  type Table,
} from 'drizzle-orm'

/**
 * How a table is filtered for one tenant.
 *
 * The rule is deliberately **fail-closed**: a table that is not recognised is not treated
 * as safe, it is locked to `1 = 0`. The most expensive failure mode in a multi-tenant
 * system is not "the query errored" — it is "the query succeeded and returned another
 * customer's data". A new table that forgets `tenant_id` returns zero rows, which is
 * noticed immediately in development and never leaks if it is missed.
 */

/**
 * Tables without `tenant_id` that are genuinely **shared**, so they may be read as they
 * are. The list is short and hand-written on purpose: adding a line here is a deliberate
 * decision, not a side effect of creating a table.
 */
const GLOBAL_TABLES: ReadonlySet<string> = new Set([
  // System vocabulary, not customer data. Identical for every tenant.
  'permissions',
  // Drizzle's bookkeeping; application code never touches it.
  '__drizzle_migrations',
])

/** `tenants` is filtered by its own `id`, not by a `tenant_id` column. */
const TENANT_ROOT_TABLE = 'tenants'

export type TenantScope =
  /** There is a filtering column and there is a tenant context. */
  | { kind: 'scoped'; predicate: SQL }
  /** A shared table — nothing to filter. */
  | { kind: 'global' }
  /** Cannot be filtered safely ⇒ zero rows. `reason` is for logs and error messages. */
  | { kind: 'denied'; predicate: SQL; reason: string }

/**
 * A table's real `tenant_id` column, or `null` if it has none.
 *
 * Different from `tenantScopeFor`: `tenants` has no such column — it is filtered by `id` —
 * and that distinction matters for INSERT. Stamping a new tenant's `id` with the id of the
 * tenant currently signed in is plainly not what anyone means.
 */
export function tenantColumnOf(table: Table): Column | null {
  if (getTableName(table) === TENANT_ROOT_TABLE) return null
  const columns: Record<string, Column> = getTableColumns(table)
  return columns.tenantId ?? null
}

export function tenantScopeFor(table: Table, tenantId: string | null | undefined): TenantScope {
  const name = getTableName(table)
  if (GLOBAL_TABLES.has(name)) return { kind: 'global' }

  const columns: Record<string, Column> = getTableColumns(table)
  const column = name === TENANT_ROOT_TABLE ? columns.id : columns.tenantId

  if (!column) {
    return {
      kind: 'denied',
      predicate: denyAll(),
      reason: `table "${name}" has no tenant_id column and is not listed as a global table`,
    }
  }

  if (!tenantId) {
    return { kind: 'denied', predicate: denyAll(), reason: 'no tenant context' }
  }

  return { kind: 'scoped', predicate: eq(column, tenantId) }
}

/**
 * Built fresh on every call rather than shared as a constant: a `SQL` object becomes part
 * of the query tree that uses it, and sharing one instance between queries leaves a trail
 * of bugs that never needed to exist.
 */
function denyAll(): SQL {
  return sql`1 = 0`
}
```

## 4. `apps/api/src/db/tenant-db.ts`

The mechanics. `tenantDb(ctx)` returns a Drizzle surface that injects `tenant_id = ?` into every SELECT / UPDATE / DELETE, stamps every INSERT, and refuses anything it cannot prove safe.

```ts
import { and, getTableName, is, type SQL, type Table } from 'drizzle-orm'
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres'
import {
  PgTable,
  type PgInsertBase,
  type PgTransactionConfig,
  type PgUpdateBase,
  type PgUpdateSetSource,
} from 'drizzle-orm/pg-core'

import { db, type Database } from '#db/client'
import { tenantColumnOf, tenantScopeFor } from '#db/tenant-scope'

/**
 * **Structural** tenant isolation: not something the author of a query remembers, but
 * something already attached to the query builder before a handler touches it.
 *
 * With no tenant context, what gets injected is `1 = 0` — **zero rows, not all rows**. A
 * wrong default must produce emptiness, never a leak.
 *
 * What is deliberately not supported, and why:
 *
 * - **No `.query` (the relational API).** `db.query.users.findMany({ with: … })` builds
 *   nested subqueries that cannot be given an outside predicate with the same guarantee.
 *   Rather than offering it half-safe, it is removed from the type and throws on access.
 * - **No `.execute()` / CTEs.** Raw SQL has no analysable shape.
 * - **JOINs are filtered in the `ON` clause, not `WHERE`.** For a `LEFT JOIN`, putting it
 *   in `WHERE` silently turns it into an `INNER JOIN` and drops legitimate left rows.
 *
 * Anything that genuinely has to cross tenants uses `unscopedDb()`, and that is **fenced
 * by ESLint** to `src/platform/**` and `src/jobs/**` — deliberately greppable,
 * deliberately inconvenient.
 */

export type TenantContext = {
  tenantId: string
}

/**
 * An INSERT without `tenant_id` — the column is filled by the proxy, not by the caller.
 *
 * Optional rather than forbidden outright so that rows built by other helpers (which
 * happen to carry `tenantId` already) still fit; the value is checked at runtime anyway.
 *
 * Based on `T['$inferInsert']` and **not** `PgInsertValue<T>`, and the difference is not
 * stylistic: `Omit` works through `keyof`, and `keyof PgInsertValue<T>` only yields the
 * required columns — the optional ones are silently discarded.
 */
export type TenantInsertValue<T extends PgTable> = Omit<T['$inferInsert'], 'tenantId'> & {
  tenantId?: string
}

export type TenantInsertBuilder<T extends PgTable> = {
  values(value: TenantInsertValue<T>): PgInsertBase<T, NodePgQueryResultHKT>
  values(values: TenantInsertValue<T>[]): PgInsertBase<T, NodePgQueryResultHKT>
}

export type TenantUpdateBuilder<T extends PgTable> = {
  set(values: Omit<PgUpdateSetSource<T>, 'tenantId'>): PgUpdateBase<T, NodePgQueryResultHKT>
}

/**
 * The Drizzle surface that is safe to use from a handler.
 *
 * What is removed is not merely unimplemented — its absence **from the type** is what
 * makes a use of it visible during `pnpm typecheck` rather than in production. `insert`
 * and `update` are retyped so that `tenant_id` **cannot** be written by hand: its only
 * source is the context the proxy holds.
 */
export type TenantDatabase = Omit<
  Database,
  | 'query'
  | 'execute'
  | 'with'
  | '$with'
  | 'refreshMaterializedView'
  | '_'
  | '$client'
  | 'insert'
  | 'update'
  | 'transaction'
> & {
  insert<T extends PgTable>(table: T): TenantInsertBuilder<T>
  update<T extends PgTable>(table: T): TenantUpdateBuilder<T>
  transaction<R>(fn: (tx: TenantDatabase) => Promise<R>, config?: PgTransactionConfig): Promise<R>
}

/** Reached through the proxy ⇒ throws. The runtime counterpart of the `Omit` above. */
const BLOCKED_MEMBERS: Record<string, string> = {
  query: 'the relational API (.query) cannot be guaranteed scoped. Use .select().from(…).',
  execute: 'raw SQL cannot be scoped. Use unscopedDb() from src/platform/**.',
  with: 'CTEs cannot be scoped. Use unscopedDb() from src/platform/**.',
  $with: 'CTEs cannot be scoped. Use unscopedDb() from src/platform/**.',
  refreshMaterializedView: 'not a per-tenant operation. Use unscopedDb() from src/jobs/**.',
}

export function tenantDb(ctx: TenantContext): TenantDatabase {
  return scopeDatabase(db, ctx.tenantId)
}

/**
 * Cross-tenant access, with no filter of any kind.
 *
 * **Only from `src/platform/**` and `src/jobs/**`** — ESLint refuses this import anywhere
 * else. If you feel you need it in a handler, what you actually need is `tenantDb(ctx)`.
 */
export function unscopedDb(): Database {
  return db
}

// --- The engine -------------------------------------------------------------

type Fn = (...args: unknown[]) => unknown
type Mutable = Record<string, unknown>

/** Methods that materialise a query. The predicate must be attached before they run. */
const TERMINALS = ['then', 'execute', 'prepare', 'toSQL', 'getSQL', 'as'] as const

/** Every Drizzle join takes `(table, on)` — including `LEFT` / `RIGHT` / `FULL`. */
const JOINS = ['innerJoin', 'leftJoin', 'rightJoin', 'fullJoin'] as const

/**
 * Wrap Drizzle (or a transaction) for one tenant.
 *
 * `tenantId` may be empty, and that is precisely the path that has to be right. A session
 * that never loaded, a middleware that failed, a job that forgot to pass its context —
 * all of them end at `1 = 0`.
 */
export function scopeDatabase(
  database: Database,
  tenantId: string | null | undefined,
): TenantDatabase {
  const scoped: Mutable = {
    select: (fields?: unknown) => scopeSelectBuilder(database.select(fields as never), tenantId),
    selectDistinct: (fields?: unknown) =>
      scopeSelectBuilder(database.selectDistinct(fields as never), tenantId),

    insert: (table: Table) => scopeInsert(database.insert(table as never), table, tenantId),
    update: (table: Table) => scopeUpdate(database.update(table as never), table, tenantId),
    delete: (table: Table) => scopeQuery(database.delete(table as never), table, tenantId),

    $count: (source: Table, filter?: SQL) => {
      const scope = tenantScopeFor(source, tenantId)
      if (scope.kind === 'global') return database.$count(source as never, filter)
      return database.$count(source as never, mergeAnd(filter, scope.predicate))
    },

    transaction: (fn: (tx: TenantDatabase) => Promise<unknown>, config?: unknown) =>
      database.transaction(
        (tx) => fn(scopeDatabase(tx as unknown as Database, tenantId)),
        config as never,
      ),
  }

  for (const [member, message] of Object.entries(BLOCKED_MEMBERS)) {
    Object.defineProperty(scoped, member, {
      get: () => {
        throw new Error(`tenantDb: ${message}`)
      },
      configurable: true,
    })
  }

  return scoped as unknown as TenantDatabase
}

/**
 * Shadow one method with a wrapped version, **as an own property**.
 *
 * Not a `Proxy`. Drizzle's query builders return `this` from almost every method
 * (`.innerJoin()`, `.orderBy()`, `.limit()`), so an own property travels along the chain
 * by itself — whereas a `Proxy` is lost the moment a method returns the underlying target,
 * and everything after that point is unscoped with nothing visibly wrong.
 */
function shadow(target: object, key: string, wrap: (original: Fn) => Fn): void {
  const current: unknown = (target as Mutable)[key]
  if (typeof current !== 'function') return

  Object.defineProperty(target, key, {
    value: wrap((current as Fn).bind(target)),
    configurable: true,
    writable: true,
    enumerable: false,
  })
}

function mergeAnd(left: SQL | undefined, right: SQL): SQL {
  return left ? (and(left, right) as SQL) : right
}

/**
 * The predicate for a row source, or `null` when the table really is global.
 *
 * A source that is not a table (a subquery, a view, raw `sql`) **throws** rather than
 * being locked to `1 = 0`. The difference is intentional: an unknown table is an oversight
 * that must fail quietly towards safety, while a subquery is something somebody wrote on
 * purpose — and deserves a message explaining why it cannot work.
 */
function predicateFor(
  source: unknown,
  tenantId: string | null | undefined,
  op: string,
): SQL | null {
  if (!is(source, PgTable)) {
    throw new Error(
      `tenantDb: ${op} from a non-table source (subquery/view) cannot be scoped automatically. Build the query through tenantDb, or use unscopedDb() from src/platform/**.`,
    )
  }

  const scope = tenantScopeFor(source, tenantId)
  return scope.kind === 'global' ? null : scope.predicate
}

function scopeSelectBuilder<B extends object>(builder: B, tenantId: string | null | undefined): B {
  shadow(builder, 'from', (original) => (source: unknown) => {
    const query = original(source) as object
    const predicate = predicateFor(source, tenantId, 'SELECT')
    return predicate ? attachPredicate(query, predicate, tenantId) : query
  })
  return builder
}

function scopeQuery<Q extends object>(
  query: Q,
  table: Table,
  tenantId: string | null | undefined,
): Q {
  const scope = tenantScopeFor(table, tenantId)
  if (scope.kind === 'global') return query
  return attachPredicate(query, scope.predicate, tenantId)
}

/**
 * Attach the tenant predicate to a query that has a `.where()`.
 *
 * Two paths, because Drizzle's `.where()` **replaces** the previous clause instead of
 * combining with it:
 *
 * 1. The caller writes `.where(cond)` ⇒ we merge into `cond AND tenant`.
 * 2. The caller never writes `.where()` ⇒ the predicate is attached just before the query
 *    executes (`then` / `execute` / `toSQL` / …).
 */
function attachPredicate<Q extends object>(
  query: Q,
  predicate: SQL,
  tenantId: string | null | undefined,
): Q {
  const originalWhere = (query as Mutable).where
  if (typeof originalWhere !== 'function') return query

  const applyDirect = (originalWhere as Fn).bind(query)
  let applied = false

  shadow(query, 'where', () => (condition?: unknown) => {
    applied = true
    return applyDirect(condition ? mergeAnd(condition as SQL, predicate) : predicate)
  })

  for (const key of TERMINALS) {
    shadow(query, key, (original) => (...args: unknown[]) => {
      if (!applied) {
        applied = true
        applyDirect(predicate)
      }
      return original(...args)
    })
  }

  for (const key of JOINS) {
    shadow(query, key, (original) => (joined: unknown, on?: unknown) => {
      const joinPredicate = predicateFor(joined, tenantId, 'JOIN')
      if (!joinPredicate) return original(joined, on)
      return original(joined, mergeAnd(on as SQL | undefined, joinPredicate))
    })
  }

  return query
}

function scopeInsert<B extends object>(
  builder: B,
  table: Table,
  tenantId: string | null | undefined,
): B {
  shadow(builder, 'values', (original) => (rows: unknown) => {
    const list = Array.isArray(rows) ? (rows as Mutable[]) : [rows as Mutable]
    const stamped = list.map((row) => stampTenant(row, table, tenantId))
    return original(Array.isArray(rows) ? stamped : stamped[0])
  })

  shadow(builder, 'select', () => () => {
    throw new Error(
      'tenantDb: INSERT … SELECT cannot be stamped automatically. Use unscopedDb() from src/jobs/**.',
    )
  })

  return builder
}

/**
 * Stamp a row with the tenant currently in context.
 *
 * A `tenant_id` the caller supplied is not trusted — it is compared. A different value
 * almost always means an id that strayed in from a request, and writing it quietly into
 * another tenant is a leak that leaves no error behind at all.
 */
function stampTenant(row: Mutable, table: Table, tenantId: string | null | undefined): Mutable {
  const column = tenantColumnOf(table)
  if (!column) {
    throw new Error(
      `tenantDb: INSERT into "${getTableName(table)}", which has no tenant_id column, is not allowed. Use unscopedDb() from src/platform/**.`,
    )
  }
  if (!tenantId) {
    throw new Error('tenantDb: INSERT with no tenant context.')
  }

  const existing: unknown = row['tenantId']
  if (existing != null && existing !== tenantId) {
    throw new Error(
      `tenantDb: INSERT carries tenant_id ${JSON.stringify(existing)}, which differs from the active context.`,
    )
  }

  return { ...row, tenantId }
}

function scopeUpdate<B extends object>(
  builder: B,
  table: Table,
  tenantId: string | null | undefined,
): B {
  shadow(builder, 'set', (original) => (values: unknown) => {
    if (values != null && 'tenantId' in (values as Mutable)) {
      throw new Error(
        'tenantDb: moving a row to another tenant through UPDATE is not allowed. If that is genuinely the intent, do it from src/platform/** with unscopedDb().',
      )
    }
    return scopeQuery(original(values) as object, table, tenantId)
  })
  return builder
}
```

## 5. The ESLint fence

A safe door is worth nothing while an unlocked one stands beside it. Add this to `eslint.config.js`:

```js
// Bypassing tenant scope is allowed only from src/platform/** and src/jobs/**.
// Deliberately difficult, deliberately greppable.
//
// Two doors, not one. `unscopedDb()` is the door provided on purpose, but the raw `db`
// from `#db/client` is exactly as wide and does not announce itself — fencing only the
// first is pointless.
{
  files: ['apps/api/src/**/*.ts'],
  ignores: [
    'apps/api/src/platform/**',
    'apps/api/src/jobs/**',
    'apps/api/src/db/**',
    'apps/api/src/**/*.test.ts',
  ],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '#db/tenant-db',
            importNames: ['unscopedDb'],
            message:
              'unscopedDb() bypasses tenant isolation. Only from src/platform/** or src/jobs/**. Use tenantDb(ctx).',
          },
          {
            name: '#db/client',
            importNames: ['db'],
            message:
              'the raw db is not tenant-scoped. Use tenantDb(ctx); if you genuinely need cross-tenant access, unscopedDb() from src/platform/**.',
          },
        ],
      },
    ],
  },
},
```

This is the step people skip, and it is the one that decides whether the other four hold six months from now.

## 6. Resolve the tenant on every request

Add a `tenantId` to `AppVariables` in `middleware/request-context.ts`, and resolve it in `sessionContext()` — from the session row, which is where it belongs. **Never from a header or a request body**: a tenant id the client can choose is not an isolation boundary, it is a parameter.

```ts
export function currentTenant(c: Context<AppBindings>): TenantContext {
  const session = c.get('session')
  if (!session) throw new Error('currentTenant(): this route is missing requireAuth()')
  return { tenantId: session.tenantId }
}
```

If you also need a subdomain or path prefix (`acme.app.example.com`), use it to pick which sign-in page to show — and still take the authoritative id from the session afterwards.

## 7. Rewrite every repository

Every function that took a `DatabaseHandle` now takes a `TenantDatabase`:

```diff
-export async function listUsers(handle: DatabaseHandle = db, ...): Promise<UserWithRoles[]> {
-  return handle.select().from(users).where(isNull(users.deletedAt))
+export async function listUsers(handle: TenantDatabase, ...): Promise<UserWithRoles[]> {
+  return handle.select().from(users).where(isNull(users.deletedAt))
```

The query body is unchanged — that is the entire point. The predicate is attached by the builder.

`src/platform/` is the exception, and its contents move in both directions. `session.repo.ts` looks a session up **before** any tenant is known, so it stays on the raw `db` and its own queries carry the tenant explicitly. `auth.repo.ts` and `invite.repo.ts` need the same treatment.

## 8. Two-dimensional RBAC

This is the part that is more than mechanical, and it changes `AccessContext`:

```ts
export type AccessContext = {
  userId: string
  tenantId: string
  permissions: ReadonlySet<PermissionKey>
}
```

If a user belongs to exactly one tenant, that is all it takes: `user_roles` gains a `tenant_id`, `loadAccess(userId, tenantId)` filters by it, and nothing else changes.

If a user can belong to **several** tenants, the flat set is no longer sufficient:

```ts
export type AccessContext = {
  userId: string
  /** The tenant being acted in right now. */
  tenantId: string
  /** Permissions per tenant. `can()` reads the active one. */
  byTenant: ReadonlyMap<string, ReadonlySet<PermissionKey>>
}

export function can(access: AccessContext, permission: PermissionKey): boolean {
  return access.byTenant.get(access.tenantId)?.has(permission) ?? false
}
```

Then, in order:

- `requirePermission()` keeps its signature and asks about the **active** tenant. Nothing on any route changes.
- Add `requireTenant()`, which turns away a request whose session has no tenant. Mount it beside `requireAuth()`.
- `GET /auth/me` answers with the permissions of the active tenant, plus the list of tenants the user may switch to.
- The console gains a tenant switcher, and every page reloads when it changes.
- `assertGrantable` and the removal check in `roles.service.ts` compare against the **active tenant's** permissions. Getting this wrong is a cross-tenant privilege escalation, so it deserves its own test.

## 9. The test that matters

One test justifies the entire mechanism. Write it before you trust any of the above:

```ts
it('never returns another tenant\'s rows', async () => {
  const acme = await createTenant('acme')
  const globex = await createTenant('globex')

  await tenantDb({ tenantId: acme.id }).insert(users).values({ email: 'a@acme.test', name: 'A' })
  await tenantDb({ tenantId: globex.id }).insert(users).values({ email: 'b@globex.test', name: 'B' })

  const rows = await tenantDb({ tenantId: acme.id }).select().from(users)

  expect(rows).toHaveLength(1)
  expect(rows[0]!.email).toBe('a@acme.test')
})

it('returns nothing at all without a tenant context', async () => {
  const rows = await scopeDatabase(db, null).select().from(users)
  expect(rows).toHaveLength(0) // 1 = 0, not "everything"
})

it('refuses to write a row into another tenant', async () => {
  await expect(
    tenantDb({ tenantId: acme.id }).insert(users).values({ tenantId: globex.id, ... }),
  ).rejects.toThrow(/differs from the active context/)
})
```

Add one more at the HTTP level: sign in as a user of tenant A, request a resource whose id belongs to tenant B, and assert a **404** — not a 403. A 403 confirms the row exists, which is itself a cross-tenant leak.

## What this costs you

Be honest with yourself before starting. In rough order of how much they hurt:

**Every query becomes conditional.** "All users" no longer exists as a concept. Support tooling, exports, statistics and background jobs all need an explicit answer to "for whom", and each one is a place where somebody reaches for `unscopedDb()`.

**Migrations get harder.** A backfill on a table with `tenant_id` is no longer one `UPDATE`. Adding a unique index means deciding, per index, whether it is global or per-tenant — and the wrong answer is only discovered by the customer it locks out.

**The relational API is gone.** `db.query.users.findMany({ with: { roles: true } })` cannot be guaranteed scoped, so `tenantDb` removes it. Everything becomes explicit `select().from().innerJoin()`, which is more code and, once you are used to it, more readable SQL.

**The seeder and the tests need a tenant.** Every fixture starts with "create a tenant". The test helpers in `tests/support/world.ts` all grow a parameter.

**RBAC roughly doubles in size.** Two dimensions instead of one, a tenant switcher in the console, and the grantable rule to re-verify per tenant.

**The audit log needs a `tenant_id` too** — and a decision about whether a platform-level actor's entries belong to a tenant at all.

**Performance changes shape.** `tenant_id` belongs at the **front** of most composite indexes, and a query plan that was fine on one tenant's data can degrade badly once one customer holds 90% of the rows.

What it does **not** cost you: the shape of the application. Routes, services, repositories, the error contract, the type contract and the frontends all stay exactly as they are. That is what the single-tenant core was protecting, and it is why this guide is a checklist rather than a rewrite.

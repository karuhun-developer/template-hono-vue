# Add an API module

A complete endpoint — table, permission, routes, tests, console page — in twelve steps.

The worked example is **settings**: a single row of application-wide configuration, readable by anyone signed in and editable behind a new `setting.manage` permission. It is deliberately the smallest module that still touches every layer.

## 1. The permission

`packages/contract/src/rbac.ts`:

```diff
-export const PERMISSION_GROUPS = ['users', 'roles', 'audit'] as const
+export const PERMISSION_GROUPS = ['users', 'roles', 'audit', 'settings'] as const

 export const PERMISSIONS = [
   ...
   { key: 'audit.read', group: 'audit', label: 'View the audit log' },
+
+  // Settings
+  { key: 'setting.manage', group: 'settings', label: 'Change application settings' },
 ] as const satisfies readonly PermissionDefinition[]
```

Reading is not behind its own permission here: every signed-in user needs the application's name and time zone to render anything. Only changing them is privileged. **Add a key only when a route checks it** — a permission with nothing behind it is worse than a missing one, because nobody can tell whether it is wired up or aspirational.

Consider whether a system role should hold it. `owner` is `'*'` and gets it automatically; adding it to `admin` is a decision about your product.

## 2. The table

`apps/api/src/db/schema/settings.ts`:

```ts
import { pgTable, text } from 'drizzle-orm/pg-core'

import { primaryId, timestamps } from '#db/columns'

/**
 * Application-wide settings. Exactly one row, enforced by `settings_singleton_idx` — a
 * unique index on a constant expression, which is the only way to say "at most one row"
 * in Postgres without a trigger.
 */
export const settings = pgTable('settings', {
  id: primaryId(),
  appName: text('app_name').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  supportEmail: text('support_email'),
  ...timestamps(),
})
```

Then export it from the barrel — `apps/api/src/db/schema.ts`:

```diff
 export * from './schema/audit'
+export * from './schema/settings'
```

> **A table that is not exported from `schema.ts` will never be migrated.** `drizzle.config.ts` points at that one file, and the failure is silent: `make generate` simply produces nothing. Add the export in the same commit that creates the schema file.

## 3. The migration

```bash
make generate name=add_settings
```

**Read the SQL it wrote.** Drizzle guesses at renames, and a rename it reads as drop-then-create is silent data loss. The singleton index is one it cannot infer, so add it by hand to the generated file — that is legal, because the migration has not run anywhere yet:

```sql
CREATE UNIQUE INDEX "settings_singleton_idx" ON "settings" ((true));
```

Then:

```bash
make migrate
```

Once a migration has run anywhere other than your machine, it is frozen. Changes go in a new one.

## 4. The repository

`apps/api/src/modules/settings/settings.repo.ts`:

```ts
import { eq } from 'drizzle-orm'

import { db, type DatabaseHandle } from '#db/client'
import { settings } from '#db/schema'

export type SettingsRow = typeof settings.$inferSelect

export async function findSettings(handle: DatabaseHandle = db): Promise<SettingsRow | null> {
  const [row] = await handle.select().from(settings).limit(1)
  return row ?? null
}

export async function updateSettings(
  handle: DatabaseHandle,
  id: string,
  values: Partial<Pick<SettingsRow, 'appName' | 'timezone' | 'supportEmail'>>,
): Promise<void> {
  await handle
    .update(settings)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(settings.id, id))
}
```

SQL and nothing else. No permission checks, no HTTP, no messages meant for a human. Take a `DatabaseHandle` so a service can call it inside a transaction.

## 5. The service

`apps/api/src/modules/settings/settings.service.ts`:

```ts
import { db } from '#db/client'
import { notFound } from '#lib/errors'
import { diffFields, recordAudit, type AuditActor } from '#modules/audit/audit.repo'
import { findSettings, updateSettings, type SettingsRow } from '#modules/settings/settings.repo'
import type { UpdateSettingsBody } from '#modules/settings/settings.schema'

export async function getSettings(): Promise<SettingsRow> {
  const row = await findSettings()
  if (!row) throw notFound('Settings have not been initialised. Run `make seed`.')
  return row
}

export async function changeSettings(
  actor: AuditActor,
  body: UpdateSettingsBody,
): Promise<SettingsRow> {
  const before = await getSettings()

  return db.transaction(async (tx) => {
    await updateSettings(tx, before.id, body)

    const changes = diffFields(before, body)
    if (changes) {
      await recordAudit(tx, actor, {
        action: 'setting.update',
        subjectType: 'settings',
        subjectId: before.id,
        before: changes.before,
        after: changes.after,
      })
    }

    const saved = await findSettings(tx)
    if (!saved) throw new Error('the settings could not be read back')
    return saved
  })
}
```

Four habits worth copying:

- Guard clauses first, transaction second. Everything inside `db.transaction` should already be known to be legal.
- `recordAudit(tx, …)` joins the caller's transaction, so the change and its trail entry commit or roll back together.
- `diffFields()` records only what actually changed. A no-op save writes no audit entry.
- Read the row back **through the transaction handle** and return that, never the object you assembled in memory.

If a decision here depended on who is asking, the service would take an `AccessContext` as its first argument — as `changeRole` does.

## 6. The Zod schemas

`apps/api/src/modules/settings/settings.schema.ts`:

```ts
import { z } from 'zod'

export const updateSettingsBody = z
  .object({
    appName: z.string().trim().min(1).max(120),
    timezone: z.string().trim().min(1).max(64),
    supportEmail: z.email().nullable(),
  })
  .partial()

export type UpdateSettingsBody = z.infer<typeof updateSettingsBody>
```

Strict: lengths on every string, `.trim()`, and no `.passthrough()`. This is the only thing standing between a request body and the database.

## 7. The routes

`apps/api/src/modules/settings/settings.routes.ts`:

```ts
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'

import { badRequest } from '#lib/errors'
import { requirePermission } from '#middleware/rbac'
import type { AppBindings } from '#middleware/request-context'
import { requireAuth } from '#middleware/session'
import { actorFromContext } from '#modules/audit/audit.repo'
import { updateSettingsBody } from '#modules/settings/settings.schema'
import { changeSettings, getSettings } from '#modules/settings/settings.service'

const validationHook = (result: { success: boolean; error?: unknown }): void => {
  if (result.success) return
  throw badRequest('The details you sent are not valid.', result.error)
}

export const settingRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())

  .get('/', async (c) => {
    return c.json({ settings: await getSettings() })
  })

  .patch(
    '/',
    requirePermission('setting.manage'),
    zValidator('json', updateSettingsBody, validationHook),
    async (c) => {
      const settings = await changeSettings(actorFromContext(c), c.req.valid('json'))
      return c.json({ settings })
    },
  )
```

`requireAuth()` on the router, `requirePermission()` on the route that needs it, `zValidator` on every input, and the module's own `validationHook` so a validation failure gets the same body shape as every other error.

## 8. Mount it

`apps/api/src/app.ts`:

```diff
 export const app = base
   .route('/health', healthRoutes)
   .route('/auth', authRoutes)
   .route('/users', userRoutes)
   .route('/roles', roleRoutes)
   .route('/audit-logs', auditRoutes)
+  .route('/settings', settingRoutes)
```

> **Extend the chain. Never write a separate `app.route(...)` statement.** `AppType` is built from the return value of `.route()`. Break the chain and `AppType` silently loses the routes — no error anywhere, and the frontend calls that use them quietly stop being type-checked.

## 9. Seed the row

A singleton table needs its row to exist. In `apps/api/src/db/seed/index.ts`, add an idempotent insert alongside the others — `onConflictDoNothing()`, or a `findSettings()` check first. Running `make seed` twice must produce identical state.

## 10. The tests

`apps/api/tests/settings.test.ts`. Three cases at minimum:

```ts
it('returns the settings to any signed-in user', async () => {
  /* 200 */
})

it('rejects a change from someone without setting.manage', async () => {
  const response = await app.request('/settings', {
    method: 'PATCH',
    headers: { cookie: memberCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ appName: 'Nope' }),
  })
  expect(response.status).toBe(403)
})

it('records an audit entry when something actually changes', async () => {
  /* ... */
})
```

The 403 is not optional. It is the one that fails if somebody removes the guard, and it has to be an integration test — asserting that a mock returns `false` proves only that the mock returns `false`.

`apps/api/tests/support/world.ts` has the helpers for creating a user with given roles and signing them in.

## 11. The console page

```ts
// apps/console/src/lib/models.ts
export type AppSettings = InferResponseType<typeof api.settings.$get>['settings']
```

Then `SettingsPage.vue`, the route (`meta: { title: 'Settings', permission: 'setting.manage' }`), and the `NAV_ITEMS` entry — **in the same commit as the page**. Details are in [`../features/console-shell.md`](../features/console-shell.md).

Note that `meta.permission` here is `setting.manage` even though reading is open to everyone: a page whose only purpose is editing should not be offered to somebody who cannot save.

## 12. Finish

```bash
make seed      # writes the new permission and tops up wildcard roles
make check     # format → typecheck → lint → test
```

Add the `CHANGELOG.md` entry under `## [Unreleased] → Added`, and commit as `feat(api): add application settings`.

## Checklist

- [ ] Permission key added to `@app/contract`, with the route that checks it
- [ ] Schema file created **and exported from `schema.ts`**
- [ ] Migration generated, read, and committed — never edited afterwards
- [ ] Repository takes a `DatabaseHandle`
- [ ] Service owns the transaction and calls `recordAudit(tx, …)`
- [ ] Zod schemas for every input, with the module's `validationHook`
- [ ] `requireAuth()` on the router, `requirePermission()` on the route
- [ ] `app.ts` chain extended, not broken
- [ ] Seeder is still idempotent
- [ ] Tests: happy path, validation failure, **403**
- [ ] Frontend types derived from `AppType`
- [ ] Nav item and page in the same commit
- [ ] `make check` green, `CHANGELOG.md` updated

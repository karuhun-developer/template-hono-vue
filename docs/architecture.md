# Architecture

A pnpm monorepo with one API and one frontend, sharing two packages. The API owns the database and every rule; the frontends render what it says and enforce nothing.

This document is the one to read before writing code. The rest of the docs assume it.

## The golden rules

Six rules. Everything else in this repository follows from them, and a pull request that breaks one should be sent back even if it works.

**1. The API is the only enforcer.**
Every permission check that matters is `requirePermission()` on a route in `apps/api`. The console hides buttons, and hiding a button is one `fetch` away from being undone. If you only remember one rule, remember this one — and test it the way [`docs/features/rbac.md`](features/rbac.md) describes: open DevTools and call the endpoint directly.

**2. The type contract flows from `app.ts`, and is never hand-written.**
`apps/api/src/app.ts` exports `AppType`. The frontends consume it through `hc<AppType>()`. Nobody writes a response type twice, and nobody generates one. See [The type contract](#the-type-contract).

**3. Routes validate, services decide, repositories query.**
A route parses input and returns a response. A service holds the rules and owns the transaction. A repository writes SQL and knows nothing about permissions. When a file starts doing two of the three, split it.

**4. One error normalisation point.**
`apps/api/src/middleware/error.ts` is the only place an error turns into a response. Handlers `throw`; they never catch in order to shape their own JSON. The payoff is on the far side of the wire: a client has exactly one error shape to know.

**5. Migrations are generated, committed, and never edited.**
`make generate name=<snake_case>` writes the SQL; you read it, and you commit it. Editing a migration that has run anywhere means two databases with the same version number and different schemas.

**6. The frontend guard is UX, not security.**
`router.beforeEach` and the hidden menu items exist so that nobody is offered a link that always ends in a 403. That is their entire job. Rule 1 is what keeps the data safe.

## Workspace layout

```text
apps/
  api/            Hono + Drizzle + PostgreSQL. Owns the database and every rule.
  console/        Vue 3 back office. Signing in, users, roles, the audit log.
packages/
  contract/       Error codes and the permission catalog. Runs in Node and in the browser.
  ui/             Tailwind v4 tokens plus shadcn-vue components on reka-ui.
docker/           Postgres init scripts.
docs/             This directory.
scripts/          rename.mjs.
```

Workspace membership is the glob `apps/*` and `packages/*` in `pnpm-workspace.yaml`. **A new app needs no registration** — that is deliberate, and [`docs/guides/add-frontend-app.md`](guides/add-frontend-app.md) depends on it.

Inside `apps/api/src`:

| Directory         | Holds                                                                                    | Knows about      |
| ----------------- | ---------------------------------------------------------------------------------------- | ---------------- |
| `db/`             | The Drizzle client, shared column shapes, schema, migrations, the seeder                 | Postgres         |
| `lib/`            | Pure helpers: errors, tokens, passwords, cookies, logging                                | Nothing above it |
| `middleware/`     | Request context, sessions, RBAC, error normalisation                                     | Hono             |
| `modules/<name>/` | `*.routes.ts`, `*.schema.ts`, `*.service.ts`, `*.repo.ts`                                | Its own domain   |
| `platform/`       | Repositories shared across modules (`session.repo.ts`, `auth.repo.ts`, `invite.repo.ts`) | The database     |

## Request lifecycle

```text
  browser
     │  fetch(..., { credentials: 'include' })
     ▼
┌─────────────────────────────────────────────────────────────────────┐
│ requestContext()      uuidv7 request id · child logger · X-Request-Id │
├─────────────────────────────────────────────────────────────────────┤
│ secureHeaders()                                                      │
├─────────────────────────────────────────────────────────────────────┤
│ cors()                origin ∈ env.CORS_ORIGINS · credentials: true   │
├─────────────────────────────────────────────────────────────────────┤
│ sessionContext()      cookie → looksLikeToken → findLiveSession       │
│                       global, and silent when there is no cookie      │
├─────────────────────────────────────────────────────────────────────┤
│ requireAuth()         401 without a session · loads AccessContext     │
│                       per router: `.use('*', requireAuth())`          │
├─────────────────────────────────────────────────────────────────────┤
│ requirePermission()   403 unless the caller holds ALL of them         │
├─────────────────────────────────────────────────────────────────────┤
│ zValidator()          query · param · json → 400 through the hook     │
├─────────────────────────────────────────────────────────────────────┤
│ handler               reads c.req.valid(...), calls a service          │
│    └── service        decides · opens the transaction · recordAudit()  │
│           └── repo    SQL                                             │
└─────────────────────────────────────────────────────────────────────┘
     │  c.json(...)                        throw ApiError
     ▼                                          │
  response                                      ▼
                                    errorHandler → { error: { code, message } }
```

Two details in there are worth stating out loud.

`sessionContext()` is mounted **globally and permissively**: it reads the cookie if there is one and says nothing if there is not. Health checks and invitation links carry no session and both must keep working. Turning somebody away is `requireAuth()`'s job, and it is mounted per router.

The permissions are loaded **once**, in `requireAuth()`, not lazily inside each check. That is what lets `requirePermission()` stay synchronous and guarantees one query per request however many checks a route performs.

## The layers in detail

### Routes — `*.routes.ts`

A route declares its guards and its validation, then calls a service. It contains no `if` about who the caller is.

```ts
export const roleRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())
  .post(
    '/',
    requirePermission('role.manage'),
    zValidator('json', createRoleBody, validationHook),
    async (c) => {
      const role = await createRole(currentAccess(c), actorFromContext(c), c.req.valid('json'))
      return c.json({ role }, 201)
    },
  )
```

The permission sits **on the route**, next to the method and the path, rather than inside the service. A route that names no permission then looks suspicious at a glance, and that property is worth more than tidiness.

Note the chaining. See [The type contract](#the-type-contract) — it is not a style choice.

### Schemas — `*.schema.ts`

Zod schemas for query, param and body. They are the only thing standing between the request and the service, so they are strict: lengths, enums, `.trim()`, and no `.passthrough()`.

Every `zValidator` is given the module's `validationHook`, which throws `badRequest(...)` so that a validation failure goes through the same normalisation point as everything else instead of producing Hono's default text response.

### Services — `*.service.ts`

The rules live here, and so does the transaction boundary:

```ts
return db.transaction(async (tx) => {
  const id = await insertRole(tx, { ... })
  await replaceRolePermissions(tx, id, wanted)
  await recordAudit(tx, actor, { action: 'role.create', ... })
  return findRole(tx, id)
})
```

`recordAudit` takes the caller's handle, so the trail entry commits or rolls back **with** the change it describes. A state where one exists without the other must not be reachable.

Services receive an `AccessContext` when their decisions depend on who is asking — `assertGrantable` in `roles.service.ts` is the clearest example — and receive nothing but data when they do not.

### Repositories — `*.repo.ts`

SQL. No permission checks, no HTTP, no error messages meant for a human. Every function takes a `DatabaseHandle` when it can be part of a caller's transaction, so that a service is free to compose them.

Conditions that decide whether a row is _usable_ belong in the SQL, not in JavaScript afterwards. `findLiveSession()` in `platform/session.repo.ts` checks expiry, revocation, and the owner's status in one query — which is what makes "disable an account and its sessions die on the next request" true, with no revocation sweep anywhere.

### Middleware

| File                 | Provides                                                                               |
| -------------------- | -------------------------------------------------------------------------------------- |
| `request-context.ts` | `requestId`, a child logger, the `X-Request-Id` header, and the `AppVariables` type    |
| `session.ts`         | `sessionContext()`, `requireAuth()`, and the `currentUser` / `currentAccess` accessors |
| `rbac.ts`            | `requirePermission()` (all) and `requireAnyPermission()` (any)                         |
| `error.ts`           | `errorHandler` and `notFoundHandler` — the only producers of an error body             |

The accessors **throw when their middleware was not mounted**. `currentAccess(c)` on a route that forgot `requireAuth()` fails immediately with a message naming the missing middleware, rather than handing back `undefined` for somebody to `!` away.

## The type contract

This is the part worth understanding properly, because it is what makes the repository worth its structure.

`apps/api/src/app.ts` ends with:

```ts
export const app = base
  .route('/health', healthRoutes)
  .route('/auth', authRoutes)
  .route('/users', userRoutes)
  .route('/roles', roleRoutes)
  .route('/audit-logs', auditRoutes)
  .route('/jobs', jobRoutes)

export type AppType = typeof app
```

`apps/console/src/lib/api.ts` consumes it:

```ts
export const api = hc<AppType>(import.meta.env.VITE_API_URL, {
  init: { credentials: 'include' },
})
```

And a page derives its types from the call rather than declaring them:

```ts
export type UserSummary = InferResponseType<typeof api.users.$get>['items'][number]
```

Three consequences:

1. **Rename a route and the frontends stop compiling.** That is the entire point. `pnpm typecheck` is the integration test for the wire format.
2. **`@app/api` is a `devDependency` of every frontend.** Only types cross the boundary; nothing from the API is bundled into a browser.
3. **`Date` becomes `string`.** `hc` models what `JSON.stringify` actually produces. `apps/console/src/lib/models.ts` says so instead of pretending otherwise.

> **Routes must be chained.** `AppType` is built from the return value of `.route()`. Write `app.route(...)` as separate statements and the chain breaks: `AppType` silently loses those routes, no error is raised anywhere, and the frontend calls that used them quietly stop being type-checked. Always extend the existing chain.

### Adding a permission is a three-file change

`packages/contract/src/rbac.ts` is imported by the API (which enforces), the console (which renders the matrix) and the seeder (which writes it to the database). Add a key there, add `requirePermission('...')` to the route, run `make seed`. Nothing else knows the list.

## The testing contract

`apps/api` tests run against a **real PostgreSQL** — the `app_test` database created by `docker/postgres/init/01-databases.sql`. Not a mock, and not an in-memory substitute:

- Access control on top of a mocked database only proves that the mock allows what the mock allows.
- Constraints are part of the design here. `ON DELETE RESTRICT` on `user_roles.role_id` is what makes "you cannot delete a role in use" true under a race, and no mock reproduces that.

Three properties of the setup are deliberate:

- **`fileParallelism: false`.** One process, so suites cannot collide on a shared database. They are I/O-bound and short; the isolation is worth more than the parallelism.
- **The setup fails loudly.** If Postgres is not running, `apps/api/tests/setup/database.ts` throws with the commands to fix it. It never skips. A green run that never actually ran is more dangerous than a red one, because it is trusted.
- **The test environment is written into `process.env`, not only `test.env`.** `globalSetup` runs in the main Vitest process, outside the reach of `test.env` — without that line the migration step would connect to whatever `DATABASE_URL` sits in your `.env` and migrate your working database.

What is worth testing:

| Layer          | Test                                    | Example                                                                     |
| -------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| Pure functions | Unit, no database                       | `packages/contract/src/rbac.test.ts`, `apps/console/src/lib/access.test.ts` |
| Endpoints      | Integration through `app.request()`     | `apps/api/tests/users.test.ts`                                              |
| Access control | **Always integration.** Assert the 403  | `apps/api/tests/rbac.test.ts`                                               |
| Vue components | Only where the logic is not extractable | prefer moving it into a testable function first                             |

The pattern in `apps/console/src/lib/access.ts` is worth copying: the rule (`decideNavigation`, `beyondReach`) is a pure function that is unit-tested, and the component or the router guard is a thin switch over its result.

## Adding a feature: the checklist

The long form is [`docs/guides/add-api-module.md`](guides/add-api-module.md). The short form:

1. **Permission** — add the key to `packages/contract/src/rbac.ts`, or reuse an existing one.
2. **Schema** — add the table to `apps/api/src/db/schema/`, export it from `schema.ts`.
3. **Migration** — `make generate name=add_<thing>`, read the SQL, commit it.
4. **Repository** — the queries, each accepting a `DatabaseHandle`.
5. **Service** — the rules, the transaction, and `recordAudit()` for anything somebody may have to answer for later.
6. **Zod schemas** — query, param, body.
7. **Route** — `requireAuth()` on the router, `requirePermission()` on the route, `zValidator` for every input.
8. **Mount it** — extend the chain in `app.ts`. Do not break it.
9. **Test** — the happy path, the validation failure, and the 403.
10. **Frontend** — derive the types from `AppType`; never hand-write them.
11. **Navigation** — add the item in `nav.ts` and the route in `router/index.ts`, in the same commit as the page.
12. **`make check`**, then a `CHANGELOG.md` entry under `## [Unreleased]`.

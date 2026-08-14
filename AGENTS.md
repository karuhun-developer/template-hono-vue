# Hono + Vue Template — agent instructions

Read this before writing code. It is short on purpose; the reasoning lives in `docs/`.

**Project:** Hono + Vue Template — a pnpm monorepo starter. A Hono + Drizzle + PostgreSQL API, a Vue 3 back-office console, session authentication, RBAC, user management and an audit log. Nothing else, deliberately.

**Start here:** [`docs/architecture.md`](docs/architecture.md). Everything else assumes it.

## Non-negotiables

1. **Never edit a file in `apps/api/drizzle/`.** Migrations are generated with `make generate name=<snake_case>` and are immutable once committed. A change goes in a new migration. Never run `drizzle-kit push`.
2. **Never break the `.route()` chain in `apps/api/src/app.ts`.** `AppType` is the type of that chain's return value. A separate `app.route(...)` statement compiles, serves traffic, and silently drops the route from `AppType` — after which every frontend call to it stops being type-checked, with no error anywhere.
3. **Never hand-write a response type in a frontend.** Derive it: `InferResponseType<typeof api.users.$get>['users'][number]`. A declared duplicate is a type that will be wrong and will not say so.
4. **A permission check in a `.vue` file is never "done".** It is UX. The enforcement is `requirePermission()` in `apps/api`. If you added a guard to a route in the console, the endpoint behind it needs one too — and an integration test asserting **403**.
5. **One error shape.** Throw the helpers in `apps/api/src/lib/errors.ts`; `middleware/error.ts` is the only place that turns an error into a response. Frontends branch on `code`, never on `message`. Do not introduce a second envelope.
6. **English everywhere** — code, comments, error messages, docs, commit messages. Comments explain **why**, not what the next line does.
7. **`make check` passes before every commit.** Not before every push. Before every commit.

## Workspace

```
apps/api        Hono + Drizzle + PostgreSQL. Subpath imports: #env, #db/*, #lib/*, #modules/*
apps/console    Vue 3 back office. Alias: @/*
packages/contract  Error codes + the permission catalog. No DOM, no Node
packages/ui        Design tokens and shadcn-vue components
docs/           architecture · conventions · features/ · guides/ · decisions/
```

Inside `apps/api/src`: `modules/<name>/` holds `*.routes.ts` (validate), `*.service.ts` (decide), `*.repo.ts` (query), `*.schema.ts` (Zod). Never let a layer skip the one below it.

## Commands

```bash
make setup          # .env + pnpm install
make up             # Postgres (port 7332), waits until healthy
make migrate        # apply migrations
make seed           # idempotent: permissions, system roles, the owner account
make dev            # api :7300 · console :7301
make check          # format:check → typecheck → lint → test
make generate name=add_settings   # a new migration
```

`make test` needs `make up` first. If Postgres is down the suite **fails with instructions** — it never skips.

## Where things go

| You are about to                          | Read first                                                                                      |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Add an endpoint, a table, a permission    | [`docs/guides/add-api-module.md`](docs/guides/add-api-module.md)                                |
| Add a second Vue app                      | [`docs/guides/add-frontend-app.md`](docs/guides/add-frontend-app.md)                            |
| Add `tenant_id` to anything               | [`docs/guides/add-multi-tenancy.md`](docs/guides/add-multi-tenancy.md) — and read it to the end |
| Touch sessions, cookies or invitations    | [`docs/features/auth.md`](docs/features/auth.md)                                                |
| Touch roles or permission checks          | [`docs/features/rbac.md`](docs/features/rbac.md)                                                |
| Touch the audit trail                     | [`docs/features/audit-log.md`](docs/features/audit-log.md)                                      |
| Add a console page or route               | [`docs/features/console-shell.md`](docs/features/console-shell.md)                              |
| Change lint, types, tests or CI           | [`docs/features/code-quality.md`](docs/features/code-quality.md)                                |
| Argue for JWTs, OpenAPI, or multi-tenancy | [`docs/decisions/`](docs/decisions/) — the ADR may already answer you                           |

## Code style

- Imports are grouped with a blank line between groups: Node builtins, external packages, then local (`#…`, `@app/…`, `@/…`). No tool enforces it; follow the file next to you.
- `import type` for types — `verbatimModuleSyntax` is on and the ESLint fixer will do it.
- Zod on every input: lengths on strings, `.trim()`, never `.passthrough()`.
- Services own transactions. `recordAudit(tx, …)` joins the caller's transaction so the change and its trail commit together.
- Repositories take a `DatabaseHandle` and contain SQL only — no permission checks, no HTTP, no human-facing messages.
- Read a row back **through the transaction handle** and return that, never the object you assembled in memory.
- Never add an ESLint disable without a sentence above it saying why. Never widen a rule for the repository to fix one file.
- New globs in `eslint.config.js` use `apps/*`, never a hardcoded app name.

## Testing

`apps/api` tests run against a **real** PostgreSQL (`app_test`), single-process (`fileParallelism: false`). Helpers for creating users with roles and signing them in are in `apps/api/tests/support/world.ts`.

Every new endpoint gets three tests at minimum: the happy path, a validation failure, and a **403 for a user without the permission**. The 403 is the one that fails when somebody removes a guard, and it has to be an integration test — asserting that a mock returns `false` proves only that the mock returns `false`.

## Committing

Conventional Commits, imperative mood, lowercase subject, scope where it helps: `feat(api): add application settings`. Small and focused — one capability per commit, not one per phase of work. The body explains **why**, in English.

Add a `CHANGELOG.md` entry under `## [Unreleased]` whenever a commit adds a user-visible capability.

## Do not

- Do not `git push`, open a PR, or change repository settings unless asked.
- Do not add a dependency without saying what it replaces and why the alternative was worse.
- Do not add a permission key with no route behind it. Aspirational permissions are indistinguishable from wired ones.
- Do not put a secret in a compose file or in `.env.example`.
- Do not make a test suite skip when its dependency is missing. Fail, and say how to fix it.
- Do not answer "it's done" without having run `make check`.

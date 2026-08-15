# Hono + Vue Template

A pnpm monorepo starter for TypeScript applications: a **Hono + Drizzle + PostgreSQL** API, a **Vue 3** back-office console, session authentication, role-based access control, user management, and an audit trail — wired together and tested against a real database.

The frontends read their types straight out of the API's source through `hc<AppType>()`. No codegen, no OpenAPI, no response type written twice. Renaming a route is a compile error in every app that called it.

Everything here is deliberately small. What it gives you is the part every project needs and nobody enjoys rebuilding — see [**What this template deliberately does not include**](#what-this-template-deliberately-does-not-include) for the rest.

## What's inside

| Capability                                                                       | Where                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| **Session authentication** — opaque tokens, `httpOnly` cookies, invitations      | [`docs/features/auth.md`](docs/features/auth.md)                   |
| **RBAC** — a permission catalog, custom roles, a two-directional grantable rule  | [`docs/features/rbac.md`](docs/features/rbac.md)                   |
| **User management** — invite, edit, enable, disable                              | [`docs/features/users.md`](docs/features/users.md)                 |
| **Audit log** — append-only, written inside the transaction it describes         | [`docs/features/audit-log.md`](docs/features/audit-log.md)         |
| **Database** — the schema, the column vocabulary, and how migrations work        | [`docs/features/database.md`](docs/features/database.md)           |
| **Console shell** — a collapsible sidebar, routing, the session store, the guard | [`docs/features/console-shell.md`](docs/features/console-shell.md) |
| **Data table** — sorting, faceted filters, column visibility, selection          | [`docs/features/data-table.md`](docs/features/data-table.md)       |
| **Theming** — one token palette, light and dark, no raw colours                  | [`docs/features/theming.md`](docs/features/theming.md)             |
| **The gate** — Prettier, TypeScript, ESLint, Vitest, GitHub Actions              | [`docs/features/code-quality.md`](docs/features/code-quality.md)   |

## Tech Stack

- **Node.js >= 22** · **pnpm 11** workspaces
- **Hono 4** · **Zod 4** · **Drizzle ORM** · **PostgreSQL 17** · **Pino**
- **Vue 3.5** · **Pinia** · **vue-router 5** · **Vite 8** · **Tailwind CSS 4** · **reka-ui**
- **TypeScript 5.9** (strict) · **ESLint 9** (type-checked) · **Prettier 3** · **Vitest 4**
- **Docker Compose** for Postgres — the Node processes run on the host

## Requirements

- Node.js >= 22
- pnpm 11 (`corepack enable`)
- Docker with Compose v2

## Quick start

```bash
git clone <your-repo-url>
cd template-hono-vue

node scripts/rename.mjs --name my-project   # optional; see docs/guides/rename-template.md
make setup                                  # copy .env.example -> .env, pnpm install
make up                                     # start Postgres, wait until healthy
make migrate                                # apply the three migrations
make seed                                   # permissions, system roles, demo accounts
make dev                                    # api :7300, console :7301
```

Then open <http://localhost:7301>.

## Default accounts

Created by `make seed`, which refuses to run with `NODE_ENV=production`. Change `SEED_OWNER_*` in `.env` before seeding anything real.

| Email               | Password      | Role          | Why it exists                                                                                     |
| ------------------- | ------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `owner@example.com` | `password123` | Owner         | Full access; new permissions reach it automatically                                               |
| `admin@example.com` | `password123` | Administrator | Holds neither `user.disable` nor `audit.read`, so the grantable rule has something to demonstrate |

Sign in as the administrator to see the grantable rule without setting anything up: those two permissions render disabled in the role matrix, and opening the **Owner** role gives a locked one.

To see the invitation flow instead, invite a third account from **Users → Invite**. The invitation link is shown once, in a dialog, and never again — there is no email delivery in this template.

Re-running `make seed` leaves existing accounts **completely alone**, password included, so trying out the invitation flow is not undone by the next seed.

## Commands

`make help` lists all of them. The ones worth memorising:

| Command                           | What it does                                             |
| --------------------------------- | -------------------------------------------------------- |
| `make dev`                        | Every app in watch mode, in parallel                     |
| `make check`                      | The gate: `format:check` → `typecheck` → `lint` → `test` |
| `make generate name=add_settings` | Generate a migration from schema changes                 |
| `make migrate` / `make seed`      | Apply migrations / seed (both idempotent)                |
| `make reset`                      | Drop the volume, then migrate and seed from scratch      |
| `make psql`                       | A `psql` shell on the `app` database                     |
| `make test`                       | Vitest across the workspace, against a real Postgres     |

## Documentation

- [Architecture](docs/architecture.md) — the golden rules, the request lifecycle, the type contract, and the checklist every feature follows. **Read this first.**
- [Conventions](docs/conventions.md) — naming, imports, errors, migrations, commits.
- [The database](docs/features/database.md) — writing a table, generating a migration, and every way that goes wrong.
- [Add a frontend app](docs/guides/add-frontend-app.md) — the headline guide: a second Vue app in eleven steps, with no change to `apps/api`.
- [Add an API module](docs/guides/add-api-module.md) — a new endpoint end to end, permission included.
- [Add multi-tenancy](docs/guides/add-multi-tenancy.md) — the complete recipe, with the source you would need, and what it costs.
- [Rename the template](docs/guides/rename-template.md) — every string that carries the template's identity.
- [Decisions](docs/decisions/) — why sessions rather than JWTs, why RPC types rather than OpenAPI, why single-tenant.
- [Agent instructions](AGENTS.md) — the non-negotiables, for a coding agent or a new contributor. `CLAUDE.md` points here.
- [Changelog](CHANGELOG.md) — keep this updated as you build on top of the template.

## What this template deliberately does not include

Every one of these is a real decision, not an oversight. A starter that ships a half-built version of something costs more than one that ships nothing.

| Not included                    | Why, and what to do instead                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Multi-tenancy**               | The single largest architectural fork there is. Adding it later is a known path; removing it is a rewrite. The full recipe is in [`docs/guides/add-multi-tenancy.md`](docs/guides/add-multi-tenancy.md). |
| **Email delivery**              | Invitation links are returned by the API and shown in the console. Wire your provider into `users.service.ts` where the token is issued.                                                                 |
| **Password reset**              | Same machinery as invitations (`inv_` tokens, single-use, expiring). Build it from `docs/guides/add-api-module.md` once you have email.                                                                  |
| **Two-factor auth, OAuth, SSO** | Each is a product decision. The session layer is ready for any of them: authentication ends at "create a session row".                                                                                   |
| **Redis, queues, cron**         | Auth and RBAC need none of them. A paste-ready compose service is in [`docs/features/docker.md`](docs/features/docker.md).                                                                               |
| **File uploads**                | Storage choice belongs to your project, not to a starter.                                                                                                                                                |
| **Rate limiting**               | `rate_limited` is already in the error contract; the enforcement point belongs at your edge (nginx, Cloudflare, a load balancer) far more than in the app.                                               |
| **A production Dockerfile**     | [`docs/features/docker.md`](docs/features/docker.md) explains the packaging decision and what a real one looks like.                                                                                     |
| **A design system**             | `packages/ui` is eleven shadcn-vue components and a token file. Add what you need; do not import a second component library on top.                                                                      |

## License

MIT — see [LICENSE](LICENSE). Delete it and add your own when this stops being a template.

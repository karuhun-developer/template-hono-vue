# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Keep this updated.** Every time you ship a feature, fix, or breaking change on
> top of this template, add an entry under `[Unreleased]`. When you tag a release,
> move those entries into a new dated version section.

## [Unreleased]

### Added

- `packages/ui`: table, dropdown menu, select, avatar, popover, collapsible and tooltip primitives.
- `packages/ui`: the sidebar primitives — a collapsible, keyboard-toggled (`Ctrl/Cmd+B`) sidebar that
  renders itself into a sheet below `md`.
- `packages/ui`: the data table — sortable headers, faceted filters, column visibility, row selection
  with `Shift`-ranges, skeleton loading rows and three pager modes. See
  [`docs/features/data-table.md`](docs/features/data-table.md).
- Dark mode: `useTheme()`, a `ThemeToggle`, and a pre-paint script so a reload does not flash. See
  [`docs/features/theming.md`](docs/features/theming.md).
- `GET /users` and `GET /roles` take `page`, `perPage`, `sort` and `order`, and answer
  `{ items, total, page, perPage }`.
- `GET /users?roleId=` filters by role.
- `status`, `roleId`, `action` and `subjectType` may be given more than once and are read as a set.
- **Mail.** Templates in TypeScript, a `mail_messages` outbox written inside the transaction that
  caused it, and two drivers: `log` (the default — nothing to configure, the message is readable in
  the console) and `smtp`. `queueMail(tx, defer, …)` is the only way to send. See
  [`docs/features/mail.md`](docs/features/mail.md) and
  [ADR-0005](docs/decisions/ADR-0005-transactional-outbox-for-mail.md).
- Invitations and password resets are emailed. `inviteToken` and `resetToken` are still returned
  under `MAIL_DRIVER=log`, and `null` as soon as a real transport is configured.
- **A job queue** with three drivers — `database` (the default, and the only one whose enqueue joins
  your transaction), `redis` (BullMQ), and `sync` — a `make worker` entrypoint, retries with
  jittered backoff, dedupe keys, and stale-job reaping. See
  [`docs/features/queue.md`](docs/features/queue.md),
  [`docs/guides/add-a-job.md`](docs/guides/add-a-job.md) and
  [ADR-0004](docs/decisions/ADR-0004-jobs-in-postgres-by-default.md).
- **A scheduler.** Cron expressions in code, validated at boot, ticking in the worker only; a unique
  index on `(schedule_key, fired_for)` makes two replicas produce exactly one run. The cleanups that
  had been asking to be scheduled — sessions, invitations, resets — now are. See
  [`docs/features/scheduler.md`](docs/features/scheduler.md).
- **A cache** with `memory`, `database` and `redis` drivers, `remember()` with single-flight loading,
  and prefix invalidation. Permission lookups can be cached behind `CACHE_ACCESS_PERMISSIONS`, which
  is off by default. See [`docs/features/cache.md`](docs/features/cache.md).
- Users can be created directly with a password, soft-deleted and restored; `GET /users/:id` and
  `?includeDeleted=true` come with it. New owner-only keys: `user.create`, `user.delete`,
  `user.reset_password`.
- Password reset: `POST /auth/forgot-password`, `GET /auth/password-reset/:token`,
  `POST /auth/reset-password`, and `POST /users/:id/reset-password` for an administrator. Resetting
  revokes every other session.
- Console: **Jobs**, **Mail log** and **Scheduled jobs** under a new Operations group, visible only to
  an account holding the owner-only keys behind them.
- `GET /health/ready` reports a `queue` check beside `database`, and names both in `checks`.
- `transaction(fn(tx, defer))` — post-commit side effects that cannot be run for a change that
  rolled back — and a shutdown registry both entrypoints share.

### Changed

- The console shell is a grouped, collapsible sidebar with an account menu in its footer; navigation
  is `NAV_GROUPS` rather than a flat `NAV_ITEMS`.
- The user, role and audit-log pages are data tables rather than stacks of cards.
- Signing in and accepting an invitation share a split-screen `AuthLayout`.
- A console list page gets its state from `useResourceList` — one debounce, one coalesced request,
  and a stale-response guard — and a module's table, dialogs and API calls live in
  `features/<module>/`. `lib/models.ts` is a re-export barrel over them, so existing imports still
  compile.

### Deprecated

### Removed

- The mobile bottom bar — the sidebar renders in a sheet instead, so there is one navigation.
- `AccountSheet.vue`, replaced by the account dropdown in the sidebar footer.
- `NativeSelect.vue`, which no page used once the filters became facets.

### Fixed

### Security

<!--
Example release section — copy this shape when you cut a version:

## [1.0.0] - 2026-01-31

### Added
- Invitations can be re-sent from the user list.

### Changed
- `GET /users` now returns roles alongside each user.

### Security
- Session cookies are `Secure` in production.
-->

## [0.1.0]

### Added

- pnpm workspace, TypeScript / ESLint / Prettier configuration, Docker Compose stack and `Makefile`.
- `@app/contract`: the error-code contract and the permission catalog.
- `@app/ui`: Tailwind v4 design tokens and eleven shadcn-vue components.
- API: Hono app with validated environment, request context, structured logging and a single error normalisation point.
- API: session authentication — opaque tokens, `httpOnly` cookies, invitations.
- API: RBAC — permission catalog, roles, and `requirePermission()` on the route.
- API: append-only audit log, written inside the transaction of the action it describes.
- API: user and role management endpoints, with the two-directional grantable rule.
- API: idempotent seeder and an integration suite that runs against a real PostgreSQL.
- Console: Vue 3 shell — session store, navigation guard, sign-in and invitation pages.
- Console: user, role and audit-log pages.
- CI: GitHub Actions running the full gate, Dependabot with auto-merge for patch and minor updates.
- Documentation: architecture, conventions, feature docs, guides and decision records.
- Documentation: `docs/features/database.md` — the schema, the column vocabulary, the migration workflow and its failure modes.
- `AGENTS.md` with the non-negotiables, and `CLAUDE.md` pointing at it.
- `scripts/rename.mjs` — rename the template across nine files, with `--dry-run`.

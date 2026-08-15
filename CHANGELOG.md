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

### Changed

- The console shell is a grouped, collapsible sidebar with an account menu in its footer; navigation
  is `NAV_GROUPS` rather than a flat `NAV_ITEMS`.
- The user, role and audit-log pages are data tables rather than stacks of cards.
- Signing in and accepting an invitation share a split-screen `AuthLayout`.

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

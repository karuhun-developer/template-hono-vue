# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **Keep this updated.** Every time you ship a feature, fix, or breaking change on
> top of this template, add an entry under `[Unreleased]`. When you tag a release,
> move those entries into a new dated version section.

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

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

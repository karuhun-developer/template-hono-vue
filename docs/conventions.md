# Conventions

The rules that are not enforced by a tool. The ones that are enforced live in [`features/code-quality.md`](features/code-quality.md).

## Language

**English everywhere** — code, comments, commit messages, error messages, documentation, and the strings in the console. One language across the whole repository means a search for a term finds every occurrence of it.

Comments explain **why**, never what. A comment restating the line below it is noise that goes stale; a comment recording a decision is the only place that decision survives. Look at `apps/api/src/lib/session-cookie.ts` for the register: it explains why `SameSite=Lax` rather than `Strict` or `None`, and never explains what `setCookie` does.

## Naming

| Thing                 | Convention                                    | Example                                      |
| --------------------- | --------------------------------------------- | -------------------------------------------- |
| Files, TypeScript     | `kebab-case.ts`                               | `session-cookie.ts`                          |
| Files, module members | `<module>.<layer>.ts`                         | `users.service.ts`                           |
| Vue components        | `PascalCase.vue`                              | `PermissionMatrix.vue`                       |
| Tables, columns       | `snake_case`, tables plural                   | `user_roles`, `invite_token_hash`            |
| Drizzle properties    | `camelCase`, mapping to the snake_case column | `inviteTokenHash: text('invite_token_hash')` |
| Permission keys       | `<domain>.<action>`                           | `user.disable`                               |
| Audit actions         | The same vocabulary as permissions            | `role.update`                                |
| Routes                | Plural, kebab-case                            | `/audit-logs`                                |
| Environment variables | `SCREAMING_SNAKE_CASE`                        | `SESSION_TTL_DAYS`                           |
| Booleans              | A predicate                                   | `isProduction`, `hasPermission`              |

A dangerous verb gets its own permission key. If `user.update` also covered disabling an account, letting somebody fix a typo in a name would mean letting them lock people out.

## Imports

Three mechanisms, each for one job:

| Prefix   | Means                            | Configured in                                           |
| -------- | -------------------------------- | ------------------------------------------------------- |
| `#*`     | A file inside `apps/api/src`     | `imports` in `apps/api/package.json`                    |
| `@/*`    | A file inside a frontend's `src` | `vite.config.ts` alias + `paths` in its `tsconfig.json` |
| `@app/*` | A workspace package              | `pnpm-workspace.yaml`                                   |

The API uses **Node subpath imports** rather than `paths` in `tsconfig.json`, and that matters: `paths` is a TypeScript-only fiction that the runtime knows nothing about, so it needs a bundler or a loader to become true at runtime. `imports` is resolved by Node itself, by TypeScript, and by Vitest — one mechanism, no build step, and `tsx src/index.ts` just works.

Imports are grouped, in this order, with a blank line between groups: Node builtins (`node:crypto`), external packages, then local ones (`#…`, `@app/…`, `@/…`). No tool enforces it — follow what the file next to you already does.

Type-only imports are inlined: `import { type Foo, bar } from '...'`. ESLint's `consistent-type-imports` rule fixes this for you with `pnpm lint:fix`.

## TypeScript

- **Strict**, with `exactOptionalPropertyTypes` on — except in `tsconfig.vue.json`, where Vue's runtime hands `undefined` to unpassed optional props while libraries declare them without `| undefined`. The flag stays on for the API and the contract, where it earns its keep.
- **No `any`.** `unknown` plus a narrowing check, every time. The one place `unknown` is unavoidable — data arriving from the network — has a type guard next to it (`isApiErrorBody`).
- **No non-null assertions** outside tests. If a value can be absent, handle it; if it cannot, make the type say so.
- **Derive, do not declare.** `PermissionKey` is derived from `PERMISSIONS`, `ErrorCode` from `ERROR_CODES`, `UserSummary` from `AppType`. A union written by hand is a union that drifts.
- `as const satisfies T` for catalogs: `satisfies` checks the shape, `as const` keeps the literals narrow enough to derive from.

## Errors

Throw `ApiError` — or one of the helpers in `apps/api/src/lib/errors.ts` — and let `middleware/error.ts` shape the response. Never build an error body in a handler.

The **`code` is the contract; the `message` is a sentence**. Frontends branch on `code`. A frontend that matches a substring of a message turns a typo fix into a silent bug in two other places.

| Code                | Status | Use for                                                    |
| ------------------- | ------ | ---------------------------------------------------------- |
| `bad_request`       | 400    | Malformed input, and the `zValidator` hook                 |
| `unauthorized`      | 401    | No session, or sign-in failed                              |
| `forbidden`         | 403    | A session, but not the permission                          |
| `not_found`         | 404    | No such row, and no such route                             |
| `conflict`          | 409    | An illegal transition, or uniqueness the database rejected |
| `validation_failed` | 422    | A `ZodError` that escaped a validator                      |
| `rate_limited`      | 429    | Reserved; nothing throws it yet                            |
| `internal_error`    | 500    | A bug. Detail goes to the log, not to the client           |

Messages are written for the person reading them, and they say what to do next: _"This invitation link is no longer valid. Ask for a new one."_ They never leak whether an email address exists — see [`features/auth.md`](features/auth.md).

## Database

- Every primary key is a **UUIDv7** from `primaryId()`. Unguessable like any UUID, but time-ordered, so inserts land at the right-hand edge of the B-tree instead of scattering across it. Generated in the application, because PostgreSQL 17 has no built-in `uuidv7()`.
- Every timestamp is `timestamptz` from `columns.ts`. UTC in the database; conversion happens at the edges.
- Spread `...timestamps()` for `created_at` / `updated_at`. An append-only table (`audit_logs`) deliberately does not get them.
- **`uniqueIndex()` rather than `unique()`** when the column is a foreign-key target. Drizzle's `unique()` produces a table constraint; a functional or partial uniqueness rule (`lower(email)`, `invite_token_hash WHERE ... IS NOT NULL`) can only be an index. Being consistent about it means one mechanism to reason about.
- Delete behaviour is a design decision, not a default. `ON DELETE CASCADE` where the child is meaningless alone (`sessions`, `role_permissions`); `ON DELETE RESTRICT` where the constraint is a rule (`user_roles.role_id` is what makes "you cannot delete a role in use" true under a race).
- Soft-delete with `deleted_at` where the row must remain referable — a person who leaves is still named by old audit entries.

## Migrations

```bash
make generate name=add_settings   # writes apps/api/drizzle/NNNN_add_settings.sql
make migrate                      # applies what is pending
```

- **Always generate. Never `drizzle-kit push`.** Push mutates the database with no artefact, which means no review, no history, and no reproducing it on another machine.
- **Read the generated SQL before committing it.** Drizzle guesses at renames; a rename it reads as drop-then-create is silent data loss.
- **Never edit a migration that has run anywhere.** Two databases with the same version number and different schemas is a debugging session nobody deserves. Write a new one.
- Name it in `snake_case`, as an action: `add_settings`, `drop_legacy_status`.
- `apps/api/drizzle/**` is marked `linguist-generated` in `.gitattributes`. It is committed, and it is not hand-edited.

## Git

Conventional Commits, with a scope where one applies:

```text
feat(api): add user and role management endpoints
fix(console): keep the invite dialog open when the clipboard is refused
docs: explain the grantable rule with the admin role
chore(deps): bump drizzle-orm to 0.44
```

Types in use: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `ci`, `perf`.

- **Small commits, one concern each.** A commit that changes a schema type to fix a compile error is not part of the commit that adds the page.
- The subject is lower-case, imperative, and has no full stop.
- The body explains **why**, in prose, wrapped at 72 characters. Nobody needs a list of the files you touched — `git show` has that.
- `make check` passes before every commit.

## Formatting

Prettier owns it. No arguments, no manual alignment, no `// prettier-ignore` for aesthetics.

```bash
make fmt      # write
make check    # verify, along with everything else
```

Settings that matter: no semicolons, single quotes, trailing commas, 100 columns. They are in `.prettierrc.json` and are not up for discussion inside a project — the point of a formatter is that the question stops being asked.

# The database and its migrations

PostgreSQL 17, reached through Drizzle ORM. The schema is TypeScript; the migrations are SQL generated from it, committed, reviewed, and never edited afterwards. This document is how you change it.

If you only remember one paragraph: **edit `src/db/schema/`, run `make generate name=…`, read the SQL it wrote, run `make migrate`, commit both.** Everything below is the detail behind those four steps and the ways they go wrong.

## The files

| Path                                    | What it is                                                                    |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/api/src/db/schema.ts`             | The barrel. A table not exported here does not exist as far as Drizzle sees   |
| `apps/api/src/db/schema/*.ts`           | The tables, one file per subject area                                         |
| `apps/api/src/db/columns.ts`            | The shared column vocabulary — `primaryId()`, `timestamptz()`, `timestamps()` |
| `apps/api/src/db/client.ts`             | The pool, the type-safe `db` handle, `closeDatabase()`                        |
| `apps/api/src/db/migrate.ts`            | What `make migrate` runs                                                      |
| `apps/api/drizzle/*.sql`                | The migrations. Generated, committed, never hand-edited once applied          |
| `apps/api/drizzle/meta/_journal.json`   | The ordered list of migrations, and the only thing that defines their order   |
| `apps/api/drizzle/meta/*_snapshot.json` | What the schema looked like after each migration — the diff source            |
| `apps/api/drizzle.config.ts`            | Where drizzle-kit looks for all of the above                                  |

## The configuration

`apps/api/drizzle.config.ts` is short, and four of its lines decide things you would otherwise have to remember:

```ts
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts', // the barrel, not a glob — see below
  out: './drizzle',
  dbCredentials: { url: databaseUrl },
  strict: true, // ask before running anything destructive
  verbose: true, // print the SQL it is about to run
  casing: 'snake_case', // camelCase in TS, snake_case in SQL, automatically
})
```

It loads `../../.env` — the repository root — with `process.loadEnvFile`, and throws a readable error if `DATABASE_URL` is missing rather than emitting a migration against nothing.

> **`casing: 'snake_case'` is why `passwordHash` becomes `password_hash` in SQL.** It is a project-wide setting, so a column whose name you _do_ spell out and a column you leave to the config must not disagree — and the existing schema spells every name out, including in the `columns.ts` helpers, which take the name as an argument. Follow that: an explicit name cannot change under you when a config option does.

## The column vocabulary

Before adding a column, look in `apps/api/src/db/columns.ts`. It exists so that no single table quietly ends up on `serial`, or on `timestamp without time zone`.

| Helper            | Produces                                                   | Use it for                         |
| ----------------- | ---------------------------------------------------------- | ---------------------------------- |
| `primaryId()`     | `uuid` primary key, UUIDv7 generated in the application    | Every primary key                  |
| `idRef(name)`     | A plain `uuid` column                                      | Foreign keys to those primary keys |
| `timestamptz(n)`  | `timestamp with time zone`, JS `Date` in and out           | Every instant                      |
| `...timestamps()` | `created_at` + `updated_at`, both `notNull().defaultNow()` | Every mutable table                |

UUIDv7 is time-ordered, so inserts land at the right-hand edge of the B-tree instead of scattering across it the way UUIDv4 does. It is generated in the application because PostgreSQL 17 has no built-in `uuidv7()`.

Adding a helper is right when a shape must be identical everywhere — money as `numeric`, a slug with a fixed constraint. Adding one for a column that appears twice is not.

## The barrel is load-bearing

`apps/api/src/db/schema.ts` is three re-exports:

```ts
export * from '#db/schema/identity'
export * from '#db/schema/rbac'
export * from '#db/schema/audit'
```

`drizzle.config.ts` points `schema` at this one file rather than at `./src/db/schema/*.ts`. That is a deliberate trade: one place lists what the database contains, and adding a file is a visible one-line diff.

> **The failure mode has no error message.** A new `src/db/schema/settings.ts` that is never exported from the barrel compiles, typechecks, lints, and is invisible to `drizzle-kit generate` — which will cheerfully answer `No schema changes, nothing to migrate 😴`. If you wrote a table and generate found nothing, this is why, every time.

## Writing a table

A worked shape, from `apps/api/src/db/schema/identity.ts`:

```ts
import { pgEnum, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

import { primaryId, timestamps, timestamptz } from '#db/columns'

export const userStatus = pgEnum('user_status', ['invited', 'active', 'disabled'])

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    passwordHash: text('password_hash'), // null until an invitation is accepted
    status: userStatus('status').notNull().default('invited'),
    deletedAt: timestamptz('deleted_at'),
    ...timestamps(),
  },
  (table) => [
    // Case-insensitive uniqueness. Only an index can do this — see below.
    uniqueIndex('users_email_key').on(sql`lower(${table.email})`),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
```

Five things that are conventions here, not accidents:

1. **`$inferSelect` / `$inferInsert` are exported next to the table.** Nothing in the codebase hand-writes a row type.
2. **The third parameter returns an array**, not an object. Drizzle 0.44 still accepts the object form but marks it `@deprecated`: _"the third parameter of pgTable is changing and will only accept an array instead of an object"_. Every table here uses the array.
3. **`uniqueIndex()` rather than `unique()`.** `unique()` emits a table constraint; a functional (`lower(email)`) or partial (`WHERE … IS NOT NULL`) rule can only be an index. One mechanism is easier to reason about than two.
4. **Delete behaviour is chosen every time.** `ON DELETE CASCADE` where the child is meaningless alone (`sessions`); `ON DELETE RESTRICT` where the constraint is a rule (`user_roles.role_id` is what makes "you cannot delete a role in use" true under a race, not the friendly 409 in the service).
5. **Index names are explicit.** `users_email_key`, `audit_logs_created_idx`. A generated name is a name nobody can grep for when a query plan mentions it.

Then export the file from `src/db/schema.ts`, or nothing you just wrote exists.

## The workflow

```bash
make generate name=add_settings   # writes apps/api/drizzle/0003_add_settings.sql
$EDITOR apps/api/drizzle/0003_add_settings.sql   # read it. every time.
make migrate                      # applies what is pending
```

`make generate` is `drizzle-kit generate --name=$(name)`. It diffs your schema against `drizzle/meta/0002_snapshot.json`, writes the SQL, writes a new snapshot, and appends an entry to `_journal.json`. It **does not touch the database** — you can generate on a machine with no Postgres running.

Name it in `snake_case`, as an action: `add_settings`, `drop_legacy_status`, `backfill_user_slugs`. Without `--name`, drizzle-kit invents something like `0003_typical_wolverine` and your `git log drizzle/` stops being readable.

`make migrate` runs `apps/api/src/db/migrate.ts`, which is a thin wrapper: apply, log, `closeDatabase()` in a `finally`, `process.exitCode = 1` on failure.

### Never `drizzle-kit push`

`push` diffs your schema straight against a live database and mutates it. No file, no review, no history, no way to reproduce it on another machine or in CI. It is a REPL for schemas, and a REPL is not a deployment mechanism. There is deliberately no `make push`.

### What to look for in the generated SQL

Reading it takes thirty seconds and catches the following, all of which are silent:

| What you see                                               | What it may actually be                                                                                        |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `DROP COLUMN "x"` next to `ADD COLUMN "y"`                 | **A rename read as drop-then-create.** Every value in `x` is gone. Rewrite it as `ALTER TABLE … RENAME COLUMN` |
| `ADD COLUMN … NOT NULL` with no `DEFAULT`, table not empty | Fails on deploy against real data. Add nullable → backfill → set `NOT NULL`                                    |
| `CREATE UNIQUE INDEX` on existing data                     | Fails if there is already a duplicate. Check with a `SELECT … GROUP BY … HAVING count(*) > 1` first            |
| `ALTER COLUMN … SET DATA TYPE`                             | Postgres rewrites the whole table and holds an `ACCESS EXCLUSIVE` lock for the duration                        |
| `DROP TYPE` / `CREATE TYPE` around an enum                 | Drizzle cannot always alter an enum in place; check whether the column survives                                |

> **`--> statement-breakpoint` is not a comment you can ignore.** The migrator splits the file on it and executes each piece as a separate statement. Deleting one merges two statements into a single `execute()` call; adding one in the middle of a statement breaks it. If you hand-write SQL into a migration, put a breakpoint between every statement.

## Hand-writing SQL into a migration

Legitimate, and expected, for anything the schema file cannot express: a backfill, a check constraint, a trigger, a rename. The rule is **when**, not whether.

- **Before it has been applied anywhere** — edit freely. It is just a file.
- **After it has run on any database** — do not touch it. Write a new migration.

Generate the empty shell first so the journal and the snapshot stay consistent, then write into it:

```sql
-- 0003_backfill_user_slug.sql
ALTER TABLE "users" ADD COLUMN "slug" text;--> statement-breakpoint
UPDATE "users" SET "slug" = lower(split_part("email", '@', 1)) WHERE "slug" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_slug_key" ON "users" ("slug");
```

If your hand-written SQL changes the _shape_ of the schema — and the three `ALTER`s above do — the schema file in `src/db/schema/` must be edited to match, or the very next `make generate` will diff against a snapshot that disagrees with reality and try to "fix" it. The snapshot is written from your TypeScript, not from the database.

> **`CREATE INDEX CONCURRENTLY` cannot go in a migration.** Every pending migration runs inside one transaction (see below), and Postgres forbids `CONCURRENTLY` inside a transaction block. Run it by hand against production, then add the plain `index()` to the schema file and generate a migration you never apply there — or accept the lock.

## Why "never edit an applied migration" is stricter than it sounds

The instinct is that Drizzle will notice and complain. It will not. From `drizzle-orm@0.44`'s PostgreSQL dialect, this is the whole algorithm:

```js
const dbMigrations = await session.all(
  sql`select id, hash, created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1`,
)
const lastDbMigration = dbMigrations[0]
await session.transaction(async (tx) => {
  for await (const migration of migrations) {
    if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
      for (const stmt of migration.sql) await tx.execute(sql.raw(stmt))
      await tx.execute(sql`insert into ... values(${migration.hash}, ${migration.folderMillis})`)
    }
  }
})
```

Three consequences follow directly, and each has bitten somebody:

**The stored `hash` is written and never compared.** Editing an already-applied migration produces no error, no warning, and no re-run. The file and the database simply disagree from then on — and every new machine that migrates from scratch gets the edited version, so development and production diverge permanently. There is no diagnostic for this. That is the entire reason for the rule.

**Only the timestamp is compared, and only against the newest row.** A migration whose `folderMillis` is _older_ than the last applied one is skipped silently and forever. This is not hypothetical: two branches each generate a migration, branch B merges first, branch A's migration now carries an earlier timestamp — and on any database that already ran B, A never runs. See below.

**All pending migrations share one transaction.** If the fourth of five fails, the first three roll back too; you never end up half-migrated. It also means a `CREATE INDEX CONCURRENTLY` or a `VACUUM` cannot be in one.

## Recipes

| You want to               | Do this                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Add a nullable column     | Add it to the schema, generate, migrate. Safe on any table size                                                                |
| Add a `NOT NULL` column   | Either give it a `.default(...)`, or three statements: add nullable → `UPDATE` → `SET NOT NULL`                                |
| Rename a column           | Generate, then **replace** the drop/add pair with `ALTER TABLE "t" RENAME COLUMN "old" TO "new"` before applying               |
| Rename a table            | Same: `ALTER TABLE "old" RENAME TO "new"`                                                                                      |
| Drop a column             | Ship the code that stops reading it **first**, in its own release. Then drop it in the next one                                |
| Change a type             | Generate and read it. If Drizzle emits a bare `SET DATA TYPE`, add `USING` yourself when the cast is not implicit              |
| Add a value to a `pgEnum` | Add it to the array in the schema file. Drizzle emits `ALTER TYPE … ADD VALUE`, which is cheap. **Removing** one is not        |
| Add an index              | `index('t_col_idx').on(table.col)` in the table's second argument, then generate                                               |
| Add a check constraint    | Hand-write `ALTER TABLE "t" ADD CONSTRAINT "t_x_check" CHECK (...)` into the migration; mirror it with `check()` in the schema |
| Backfill data             | Its own migration, named `backfill_*`, with nothing else in it. A failed backfill should not roll back a schema change         |
| Start over locally        | `make reset` — drops the volume, migrates, seeds                                                                               |

## There is no `down`

Drizzle generates no rollback SQL, and this template adds none. That is a position, not a gap.

A `down` migration is written when you are least able to test it and run when you are least able to think — during an incident, against production data the reverse script has never seen. A `DROP COLUMN` in a `down` is not a rollback; it is the same data loss the `up` was careful to avoid, arriving under time pressure.

What to do instead:

- **Locally:** `make reset`. It takes seconds and it is exact.
- **In production, for a schema change:** write a new forward migration that undoes it. It goes through review like anything else.
- **In production, for a deploy going wrong:** roll back the _application_, not the schema. This only works if the schema change was backward-compatible with the previous release — which is what the next section is about.

## Deploying: expand, migrate, contract

Migrations run against a database that the previous version of the application is still talking to. Any schema change that the old code cannot survive is an outage during the rollout window, however short.

The safe shape is three releases, not one:

1. **Expand.** Add the new column (nullable, or defaulted). Old code ignores it; new code can start writing it. Deployable in any order.
2. **Migrate and switch.** Backfill; ship the code that reads the new column. Both columns still exist, so rolling the application back is still possible.
3. **Contract.** Once nothing reads the old column, drop it.

Steps 1 and 3 must not be in the same release. Everything that hurts — dropping a column, tightening to `NOT NULL`, renaming — hurts because it collapses these three into one.

For this template's own `make migrate`, the ordering is: **migrate before starting the new application processes**. `apps/api/src/db/migrate.ts` is a separate command precisely so it can be a deploy step rather than something the server does at boot — two API instances racing to migrate at startup is a lock contention bug waiting for your busiest day.

## Inspecting

```bash
make psql                                  # a psql shell on the app database
\dt                                        # tables
\d users                                   # one table: columns, indexes, constraints
select * from drizzle.__drizzle_migrations; # what has actually been applied
```

`drizzle.__drizzle_migrations` has three columns — `id`, `hash`, `created_at` — where `created_at` is the migration's `folderMillis`, not a real timestamp of when it ran. It is the source of truth for "has this run", and the reason a database restored from a backup knows where it is.

`pnpm --filter @app/api db:studio` opens Drizzle Studio, a browser UI over the live database. It is a convenience for looking, not a place to change things: an edit made there leaves no migration and no trace.

## Troubleshooting

**`No schema changes, nothing to migrate 😴`, but you changed something.** In order of likelihood: the file is not exported from `src/db/schema.ts`; you edited a table that is exported but under a different name; the change is invisible to SQL (a `$type<…>()` narrowing, a comment, a TypeScript-only default).

**`drizzle-kit check` says the migrations are inconsistent.** Run `pnpm --filter @app/api exec drizzle-kit check`. Healthy output is `Everything's fine 🐶🔥`. A complaint means `_journal.json` and the `.sql` files disagree — usually a merge that took one side of the journal and both sides of the files.

**Two branches, two migrations, and one of them never runs.** The symptom is the worst kind: green CI (which migrates from scratch, in journal order) and a broken staging database (which had already applied the newer one). Because the migrator only compares against the single newest applied row, the older-timestamped migration is skipped forever.

Fix it at merge time, on the branch that merges second — **regenerate rather than resolve**:

```bash
# On your branch, after pulling the merged main.
rm apps/api/drizzle/0003_your_migration.sql
rm apps/api/drizzle/meta/0003_snapshot.json
git checkout origin/main -- apps/api/drizzle/meta/_journal.json   # take theirs wholesale
make generate name=your_migration                                 # now numbered after theirs
make reset                                                        # prove it from scratch
```

Delete your `.sql` and its snapshot, take the other branch's `_journal.json` whole, regenerate against the merged schema. **Never hand-merge `_journal.json`** — the array order _is_ the migration order, and a conflict marker resolved by keeping both entries produces exactly the skipped-migration bug above.

**The migration failed halfway.** It did not. The whole pending batch is one transaction, so the database is exactly where it was. Fix the SQL — the file has not been applied, so you may edit it freely — and run `make migrate` again.

**A migration applied on a colleague's machine and not on yours, with the same files.** Check `select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1` against the `when` field in `_journal.json`. If your newest applied row is newer than the migration in question, you are in the two-branch case above.

**Tests fail with a missing column.** The test database is a real database (`app_test`) and migrations do not run themselves. `make migrate` targets `DATABASE_URL`; the test setup in `apps/api/tests/setup/` handles `app_test`. When in doubt, `make reset`.

## Conventions

- Edit `src/db/schema/`, then **generate**. Never `drizzle-kit push`, in any environment.
- Export every new schema file from `src/db/schema.ts` in the same commit that creates it.
- Name migrations in `snake_case`, as an action. Always pass `name=`.
- **Read the generated SQL before committing it.** Especially any `DROP`.
- Edit a migration only while it is unapplied everywhere. Once it has run, write a new one.
- Keep a backfill in its own migration, separate from the schema change it supports.
- Commit the `.sql`, the snapshot and `_journal.json` together — they are one artefact.
- `apps/api/drizzle/**` is `linguist-generated` in `.gitattributes`. It is committed, and it is not hand-edited after the fact.
- Use `columns.ts` for anything that must be identical everywhere. Add to it rather than around it.
- Export `$inferSelect` / `$inferInsert` beside every table. Nothing hand-writes a row type.
- Choose `ON DELETE` behaviour deliberately, every time. The default is not a decision.

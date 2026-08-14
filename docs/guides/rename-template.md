# Rename the template

Do this **once, immediately after cloning, before `pnpm install`** — the root package name ends up in `pnpm-lock.yaml`, and renaming afterwards means regenerating it.

```bash
node scripts/rename.mjs --name acme-portal --dry-run   # see what would change
node scripts/rename.mjs --name acme-portal             # do it
```

Or through the Makefile, which passes the flag in its `--name=value` form:

```bash
make rename name=acme-portal
```

## What `--name` derives

Two strings, from one argument:

| Value     | Derived from `acme-portal` | Where it goes                                                          |
| --------- | -------------------------- | ---------------------------------------------------------------------- |
| **slug**  | `acme-portal`              | `package.json`, the compose project name, the clone path in the README |
| **title** | `Acme Portal`              | headings, `APP_NAME`, agent instructions                               |

The title is the slug with hyphens turned into spaces and each word capitalised, which is right for `acme-portal` and wrong for `acme-hq`. Override it when it is wrong:

```bash
node scripts/rename.mjs --name acme-hq --title 'Acme HQ'
```

`--name` must be a lowercase npm-safe slug — letters, digits and hyphens, starting with a letter. The script refuses anything else rather than writing an invalid `package.json`.

## What it edits

At most nine files, and nothing outside this list:

| File                 | What changes                                               |
| -------------------- | ---------------------------------------------------------- |
| `package.json`       | `"name"` and `"description"`                               |
| `README.md`          | the H1, and the directory in the quick-start `cd`          |
| `CHANGELOG.md`       | the "on top of this template" line, which stops being true |
| `AGENTS.md`          | the H1 and the project line                                |
| `CLAUDE.md`          | the H1                                                     |
| `LICENSE`            | the copyright holder — **only with `--author`**            |
| `docker-compose.yml` | `name: app` → `name: acme-portal`                          |
| `.env.example`       | `APP_NAME`                                                 |
| `.env`               | `APP_NAME`, **only if the file exists**                    |

It is a literal string replacement over a fixed list of paths. No globbing, no regex over the whole tree, nothing recursive. A rename script that walks `src/` is a rename script that renames something inside a string literal at three in the morning.

`--dry-run` prints the same summary and writes nothing. Run it first.

Running it twice is safe. Every replacement is anchored rather than a blind search, so a file that has already been renamed reports `already up to date` instead of being mangled a second time.

## What it deliberately leaves alone

| Not renamed                 | Why                                                                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `@app/*` scope          | Generic on purpose. `@app/api` reads the same in every project, and renaming it would touch every import in the repository                            |
| The database name `app`     | It lives inside a container, on a private network, in a per-project volume. Renaming it buys nothing and invalidates `.env` files people already have |
| Ports 7300 / 7301 / 7332    | Change them by hand if they collide — [`add-frontend-app.md`](add-frontend-app.md#8-wire-the-environment) lists every place a port appears            |
| "Console" in `apps/console` | The name of that app, not of the project. It stays `Console` unless you rename the app itself                                                         |

> **`name:` in `docker-compose.yml` is the one that bites.** It is the compose _project_ name, and volumes are namespaced under it. Two template-derived projects that both call themselves `app` share `app_pgdata` — so the second one starts with the first one's database in it, migrations half-applied, and no error anywhere. Rename before the first `make up`.

## Afterwards

The script does not touch prose, because prose written for a template is wrong for a product in ways only you can fix:

- **`README.md`** — the lead paragraph still describes a starter. Rewrite it to describe what you are building. Then delete **"What this template deliberately does not include"** — it is a list of decisions the template made, not decisions your project made.
- **`CHANGELOG.md`** — the `## [0.1.0]` section documents the template's own history. Replace it with your own first entry, or reset the file to an empty `## [Unreleased]`.
- **`LICENSE`** — MIT with the template author's name unless you passed `--author`. Change it, or replace the file entirely.
- **`docs/`** — keep it. It describes code you now own, and it is the reason the next person can work on this. Update a feature doc in the same commit that changes the feature.
- **`.env`** — `make setup` copies `.env.example`. Do that after renaming, not before, or the `APP_NAME` edit lands only in the example.

Then the usual first run:

```bash
pnpm install
make setup && make up && make migrate && make seed
make check
```

## If you renamed too late

You installed first, then renamed. Nothing is broken, but the lockfile still names the old project:

```bash
pnpm install     # rewrites the importer entry
```

If you had already started the stack under the old compose project name, its volume is still there under the old prefix. Move the data or throw it away:

```bash
docker compose -p app down -v    # the old project, and its database
make up                          # the new one, empty
make migrate && make seed
```

## Conventions

- Rename before `pnpm install` and before the first `make up`.
- Run `--dry-run` first. It costs a second and it names every file it would touch.
- Never extend the script to walk `src/`. If a new identity string appears, add its exact path to the list.
- Delete the template-only sections of the README in the same commit as the rename, so the first commit of your project already reads like your project.

# Code quality

Four tools, one command, one CI job. Nothing here is optional and nothing here is a suggestion.

```bash
make check   # format:check → typecheck → lint → test
```

The order is deliberate: **fastest to fail first**. Prettier answers in seconds and the suite takes minutes; a misformatted file should not have to wait behind a database.

| Step           | Tool                          | Config                                |
| -------------- | ----------------------------- | ------------------------------------- |
| `format:check` | Prettier 3                    | `.prettierrc.json`, `.prettierignore` |
| `typecheck`    | TypeScript 5.9 / vue-tsc      | `tsconfig.*.json`                     |
| `lint`         | ESLint 9 (flat, type-checked) | `eslint.config.js`                    |
| `test`         | Vitest 4                      | per-package `vitest.config.ts`        |

## TypeScript

Four configs, because three environments genuinely differ:

| File                 | For          | Notable                                                                                    |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `tsconfig.base.json` | Everything   | `strict`, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| `tsconfig.node.json` | `apps/api`   | `types: ["node"]`                                                                          |
| `tsconfig.lib.json`  | `packages/*` | `types: []` — no DOM, no Node, because the contract must run in both                       |
| `tsconfig.vue.json`  | Frontends    | DOM, `jsxImportSource: vue`, **`exactOptionalPropertyTypes: false`**                       |

That last exception is the only one, and it is not laziness. Vue's runtime always hands `undefined` to an optional prop that was not passed, while libraries such as reka-ui declare them as `as?: AsTag` without `| undefined`. Forwarding any prop then fails to compile — not because the code is wrong, but because the two prop models disagree. The flag stays on where it earns its keep: the API and the shared contract.

`packages/ui` and the frontends are checked by **vue-tsc**, which can read types inside an SFC. Plain `tsc` cannot.

## ESLint

Flat config, `recommendedTypeChecked`, `eslint-plugin-vue` flat/recommended, `eslint-config-prettier` last so formatting rules never fight Prettier.

The rules added on top:

| Rule                                  | Why                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `consistent-type-imports` (inline)    | `verbatimModuleSyntax` needs type imports marked; the fixer does it for you                 |
| `no-floating-promises`                | An unawaited promise is a silent failure. Say `void` when you mean it                       |
| `no-misused-promises`                 | An `async` function passed where a `void` callback is expected                              |
| `no-console` (`warn`/`error` allowed) | The API logs through Pino; a `console.log` in a request path is a log line nobody can query |
| `eqeqeq` (`null` ignored)             | `== null` for "null or undefined" is idiomatic and stays legal                              |

Four narrow overrides exist, each documented in place. The one worth knowing:

```js
{ files: ['apps/*/src/main.ts'], rules: { '@typescript-eslint/no-unsafe-argument': 'off' } }
```

ESLint's TypeScript program cannot read types inside an SFC, so to it `App.vue` is an error type and every use is "unsafe". vue-tsc can read it, and vue-tsc still gates through `pnpm typecheck`. **The glob is `apps/*` on purpose** — a new frontend must not have to be registered here. Hardcoding two paths is directly hostile to the guide that tells you to add a third.

## Testing

`apps/api` runs against a **real PostgreSQL**. The reasoning is in [`../architecture.md`](../architecture.md#the-testing-contract); the operational facts are here:

```bash
make up          # Postgres must be running
make test        # or: pnpm -r test
```

| Package         | Suite                               | Needs a database |
| --------------- | ----------------------------------- | ---------------- |
| `@app/contract` | `rbac.test.ts`                      | no               |
| `@app/api`      | `tests/*.test.ts`                   | **yes**          |
| `@app/console`  | `lib/*.test.ts`, `stores/*.test.ts` | no               |

- **`fileParallelism: false`** for the API — one process, so suites cannot collide on the shared database.
- **`globalSetup` migrates `app_test`** before the first test, and **fails loudly** with the commands to fix it if Postgres is not there. It never skips. A green run that never ran is trusted, which makes it more dangerous than a red one.
- The test environment is written into `process.env` as well as `test.env`, because `globalSetup` runs in the main Vitest process where `test.env` does not reach. Without that line the migration step would connect to whatever `DATABASE_URL` sits in your `.env` and migrate your working database.

Try it: stop Docker and run `make test`. The failure should tell you exactly what to do.

## CI

`.github/workflows/ci.yml` — one job, `format:check → typecheck → lint → test`, against a `postgres:17-alpine` service.

- **One job, not four.** The gate takes a couple of minutes; splitting it means four checkouts and four `pnpm install`s — more wall-clock spent on setup than saved on parallelism, and four places to notice a failure instead of one.
- The service publishes **7332**, the same port as the development stack, so `apps/api/vitest.config.ts` needs no CI-only branch.
- `app_test` is created explicitly, because `docker/postgres/init/01-databases.sql` only runs for the compose stack.
- `concurrency` with `cancel-in-progress`: nobody reads the CI result of a commit that has been replaced.

## Dependencies

`.github/dependabot.yml` opens weekly PRs, **grouped**. Ten separate patch PRs cost ten CI runs and ten reviews of the same decision; one PR per ecosystem per week is a decision somebody actually makes. Majors arrive one at a time — a major is a changelog to read, not a checkbox.

`dependabot-auto-merge.yml` queues patch and minor updates with `gh pr merge --auto`, so GitHub holds them until the required checks are green. It needs **"Allow auto-merge"** in the repository settings and a branch protection rule making CI required. Without the second one, auto-merge means merge immediately — enable both or neither.

## Conventions

- `make check` passes before every commit. Not before every push — before every commit.
- Never add an ESLint disable comment without a sentence saying why on the line above.
- Never widen a rule for the whole repository to fix one file.
- New globs in `eslint.config.js` use `apps/*`, never a hardcoded app name.
- A test that needs a database is an integration test and lives in `apps/api/tests/`.
- Never make a suite skip when its dependency is missing. Fail, and say how to fix it.

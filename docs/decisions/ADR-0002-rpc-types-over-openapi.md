# ADR-0002 — RPC types over OpenAPI

- **Status:** accepted
- **Date:** 2026-08-15
- **Affects:** `apps/api/src/app.ts`, `apps/api/package.json`, `apps/console/src/lib/api.ts`, `apps/console/src/lib/models.ts`

## Context

The frontends need to know the shape of every response. In a TypeScript monorepo there are three ways to arrange that, and the wrong one is the one nobody notices going wrong.

**Write the types twice.** An `interface User` in the API and another in the console. It works on day one and it is wrong by the end of the first month — nothing connects them, so a field renamed on one side compiles cleanly on the other and fails at runtime in front of a user.

**Generate a client from OpenAPI.** The API describes itself, a generator emits a typed client, and the client is committed. Correct, tool-agnostic, and the industry default. It costs a schema-annotation layer on every route, a generator in the build, a generated directory in review diffs, and a **regeneration step** — which is exactly the step that gets skipped, leaving types that are confidently wrong.

**Infer the types from the API's source.** Hono's `hc<AppType>()` takes the type of the composed app and produces a fully typed client from it. No schema layer, no generator, no generated files, nothing to regenerate.

The third only works when the API's source is importable by the frontend. In a pnpm monorepo, it is.

## Decision

The frontends import `AppType` from the API and build their client with `hc<AppType>()`.

```ts
// apps/console/src/lib/api.ts
import type { AppType } from '@app/api'
import { hc } from 'hono/client'

export const api = hc<AppType>(import.meta.env.VITE_API_URL, {
  init: { credentials: 'include' },
})
```

Response types are **derived**, never declared:

```ts
export type User = InferResponseType<typeof api.users.$get>['users'][number]
```

Three things make this work, and each is load-bearing:

1. **`apps/api` exports `.` → `./src/app.ts`.** The frontend consumes TypeScript source, not a build artefact. There is no build step to be stale.
2. **`@app/api` is a `devDependency`** of every frontend. Only types cross the boundary; `hc` erases at compile time and no API code is bundled into the browser.
3. **Routes are `.route()`-chained in `app.ts`.** `AppType` is the type of the return value of that chain. This is the sharp edge — see below.

The console's `lib/models.ts` holds every derived type in one file, so the derivations are visible in one place rather than scattered through components.

## Consequences

**Renaming a route is a compile error in every app that called it.** Not a runtime 404 found by a user. This is the entire return on the decision and it is worth the rest of this section.

**A response field added to the API is available in the frontend immediately** — no regeneration, no PR to a generated directory, no drift window.

**Breaking the chain silently loses types.** `app.route('/x', xRoutes)` as a separate statement compiles, serves traffic correctly, and produces an `AppType` missing `/x`. Frontend calls to it degrade to `unknown` or `any` and stop being checked, with no error anywhere. It is the one failure mode of this approach and it has no diagnostic — which is why it is called out in `app.ts` itself, in [`../architecture.md`](../architecture.md#the-type-contract), and in the checklist of [`../guides/add-api-module.md`](../guides/add-api-module.md).

**The API's public surface is now a type, not a document.** There is no `openapi.json` to hand to somebody outside this repository. A partner integration, a public API, or a client written in another language all need something else.

**Typecheck time is coupled to the API.** `vue-tsc` in the console walks the API's types, so a large enough API is felt in the frontend's typecheck. At this size it is not measurable.

**It ties the frontends to Hono.** `hc` is Hono's client. Replacing the HTTP framework means replacing this mechanism.

## What would change this

Adding OpenAPI **alongside** this, not instead of it:

- **A public or partner-facing API.** External consumers need a document. `@hono/zod-openapi` can produce one from the Zod schemas the routes already validate with, at the cost of annotating those routes — pay it for the routes that face outward, not for all of them.
- **A client in another language.** Same answer.
- **A separately deployed frontend repository.** If a frontend stops living in this monorepo it can no longer import `AppType`, and generated types become the honest option. Publishing `@app/api`'s types to a private registry is the smaller change and should be tried first.

None of these require deleting `hc<AppType>()`. The internal frontends keep it; the document is generated for the people who are not in this repository.

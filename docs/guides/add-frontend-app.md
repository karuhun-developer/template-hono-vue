# Add a frontend app

A second Vue app — a storefront, a customer portal, a public site — in eleven steps.

**It touches nothing in `apps/api`.** That is the point of this guide, and the template is built for it: workspace membership is the glob `apps/*`, the CORS allowlist is one parsed list from `.env`, and the ESLint override that Vue entrypoints need is `apps/*/src/main.ts` rather than a hardcoded pair of paths. Adding a frontend is a new directory plus a `.env` edit.

This guide uses **`portal`** on **port 7302**. Substitute your own throughout.

## Before you start

Decide two things.

**Public or protected?** A public app (a marketing site, a storefront before sign-in) needs steps 1–9. A protected app — one with sign-in, a session and permission-aware navigation — also needs step 10, which is mostly copying four files from the console.

**A name and a port.** The name goes in three places (the directory, `@app/<name>`, `<NAME>_PORT`); the port goes in four, listed in step 8. Pick something unused: 7302, 7303, and so on.

## 1. Scaffold

```bash
cd /path/to/repo
mkdir -p apps/portal/src/{components,lib,pages,router,stores}
```

Do not run `create-vue`. It writes its own tsconfig, its own ESLint and its own Prettier setup, and you would then spend longer removing them than the files below take to write.

## 2. `apps/portal/package.json`

```json
{
  "name": "@app/portal",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Customer portal",
  "scripts": {
    "dev": "vite",
    "build": "vue-tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "vue-tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@app/contract": "workspace:*",
    "@app/ui": "workspace:*",
    "@lucide/vue": "^1.31.0",
    "hono": "^4.9.0",
    "pinia": "^4.0.0",
    "vue": "^3.5.41",
    "vue-router": "^5.2.0"
  },
  "devDependencies": {
    "@app/api": "workspace:*",
    "@tailwindcss/vite": "^4.3.0",
    "@vitejs/plugin-vue": "^6.0.0",
    "tailwindcss": "^4.3.0",
    "vite": "^8.2.0",
    "vitest": "^4.1.0",
    "vue-tsc": "^3.3.0"
  }
}
```

> **`@app/api` belongs in `devDependencies`.** Only its _types_ cross the boundary — `hc<AppType>()` erases at compile time and nothing from the API is bundled into the browser. Put it in `dependencies` and you have declared a runtime dependency on your server code from a browser app, which is a bundle waiting to happen.

`hono` is a real dependency: `hc` is the client, and it ships.

## 3. `apps/portal/tsconfig.json`

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "extends": "../../tsconfig.vue.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] },
    "types": ["vite/client", "node"]
  },
  "include": ["src/**/*.ts", "src/**/*.vue", "vite.config.ts", "vitest.config.ts", "env.d.ts"]
}
```

`node` is in `types` because `vite.config.ts` runs in Node, and because `AppType` is pulled straight from the source of `apps/api`, which uses Node APIs.

## 4. `apps/portal/vite.config.ts`

```ts
import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '')
  const port = Number(env.PORTAL_PORT ?? 7302)

  return {
    envDir: repoRoot,
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
  }
})
```

Two lines are load-bearing.

**`envDir: repoRoot` plus `loadEnv`** — one `.env` for the whole repository, not one per app. The API port, this app's port and `CORS_ORIGINS` have to agree with each other; once every app keeps its own copy of that agreement, it takes exactly one forgotten edit for a frontend to point at a different API than the one it is allowed to talk to.

**`strictPort: true`** — Vite's default is to quietly move to the next free port, and a moved port is no longer in `CORS_ORIGINS`. Failing to start is a much shorter debugging session than a preflight that fails for no visible reason.

## 5. `index.html`, `env.d.ts`, `main.ts`

`apps/portal/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Portal</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`apps/portal/env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

`apps/portal/src/main.ts`:

```ts
import { createPinia } from 'pinia'
import { createApp } from 'vue'

import App from '@/App.vue'
import { router } from '@/router'

import './styles.css'

createApp(App).use(createPinia()).use(router).mount('#app')
```

Add `App.vue` with `<RouterView />` in it, and a `src/router/index.ts` with at least one route.

## 6. `apps/portal/src/styles.css`

```css
@import '@app/ui/styles.css';

@source "../index.html";
@source "../src";
```

Tailwind v4 scans from the file that imports it, so the sources have to be named explicitly: your class names live in this app, the component classes live in `packages/ui`, and neither is found by scanning the other. Miss the `@source` lines and half your styles simply do not exist, with no error.

## 7. `apps/portal/src/lib/api.ts`

```ts
import type { AppType } from '@app/api'
import { hc } from 'hono/client'

export const api = hc<AppType>(import.meta.env.VITE_API_URL, {
  init: { credentials: 'include' },
})
```

`credentials: 'include'` is not optional if this app ever signs anybody in. The session is an `httpOnly` cookie, and in development the frontends and the API sit on different ports — which browsers treat as different origins, so the cookie is only sent when it is asked for explicitly.

Derive your types from it rather than declaring them:

```ts
export type Thing = InferResponseType<typeof api.things.$get>['items'][number]
```

## 8. Wire the environment

**`.env` and `.env.example`** — add the port, and append the origin:

```diff
 API_PORT=7300
 CONSOLE_PORT=7301
+PORTAL_PORT=7302
 POSTGRES_PORT=7332

-CORS_ORIGINS=http://localhost:7301
+CORS_ORIGINS=http://localhost:7301,http://localhost:7302
```

That is the whole API-side change. `apps/api/src/env.ts` parses the comma-separated list, normalises each entry to a bare origin, and `app.ts` hands it to `cors()`. **No file in `apps/api` is edited.**

Every place a port appears:

| File                         | What it holds                             | Edit it?                             |
| ---------------------------- | ----------------------------------------- | ------------------------------------ |
| `.env`                       | `PORTAL_PORT`, `CORS_ORIGINS`             | **yes**                              |
| `.env.example`               | the same, as documentation                | **yes**                              |
| `apps/portal/vite.config.ts` | the fallback in `env.PORTAL_PORT ?? 7302` | **yes** — keep the two numbers equal |
| `apps/api/src/env.ts`        | parses `CORS_ORIGINS`                     | no                                   |
| `apps/api/src/app.ts`        | passes it to `cors()`                     | no                                   |

An origin is **scheme + host + port only**. `env.ts` rejects a trailing path with a message telling you what to write instead, and rejects `'*'` outright in production — a wildcard with `credentials: true` is refused by browsers anyway, and failing at boot beats debugging a preflight.

## 9. Install

```bash
pnpm install
```

The `apps/*` glob in `pnpm-workspace.yaml` picks the new app up. There is nothing to register — not in the root `package.json` (`pnpm -r` covers every workspace member), and not in `eslint.config.js` (its Vue-entrypoint override is already `apps/*/src/main.ts`).

```bash
make dev    # api :7300 · console :7301 · portal :7302
```

## 10. Public or protected

**Public** — you are finished. Skip to step 11.

**Protected** — copy four files from `apps/console/src` and adjust:

| File                | Change                                                               |
| ------------------- | -------------------------------------------------------------------- |
| `stores/session.ts` | Usually nothing. `GET /auth/me` is the same everywhere               |
| `lib/access.ts`     | Keep `decideNavigation` and `safeRedirect`; drop what you do not use |
| `lib/api-error.ts`  | Nothing                                                              |
| `router/index.ts`   | Your routes, with the same `beforeEach` shape                        |

Then add a sign-in page (`LoginPage.vue` is a reasonable starting point) and keep the two rules:

- `meta.public` is the exception; **the default is signed in required**.
- `meta.permission` on a route mirrors the `requirePermission()` on the endpoint it uses.

> **This is not enforcement.** Copying the guard gives the new app the same UX as the console — nobody is offered a link that ends in a 403. What actually protects the data is `requirePermission()` in `apps/api`, and it protects the new app for free because it was never about the frontend. If the portal calls an endpoint that has no guard, adding a guard here changes nothing.

Sessions are shared: the cookie is set for the whole host, so somebody signed into the console at `localhost:7301` is signed in at `localhost:7302` too. In production, put both under one apex domain — `SameSite=Lax` then covers both without any change.

## 11. Checklist

- [ ] `apps/portal/package.json` — `@app/api` in `devDependencies`
- [ ] `tsconfig.json` extends `../../tsconfig.vue.json`
- [ ] `vite.config.ts` — `envDir: repoRoot`, `strictPort: true`, the port matching `.env`
- [ ] `styles.css` — `@import '@app/ui/styles.css'` and both `@source` lines
- [ ] `lib/api.ts` — `credentials: 'include'`
- [ ] `.env` **and** `.env.example` — `PORTAL_PORT` added, origin appended to `CORS_ORIGINS`
- [ ] `pnpm install`
- [ ] `make dev` — all three apps start, and no port moved
- [ ] A request from the new app reaches the API without a CORS error
- [ ] `make check` — format, typecheck, lint and tests all green
- [ ] `CHANGELOG.md` — an entry under `## [Unreleased] → Added`

## Troubleshooting

**`Access to fetch ... has been blocked by CORS policy`**
The origin is not in `CORS_ORIGINS`. Check the browser's `Origin` header against the value in `.env` character for character — `http` vs `https`, and the port. Restart the API afterwards: the environment is parsed once at boot.

**The request succeeds but the session is never there**
`credentials: 'include'` is missing from `lib/api.ts`, or the API's `cors()` is not returning `credentials: true` for this origin — which is what happens when the origin is not on the list. Look for `Access-Control-Allow-Credentials: true` in the response headers.

**`Cannot find module '@app/api'`**
`pnpm install` has not run since you created the `package.json`, or the dependency is missing from it. Both are fixed by adding it and running `pnpm install` from the repository root.

**`Port 7302 is already in use`**
That is `strictPort` doing its job. Free the port, or choose another — and change it in `.env`, `.env.example`, `vite.config.ts` and `CORS_ORIGINS`.

**Tailwind classes have no effect**
The `@source` lines are missing from `styles.css`, or `styles.css` is not imported by `main.ts`.

**`vue-tsc` reports errors inside `.vue` files that ESLint does not**
Correct, and expected. ESLint's TypeScript program cannot read types inside an SFC. `vue-tsc` is the gate; trust it.

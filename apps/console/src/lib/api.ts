import type { AppType } from '@app/api'
import { hc } from 'hono/client'

/**
 * The end-to-end typed API client.
 *
 * `AppType` comes straight from `apps/api/src/app.ts` — no codegen, no OpenAPI, no
 * hand-written response types. Renaming a route or changing what it returns becomes a
 * TypeScript error here, at build time, rather than an `undefined` on a screen.
 *
 * `@app/api` is a **devDependency**: only its types cross the boundary, and nothing from
 * the API is bundled into the browser.
 *
 * `credentials: 'include'` is not optional. The session is an `httpOnly` cookie, and in
 * development the console and the API sit on different ports — which browsers treat as
 * different origins, so the cookie is only sent when it is asked for explicitly.
 */
export const api = hc<AppType>(import.meta.env.VITE_API_URL, {
  init: { credentials: 'include' },
})

# Console shell

The Vue side: how a page gets its data, how the session is known, and what happens on the way to a route.

| Concern                 | File                                    |
| ----------------------- | --------------------------------------- |
| Typed API client        | `apps/console/src/lib/api.ts`           |
| Response types          | `apps/console/src/lib/models.ts`        |
| Error reading           | `apps/console/src/lib/api-error.ts`     |
| Session                 | `apps/console/src/stores/session.ts`    |
| Navigation rules (pure) | `apps/console/src/lib/access.ts`        |
| Routes and the guard    | `apps/console/src/router/index.ts`      |
| Menu items              | `apps/console/src/lib/nav.ts`           |
| Layout                  | `apps/console/src/layouts/AppShell.vue` |

## Routes

| Path                 | Page                 | `meta`                     |
| -------------------- | -------------------- | -------------------------- |
| `/login`             | Sign in              | `public`                   |
| `/invitation/:token` | Accept an invitation | `public`                   |
| `/forbidden`         | Access denied        | `public`                   |
| `/`                  | Overview             | —                          |
| `/users`             | Users                | `permission: 'user.read'`  |
| `/roles`             | Roles                | `permission: 'role.read'`  |
| `/audit-log`         | Audit log            | `permission: 'audit.read'` |
| `/:pathMatch(.*)*`   | Not found            | `public`                   |

**The default is "signed in required".** `meta.public` is the exception, and it is granted only to the sign-in page, the invitation page and the two error pages. A new route that forgets to say anything is protected, which is the right way round for a default to fail.

A 404 renders a page rather than redirecting home. A redirect makes a typo in the address bar look like the application deciding to go somewhere else, and it hides broken links instead of reporting them.

## The guard

```ts
router.beforeEach(async (to) => {
  const session = useSessionStore()
  await session.ensureReady()

  const decision = decideNavigation(
    { authenticated: session.isAuthenticated, permissions: session.permissions },
    { requiresAuth: to.meta.public !== true, permission: to.meta.permission },
    to.fullPath,
  )
  // switch over decision.kind
})
```

Two things are worth noticing.

**`ensureReady()` holds the first navigation** until `GET /auth/me` has answered. The alternative — render, then bounce to the sign-in page when the answer arrives — makes every reload flicker: shell, gone, sign-in form. Waiting one request is more honest.

**The decision is a pure function.** `decideNavigation()` lives in `lib/access.ts`, returns `'allow' | 'login' | 'forbidden' | 'home'`, and is unit-tested without assembling a router. `beforeEach` is a `switch` over its result. Rules scattered across early returns in a guard are rules nobody can test.

`{ kind: 'login', next }` keeps where somebody was heading. A session that expires mid-task must not cost them the walk back through the menu. The `next` value goes through `safeRedirect()` on the way back out, which accepts internal paths only — `//evil.example` and `https://…` are both off-site redirects triggered through a link.

> **None of this is security.** See rule 6 in [`../architecture.md`](../architecture.md). `meta.permission` mirrors the API's `requirePermission()` so a menu item never leads to a wall of 403s. The wall is what actually protects the data.

## The session store

`GET /auth/me` is the single source of truth for who is signed in and what they hold. The console stores **nothing** about identity in `localStorage`: the token is in an `httpOnly` cookie JavaScript cannot read, and a copy of the permissions in local storage is a stale copy that keeps saying "allowed" after access has been revoked.

```ts
inflight ??= fetchMe().finally(() => {
  inflight = null
})
```

The route guard and the components can both ask for the session while booting. Without that holder, the second caller sees status `loading`, concludes "not signed in", and throws somebody at the sign-in page with a perfectly good session.

A `401` from `/auth/me` is **not** a failure — it is the correct answer to "am I still signed in?". Only a network error is treated as one, and even that ends as `anonymous`, so the console never hangs on an empty screen.

After signing in the store calls `bootstrap()` rather than using the login response body: `/auth/me` is what answers with the permissions, so the shell is never rendered from half the information.

## Types come from the API

```ts
export type UserSummary = InferResponseType<typeof api.users.$get>['items'][number]
```

Not one type in `models.ts` is written by hand. A column that disappears from the backend becomes a TypeScript error in the page that used it, rather than an `undefined` somebody notices on screen a week later.

A `Date` in the API arrives here as a `string`, and the type says so. That is what `JSON.stringify` produces, and pretending the wire carries `Date` objects only moves the surprise to runtime.

## Errors

Pages never call `response.json()` and guess. `readApiError(response)` returns an `ApiFailure` — `{ code, message, status, details? }` — whatever came back, including an HTML error page from a reverse proxy or nothing at all from a dropped connection. `networkFailure(error)` covers the `catch`, with `status: 0` meaning the request never arrived.

Render it with `<FailureAlert :failure="failure" />`. Branch on `failure.code`, never on `failure.message`.

## The layout

`AppShell.vue` is one `NAV_ITEMS` list rendered twice: a sidebar at `md` and above (a mouse), a bottom bar below it (thumbs). Not two components copying each other — adding a menu item in two places is adding it in one place and forgetting the other.

`visibleItems()` filters the list by what the session holds, using the same `hasPermission()` the guard uses. Any difference between the two shows up immediately as a menu item that leads to the access-denied page.

## Adding a page

1. Create `src/pages/ThingPage.vue`.
2. Add the route as a child of the `AppShell` record, with `meta: { title, permission }`.
3. Add the `NAV_ITEMS` entry — **in the same commit**. A menu item pointing at an empty screen reads as a broken feature rather than one that has not arrived.
4. Derive the page's types in `lib/models.ts` from `AppType`.
5. Use `readApiError` / `networkFailure` and a `FailureAlert`. Skeletons while loading, an empty-state card when there is nothing.
6. Confirm the API route carries the matching `requirePermission()`. That is the part that matters.

## Conventions

- `meta.permission` always equals the permission on the matching endpoint.
- Never hand-write a response type. Derive it.
- Keep decisions in pure functions in `lib/`, and keep components thin enough to be uninteresting.
- One `NAV_ITEMS`. Never a second nav list for a second breakpoint.
- Every failed request renders a message. A silent failure is worse than an error.
- Colours come from `@app/ui` tokens. A one-off hex value in a page is a token that should have been added to the package.

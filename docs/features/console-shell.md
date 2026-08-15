# Console shell

The Vue side: how a page gets its data, how the session is known, and what happens on the way to a route.

| Concern                 | File                                         |
| ----------------------- | -------------------------------------------- |
| Typed API client        | `apps/console/src/lib/api.ts`                |
| Response types          | `apps/console/src/lib/models.ts`             |
| Error reading           | `apps/console/src/lib/api-error.ts`          |
| Session                 | `apps/console/src/stores/session.ts`         |
| Navigation rules (pure) | `apps/console/src/lib/access.ts`             |
| Routes and the guard    | `apps/console/src/router/index.ts`           |
| Menu items              | `apps/console/src/lib/nav.ts`                |
| Layout (signed in)      | `apps/console/src/layouts/AppShell.vue`      |
| Layout (signed out)     | `apps/console/src/layouts/AuthLayout.vue`    |
| The navigation itself   | `apps/console/src/components/AppSidebar.vue` |
| The account menu        | `apps/console/src/components/NavUser.vue`    |
| Theme state             | `apps/console/src/composables/useTheme.ts`   |

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

```text
SidebarProvider
├── AppSidebar        brand · NAV_GROUPS · NavUser
└── SidebarInset
    ├── header        SidebarTrigger · route.meta.title · ThemeToggle
    └── RouterView
```

**One navigation, one component tree.** Below `md`, `Sidebar` renders its own children inside the `Sheet` from `packages/ui` — the same markup, in a drawer. The earlier shell had a sidebar _and_ a bottom bar, each rendering the list its own way, which held up exactly until the first nested item arrived that four thumb-sized tabs could not express.

The header title is `route.meta.title`, the same string the tab title is built from, so a page is named once.

`SidebarProvider` keeps its open/closed state in `localStorage` and answers `Ctrl/Cmd+B`. Collapsed, the sidebar is an icon rail and every button grows a tooltip — a rail of unlabelled glyphs is a puzzle.

## Navigation

`lib/nav.ts` holds `NAV_GROUPS`: groups of items, an item optionally carrying `children` and a `permission`.

```ts
export const NAV_GROUPS: readonly NavGroup[] = [
  { label: 'General', items: [{ to: '/users', label: 'Users', icon: Users, permission: 'user.read' }] },
  …
]
```

An item with `children` is a disclosure, not a destination: it expands, and its `to` is the prefix that marks the group active. There are two groups rather than the six an admin template usually ships with, because **an item is added in the same commit as its page** — a menu entry leading to an empty screen reads as a broken feature.

`visibleGroups()` in `lib/access.ts` filters items by `hasPermission()` — the same function the route guard uses — then drops any group left empty and any parent left with no children. Without that last step, somebody lacking `audit.read` would see the heading "Audit" over nothing and conclude the page failed to load. Any drift between this filter and the guard shows up at once as a menu item that leads to the access-denied page.

`NavUser.vue` is the footer button: avatar, name, email, and a dropdown holding the account details and **Sign out**.

## Theme

`ThemeToggle` sits in the header and in `AuthLayout`, because signing in at night should not start with a white screen. The mechanism — tokens, `.dark`, `useTheme()` and the pre-paint inline script — is [`theming.md`](theming.md).

## Adding a page

1. Create `src/pages/ThingPage.vue`.
2. Add the route as a child of the `AppShell` record, with `meta: { title, permission }`.
3. Add the `NAV_GROUPS` entry — **in the same commit**, in the group it belongs to, or a new group if it starts one.
4. Derive the page's types in `lib/models.ts` from `AppType`.
5. Use `readApiError` / `networkFailure` and a `FailureAlert`. Skeletons while loading, an empty state that says why it is empty.
6. If it is a list, it is a `DataTable` — see [`data-table.md`](data-table.md).
7. Confirm the API route carries the matching `requirePermission()`. That is the part that matters.

## Conventions

- `meta.permission` always equals the permission on the matching endpoint.
- Never hand-write a response type. Derive it.
- Keep decisions in pure functions in `lib/`, and keep components thin enough to be uninteresting.
- One `NAV_GROUPS`. Never a second nav list for a second breakpoint.
- Every failed request renders a message. A silent failure is worse than an error.
- Colours come from `@app/ui` tokens. A one-off hex value in a page is a token that should have been added to the package.

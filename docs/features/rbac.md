# Role-based access control

A permission catalog defined in code, roles stored in the database, and one enforcement point: `requirePermission()` on the route.

| Concern                                   | File                                               |
| ----------------------------------------- | -------------------------------------------------- |
| The catalog and the system roles          | `packages/contract/src/rbac.ts`                    |
| Loading what a user holds                 | `apps/api/src/modules/rbac/rbac.repo.ts`           |
| Provisioning (catalog sync, system roles) | `apps/api/src/modules/rbac/rbac.service.ts`        |
| Enforcement                               | `apps/api/src/middleware/rbac.ts`                  |
| Role endpoints and the grantable rule     | `apps/api/src/modules/roles/`                      |
| Tables                                    | `apps/api/src/db/schema/rbac.ts`                   |
| The console's matrix                      | `apps/console/src/components/PermissionMatrix.vue` |

## The catalog

Fifteen keys in four groups. Deliberately small: **a permission with no route behind it is worse than a missing one**, because nobody can tell whether it is wired up or aspirational.

| Key                   | Group      | Label                            |
| --------------------- | ---------- | -------------------------------- |
| `user.read`           | users      | View users                       |
| `user.invite`         | users      | Invite users                     |
| `user.create`         | users      | Create users with a password     |
| `user.update`         | users      | Edit users and their roles       |
| `user.disable`        | users      | Enable and disable users         |
| `user.delete`         | users      | Delete and restore users         |
| `user.reset_password` | users      | Reset another user's password    |
| `role.read`           | roles      | View roles                       |
| `role.manage`         | roles      | Create, edit and delete roles    |
| `audit.read`          | audit      | View the audit log               |
| `job.read`            | operations | View background jobs             |
| `job.manage`          | operations | Retry and cancel background jobs |
| `mail.read`           | operations | View the mail log                |
| `schedule.read`       | operations | View scheduled jobs              |
| `schedule.run`        | operations | Run a scheduled job now          |

Keys are named `<domain>.<action>`, and **a dangerous verb gets its own key**. If "edit a user" and "disable a user" shared one, the only way to let somebody fix a typo in a name would be to also let them lock people out.

The same reasoning splits the two ways an account can begin. `user.invite` hands out a link and the person chooses their own password; `user.create` sets one on their behalf. And `user.reset_password` is not part of `user.update`, because starting a credential flow on somebody else's account is not something the permission for correcting a name should quietly also do.

The operations group splits the same way, twice. `job.read` answers a support question — "did that invitation email ever go out" — while `job.manage` re-runs code against live data or throws queued work away. `schedule.read` answers "did last night's cleanup run", while `schedule.run` starts it at a moment nobody planned for.

`mail.read` has no `mail.manage` beside it because there is nothing to manage: the mail log is read-only by design, and the reasons are in [mail](mail.md#endpoints).

`PermissionKey` is derived from the array, so a typo in a `requirePermission('user.raed')` call is a compile error rather than a route nobody can reach.

## System roles

Created by `make seed`, marked `is_system`, and editable but not deletable.

| Role              | Permissions                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| **Owner**         | `'*'` — the whole catalog, so a new permission reaches it automatically |
| **Administrator** | `user.read`, `user.invite`, `user.update`, `role.read`, `role.manage`   |
| **Member**        | `user.read`                                                             |

The split between owner and admin is not decorative. **The admin deliberately holds none of `user.create`, `user.disable`, `user.delete`, `user.reset_password`, `audit.read`, `job.read`, `job.manage`, `mail.read`, `schedule.read` or `schedule.run`**, which makes the grantable rule visible the first time you sign in as one: those checkboxes render disabled, and opening the Owner role gives a locked matrix. A template that only _contains_ the rule teaches nothing; this one demonstrates it in about thirty seconds.

> **This is the whole "superadmin" story.** There is no `isSuperadmin` flag anywhere in this codebase, and an owner-only capability is nothing more than a key that is in the catalog and absent from the Administrator role. `rbac.test.ts` asserts that list, because widening the admin role is exactly the change that would turn every administrator into a superadmin without anybody noticing.

`'*'` is expanded by `resolveRolePermissions()` at seed time and topped up by `topUpWildcardRoles()` afterwards, so adding a permission to the catalog and re-running `make seed` grants it to every wildcard role without a migration.

## Tables

```text
permissions        key (PK) · "group" · label
roles              id · key (unique) · name · description · is_system
role_permissions   (role_id, permission_key)     PK · CASCADE on both
user_roles         (user_id, role_id)            PK · CASCADE on user, RESTRICT on role
```

`user_roles.role_id` is `ON DELETE RESTRICT` on purpose. "You cannot delete a role that is in use" is checked in the service so the caller gets a friendly `409` — and enforced by the constraint so the race between the check and the delete cannot lose anybody their access.

`group` is a reserved word in SQL and is always quoted. `permissions.key` is the primary key rather than a surrogate id: the key _is_ the identity, and it lets `role_permissions` be read without a join.

## Enforcement

```ts
export const userRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())
  .get('/', requirePermission('user.read'), zValidator('query', listUsersQuery, hook), handler)
  .post('/:id/status', requirePermission('user.disable'), ..., handler)
```

- `requireAuth()` loads the permissions **once per request** into `c.get('access')`. `requirePermission()` then stays synchronous, and a route performing five checks still makes one query.
- **Several permissions mean ALL of them**, not any. "Any" is a dangerous default: a route needing `user.disable` and `audit.read` would let through whoever holds the easier one. Anything that genuinely wants "any" says so with `requireAnyPermission()`.
- A permission key in the database that has since disappeared from the code catalog is **ignored** by `loadAccess()`. An unrecognised permission must not grant access to anything.

`AccessContext` is a flat `ReadonlySet<PermissionKey>`, because in a single-tenant application there is exactly one scope. It is also the type that has to grow a second dimension if you ever add tenants — see [`../guides/add-multi-tenancy.md`](../guides/add-multi-tenancy.md).

## The grantable rule

The interesting part. It runs in **two directions**, both in `apps/api/src/modules/roles/roles.service.ts`:

**1. You cannot add a permission you do not hold.** `assertGrantable(access, wanted)` throws `403` when the payload contains a key the caller lacks. Without it, an admin with `role.manage` could mint a role holding `user.disable`, assign it to themselves, and have escalated in two requests.

**2. You cannot remove one you do not hold either.**

```ts
const mine = allPermissions(access)
const removedBeyondReach = before.permissions.filter(
  (key) => !wanted.includes(key) && !mine.includes(key),
)
if (removedBeyondReach.length > 0) throw forbidden(...)
```

Direction 2 is the one that gets forgotten. The console renders those ticks disabled, so the checkbox cannot be cleared by hand — but a payload that simply omits them is a client ignoring the UI, and the effect would be an administrator quietly stripping `audit.read` from the Owner role.

### Watch it happen

Sign in as `admin@example.com` and open **Roles**:

| What you do                                                      | What you see                                     | Why                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| Create a role                                                    | `user.disable` and `audit.read` render disabled  | You cannot grant what you do not hold — direction 1 |
| Open **Owner**                                                   | The whole matrix is locked, with a note          | Owner holds two keys you lack — direction 2         |
| `PATCH /roles/:id` with the Owner permissions minus `audit.read` | `403` with `details.permissions: ['audit.read']` | Direction 2, at the API, where it counts            |

`RoleFormDialog.vue` omits the `permissions` key entirely from a locked role's payload, so name and description can still be edited. The client mirror of the rule is `beyondReach()` in `apps/console/src/lib/access.ts` — a pure function with its own unit tests.

## The console side

`GET /roles/permissions` answers with the catalog **and** what the caller holds, in one response:

```ts
{ groups: [{ key: 'users', permissions: [{ key, label }] }], granted: PermissionKey[] }
```

Both, because the matrix cannot be rendered correctly from either half alone: the first decides the rows, the second decides which ticks may be touched.

`GET /roles` is paged like the user list — `page`, `perPage` (1–100, default 20), `sort` (`name` · `key` · `usedBy`) and `order` — and answers `{ items, total, page, perPage }`. `usedBy` is the number of accounts holding the role, and it is what the Delete action checks: a role in use is not deletable.

> **The 100-role ceiling has one consequence worth knowing.** The user page needs the _whole_ role list — for the Role facet and for `UserFormDialog`'s checkboxes — so `useRoleOptions()` asks for `perPage: '100'` explicitly. Past a hundred roles that checkbox list stops being usable anyway and should become a search-picker. That is the point at which to change it, not before.

> **None of the frontend is enforcement.** `hasPermission()`, the hidden nav items, the disabled checkboxes and `router.beforeEach` exist so nobody is offered a link that ends in a 403. **Test the real thing:** sign in as a member, open DevTools, and run
> `await fetch('http://localhost:7300/roles', { credentials: 'include' })`.
> A `403` means the middleware is doing its job. A `200` means the route is missing its guard and the console has been decoration all along.

## Adding a permission

1. Add the key to `PERMISSIONS` in `packages/contract/src/rbac.ts`, in the right group with a label a non-developer can read.
2. Add it to `requirePermission()` on the route that needs it, in the same commit.
3. Consider whether a system role should hold it. Wildcard roles get it for free.
4. `make seed` — `syncPermissionCatalog()` writes it, `topUpWildcardRoles()` grants it to Owner.
5. If the console gains a page for it, add `meta.permission` on the route and the `permission` on the `NAV_GROUPS` entry.
6. Write the test that asserts a `403` without it.

Removing one works in reverse, and `syncPermissionCatalog()` will warn about a key still in the database that no longer exists in code — it does not delete it. Deleting rows in a table that grants access is a migration you write on purpose.

## Conventions

- The catalog lives in `@app/contract` and nowhere else. Never type a permission key as a bare string.
- The check goes **on the route**, never inside a service. A route that names no permission should look suspicious at a glance.
- Several permissions on one `requirePermission()` means all of them. Use `requireAnyPermission()` when you mean any, and say why.
- Never add a key without the route that checks it, in the same commit.
- Any endpoint that writes permissions calls `assertGrantable`, and any endpoint that replaces them checks the removal direction too.
- Access-control tests are integration tests. Asserting that a mock returns `false` proves nothing.

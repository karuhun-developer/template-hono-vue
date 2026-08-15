# User management

Inviting people, creating them outright, editing them and their roles, and switching accounts on and off. Everything here writes an audit entry.

| Concern   | File                                          |
| --------- | --------------------------------------------- |
| Endpoints | `apps/api/src/modules/users/users.routes.ts`  |
| Rules     | `apps/api/src/modules/users/users.service.ts` |
| Queries   | `apps/api/src/modules/users/users.repo.ts`    |
| Table     | `apps/api/src/db/schema/identity.ts`          |
| Console   | `apps/console/src/pages/UsersPage.vue`        |

## Endpoints

| Method  | Path                | Permission     | Does                                           |
| ------- | ------------------- | -------------- | ---------------------------------------------- |
| `GET`   | `/users`            | `user.read`    | List — paged, sorted, filtered (see below)     |
| `GET`   | `/users/:id`        | `user.read`    | One user, in the shape a list row has          |
| `POST`  | `/users`            | `user.invite`  | Create as `invited`, return the token **once** |
| `POST`  | `/users/create`     | `user.create`  | Create as `active`, with a password            |
| `POST`  | `/users/:id/invite` | `user.invite`  | Re-issue the token; the previous link dies     |
| `PATCH` | `/users/:id`        | `user.update`  | Name and roles                                 |
| `POST`  | `/users/:id/status` | `user.disable` | `active` ⇄ `disabled`                          |

Status has **its own endpoint and its own permission** rather than being a field on `PATCH /users/:id`. Locking somebody out is not the same kind of act as correcting the spelling of their name, and the audit entry it writes should not depend on anyone remembering to look at a `status` key in a request body.

## Two ways an account begins

`POST /users` invites: the account lands `invited` with no password, and the person chooses their own by following the link. `POST /users/create` sets one on their behalf and the account lands `active`, ready to sign in.

They are **two routes with two permissions**, not one endpoint with a mode, and both halves of that sentence are load-bearing:

- The permission belongs on the route, beside the method and the path. One endpoint carrying both would need `requireAnyPermission` plus an `if` about the caller inside the handler — and a 403 test that can no longer say which capability it is asserting.
- Choosing somebody else's password is a different act from mailing them a link, so `user.create` is owner-only while `user.invite` is not. An administrator can bring people in all day without ever holding a credential that is not theirs.

`password` on `POST /users/create` is the **same `newPassword` rule** the invitation flow uses when the invited person picks theirs — one answer in this codebase to "what counts as an acceptable password", so raising the minimum raises it everywhere. The hash is computed **before the transaction opens**: argon2id is deliberately ~50 ms of CPU, and nothing in it depends on anything the transaction reads, so holding a pooled connection across it buys nothing.

Both routes run `assertRolesGrantable()` first, for the reason in the next section. Leaving it off `create` would make `user.create` mean "may become owner" just as surely as leaving it off `invite`.

## The lifecycle

```text
                POST /users                    POST /users/create
                     │                                 │
                     ▼                                 ▼
   ┌────────────┐  accept invitation   ┌───────────┐
   │  invited   │ ───────────────────► │  active   │
   └────────────┘  (sets first password)└───────────┘
         │                              │        ▲
         │ POST /users/:id/invite       │        │
         │ (new token, old link dies)   │ status │ status
         ▼                              ▼        │
   ┌────────────┐                  ┌────────────┐│
   │  invited   │                  │  disabled  ├┘
   └────────────┘                  └────────────┘
                                          │
                                    deleted_at (soft delete)
```

- **`invited` → `active`** happens only by accepting the invitation. `POST /users/:id/status` with `active` on an invited account is refused with _"This invitation has not been accepted yet — re-send it instead."_ Flipping the status directly would activate an account with a null password, which is an account nobody can sign into.
- **`disabled`** is reversible and leaves everything intact. It is the answer to "somebody left", not a delete.
- **`deleted_at`** exists on the table but no endpoint sets it. A person who leaves is still named by old audit entries, so the row has to stay referable — and deciding when a row may truly go is a policy question your project answers, not a starter.
- An invitation lives **72 hours**: long enough to survive a weekend, short enough that a link left in a chat history does not work forever.

## The two rules that are not queries

**1. You cannot hand out a role you could not grant yourself.** `assertRolesGrantable()` expands each requested role into its permissions and runs them through `assertGrantable()` — the same check the roles module applies from the other side. Without it, `user.invite` quietly means "may become owner": create an account, give it the Owner role, sign in as it.

It applies to inviting, to creating **and** to editing, because the escalation works from every one of those directions.

**2. Nobody can disable their own account.** The button that would undo it is behind the access they just took away from themselves. The API refuses with a `400`; the console hides the button on your own row, so the message is a backstop rather than the primary experience.

## Disabling kills sessions on the next request

There is no revocation sweep, and there is nothing to remember. `findLiveSession()` joins `users` with `status = 'active' AND deleted_at IS NULL`, so a disabled person's next request finds no live session, gets a `401`, and the console sends them to the sign-in page.

One condition in SQL, holding for every code path, beats a revocation pass that some future endpoint forgets to call.

## Invitation tokens

`POST /users` and `POST /users/:id/invite` return `inviteToken` **in that response only**. What is stored is its SHA-256 hash, under a partial unique index, so a user has at most one outstanding invitation.

The console renders `<origin>/invitation/<token>` in `InviteTokenDialog.vue`, which:

- blocks Escape and outside-click, because closing it loses a value that cannot be fetched again;
- falls back to a selectable text box when the clipboard is refused — over plain HTTP on a non-localhost origin it always will be.

> **When you wire up email**, send the link from the service where the token is issued and stop returning `inviteToken` in the response body. Everything else stays as it is.

## The list

```text
GET /users?q=ada&status=active&status=invited&roleId=…&page=2&perPage=10&sort=email&order=desc
    -> { "items": [ … ], "total": 34, "page": 2, "perPage": 10 }
```

| Parameter | Takes                                                     |
| --------- | --------------------------------------------------------- |
| `q`       | Matched against the name and the email                    |
| `status`  | `invited` · `active` · `disabled` — **repeatable**        |
| `roleId`  | Anyone holding any of these roles — **repeatable**        |
| `page`    | From 1, default 1                                         |
| `perPage` | 1–100, default 10                                         |
| `sort`    | `name` · `email` · `status` · `lastLoginAt` · `createdAt` |
| `order`   | `asc` · `desc`                                            |

**Repeatable** means the parameter given more than once is read as a set (`?status=active&status=invited`), which is what lets the console's faceted filters tick more than one box. `repeatable()` lives in `apps/api/src/lib/query.ts`; a single value still parses exactly as before, so existing links keep working.

`sort` is an **enum**, and that is the security story of this endpoint: a column name arriving as text and reaching an `ORDER BY` is an injection point, so the accepted orderings are written down in the schema and mapped to real columns in the repository. Nothing else can get near the query.

`perPage` is capped at 100 for the same reason — the ceiling is what stops `?perPage=100000` from turning one request into a full table read.

`total` is a `count(*)` over the **same `where`**, run alongside the page in one `Promise.all`, so the pager's "34 results" always refers to the filtered list. Filtering by `roleId` uses a subquery rather than a join over `user_roles`: a join would repeat a user once per role and inflate that count.

The console debounces the search by 300 ms — enough that typing "administrator" is one request rather than thirteen, short enough that it still feels immediate — and resets `page` to 1 whenever a filter changes, since page 4 of a narrower list is rarely where anybody meant to be.

`useRoleOptions()` failing does not fail the page: the list is still readable, and only the role filter is unavailable. A secondary request should not take the primary content down with it.

## Conventions

- Any change to an account writes an audit entry, inside the same transaction. `diffFields()` records the changed columns only.
- A dangerous verb gets its own endpoint and its own permission.
- Guard clauses first, transaction second. Everything inside `db.transaction` should already be known to be legal.
- After a write, read the row back **through the transaction handle** and return that — never the object you assembled in memory. Defaults and triggers are part of the answer.
- Uniqueness gets a specific message here (`conflict`), unlike on the sign-in path. Whoever is asking is already inside the application and entitled to know who else is.

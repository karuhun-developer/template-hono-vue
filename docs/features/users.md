# User management

Inviting people, creating them outright, editing them and their roles, switching accounts on and off, resetting their passwords, and removing and restoring them. Everything here writes an audit entry.

| Concern   | File                                          |
| --------- | --------------------------------------------- |
| Endpoints | `apps/api/src/modules/users/users.routes.ts`  |
| Rules     | `apps/api/src/modules/users/users.service.ts` |
| Queries   | `apps/api/src/modules/users/users.repo.ts`    |
| Table     | `apps/api/src/db/schema/identity.ts`          |
| Console   | `apps/console/src/features/users/`            |

## Endpoints

| Method   | Path                        | Permission            | Does                                         |
| -------- | --------------------------- | --------------------- | -------------------------------------------- |
| `GET`    | `/users`                    | `user.read`           | List — paged, sorted, filtered (see below)   |
| `GET`    | `/users/:id`                | `user.read`           | One user, in the shape a list row has        |
| `POST`   | `/users`                    | `user.invite`         | Create as `invited`, email the invitation    |
| `POST`   | `/users/create`             | `user.create`         | Create as `active`, with a password          |
| `POST`   | `/users/:id/invite`         | `user.invite`         | Re-issue and re-send; the previous link dies |
| `PATCH`  | `/users/:id`                | `user.update`         | Name and roles                               |
| `POST`   | `/users/:id/status`         | `user.disable`        | `active` ⇄ `disabled`                        |
| `DELETE` | `/users/:id`                | `user.delete`         | Soft delete — sets `deleted_at`              |
| `POST`   | `/users/:id/restore`        | `user.delete`         | Clears it again                              |
| `POST`   | `/users/:id/reset-password` | `user.reset_password` | Issue `rst_…` and email the link             |

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
      POST /users                          POST /users/create
           │                                        │
           ▼          accept invitation             ▼
    ┌────────────┐  (sets first password)   ┌────────────┐
    │  invited   │ ───────────────────────► │   active   │
    └────────────┘                          └────────────┘
           │                                   │      ▲
           │ POST /users/:id/invite            │      │
           │ (new token, old link dies)        │ status│ status
           ▼                                   ▼      │
    ┌────────────┐                          ┌────────────┐
    │  invited   │                          │  disabled  │
    └────────────┘                          └────────────┘
           └───────────────────┬───────────────────┘
                               │  DELETE /users/:id
                               ▼  POST /users/:id/restore
                     ┌───────────────────────┐
                     │   deleted_at is set   │
                     └───────────────────────┘
```

- **`invited` → `active`** happens only by accepting the invitation. `POST /users/:id/status` with `active` on an invited account is refused with _"This invitation has not been accepted yet — re-send it instead."_ Flipping the status directly would activate an account with a null password, which is an account nobody can sign into.
- **`disabled`** is reversible and leaves everything intact. It is the answer to "somebody left", not a delete.
- **`deleted_at`** is set by `DELETE /users/:id` and cleared by its mirror. The row never actually goes: a person who left is still named by old audit entries, and `user_roles.role_id` is `ON DELETE RESTRICT` on purpose. Deciding when a row may truly be purged is a retention policy your project writes, not one a starter answers.
- An invitation lives **72 hours**: long enough to survive a weekend, short enough that a link left in a chat history does not work forever.

## Resetting somebody else's password

`POST /users/:id/reset-password` is the counterpart to `POST /auth/forgot-password`, for the person who cannot receive the mail — a changed address, a mailbox nobody has access to any more. Both ends issue the same kind of token through the same repository; three things differ, each because the caller is signed in rather than anonymous:

- **No cooldown.** It exists to stop an anonymous form being used as an email cannon. Whoever reaches this route holds an owner-only permission and is named in the audit entry; pressing the button twice is not an attack.
- **The token can come back in the response**, once, exactly as an invitation token does — but only under `MAIL_DRIVER=log`. See [One-time links](#one-time-links) below. The person whose account it is gets the email either way, and it says an administrator started the reset rather than that somebody asked for one.
- **The refusals are specific.** An invited account is told to re-send its invitation, a disabled one to be enabled first. There is nothing to leak to a caller who can already read the user list.

Its own permission key, not `user.update`: starting a credential flow on somebody else's account is not the same act as correcting the spelling of their name. See rule 3 below for the guard that goes with it.

## The three rules that are not queries

**1. You cannot hand out a role you could not grant yourself.** `assertRolesGrantable()` expands each requested role into its permissions and runs them through `assertGrantable()` — the same check the roles module applies from the other side. Without it, `user.invite` quietly means "may become owner": create an account, give it the Owner role, sign in as it.

It applies to inviting, to creating **and** to editing, because the escalation works from every one of those directions.

**2. Nobody can disable or delete their own account.** The button that would undo it is behind the access they just took away from themselves. The API refuses with a `400`; the console hides the button on your own row, so the message is a backstop rather than the primary experience.

That second refusal is also what keeps an installation repairable. Whoever reaches `DELETE /users/:id` holds `user.delete` and is signed in, so they are themselves an account able to manage users — which means **deleting somebody else can never remove the last one**. There is deliberately no separate "is this the last manager" count: given the self-delete rule it could never fire, and a guard that cannot fire reads as protection while being none.

**3. Nobody can reset the password of an account stronger than their own.** Rule 1 by another route, and the reason `assertNotStronger()` sits on `POST /users/:id/reset-password`: taking an account over is a way of holding its permissions, and a reset link is a way of taking one over. Without it, `user.reset_password` handed to a support role means "may become owner" — reset the owner's password, follow the link, sign in.

It compares **effective permissions**, not roles: what matters is what the target account can do, however it came by it. The refusal is a `403` naming the permissions the caller is missing, the same shape `assertGrantable()` answers with.

## Deleting is soft, and the address stays taken

`DELETE /users/:id` sets `deleted_at`; `POST /users/:id/restore` clears it and the account comes back with the status it had. Both sit behind the **same permission**, because being able to remove an account without being able to put it back is a worse position than not being able to remove it at all.

Two consequences worth knowing:

- **Deleting an already-deleted account is a `200`, not an error**, and so is restoring a live one. A repeated request that changes nothing is not a failure — the same reasoning that makes `POST /users/:id/status` return early when the status already matches.
- **`users_email_key` has no `deleted_at` predicate**, so a departed person's address stays reserved. Re-inviting it is a `409` saying _"That email address belongs to a deleted account. Restore it instead."_ Making the index partial would look like a tidy-up and would let a brand-new account inherit somebody else's audit trail, because `audit_logs.actor_label` stores the email as it read at the time.

## Disabling and deleting kill sessions on the next request

There is no revocation sweep, and there is nothing to remember. `findLiveSession()` joins `users` with `status = 'active' AND deleted_at IS NULL`, so a disabled **or deleted** person's next request finds no live session, gets a `401`, and the console sends them to the sign-in page.

One condition in SQL, holding for every code path, beats a revocation pass that some future endpoint forgets to call — which is also why deleting does not add one. A second mechanism doing the same job is how the first stops being trusted.

## One-time links

Every one of them is **emailed**, from inside the transaction that issued it — `queueMail(tx, defer, …)`, so an invitation that rolls back takes its email with it. See [Mail](mail.md).

`POST /users` and `POST /users/:id/invite` also return `inviteToken`, and `POST /users/:id/reset-password` returns `resetToken`, **in that response only**. What is stored is the SHA-256 hash of each, under a partial unique index, so a user has at most one outstanding invitation and at most one live reset.

Both fields are `string | null`, and `revealTokens()` — one function, so the rule is written once — decides which:

| `MAIL_DRIVER` | The field | Why                                                                                                  |
| ------------- | --------- | ---------------------------------------------------------------------------------------------------- |
| `log`         | the token | Nothing reached an inbox. A fresh clone has no transport, and the link has to come from somewhere    |
| anything else | `null`    | The recipient has it. A second copy in the response is a credential handed to somebody it is not for |

`string | null` rather than a field that comes and goes: a key that is sometimes absent makes the response an anonymous union, and the console derives its types from this shape.

Both are rendered by `InviteTokenDialog.vue`, which takes a `kind` prop and builds `<origin>/invitation/<token>` or `<origin>/reset-password/<token>`. It:

- blocks Escape and outside-click, because closing it loses a value that cannot be fetched again;
- falls back to a selectable text box when the clipboard is refused — over plain HTTP on a non-localhost origin it always will be.

`window.location.origin` is correct **here and only here**: this dialog runs in the browser of whoever pressed the button. A link that leaves by email is addressed from `CONSOLE_URL` on the server, where there is no `window`.

With a real transport the dialog still opens, with nothing to copy: _"We have emailed the link to ada@example.com."_ A confirmation of where it went is worth more than a dialog that silently does not appear, which is indistinguishable from a button that did nothing.

## The console side

`UsersPage.vue` is wiring; everything that knows about users lives in `features/users/`. Two pieces are worth knowing about:

- **One dialog, three modes, and the buttons are the choice.** `UserFormDialog` invites, creates and edits. Somebody holding both `user.invite` and `user.create` gets **two footer buttons** — `Save` creates the account with the password in the form, `Send invitation` mails a link — and pressing one is the whole decision. Somebody holding one sees only that one. Which buttons exist is `offeredModes(user, can)`, and which one the Enter key presses is `dialogMode(user, can)`: pure functions in `features/users/api.ts` with tests beside them, because that branch decides which of three endpoints a submit reaches. An earlier version put a segmented mode switch above the form; it asked people to pick a mode before they knew what either mode meant, and a mode nobody found is a feature nobody has. **None of this refuses anything**; the three `requirePermission()` calls and the 403 tests do.
- **Deleted is a facet, not a checkbox.** Ticking it sends `includeDeleted=true`. It is declared as a filter on `useResourceList` so that turning it on resets the page and clears with Reset, exactly like narrowing by status does. A deleted row renders struck through with a Deleted badge, and its only action is Restore — editing somebody who has been removed, or starting a reset they can never finish, are clicks with nothing behind them.

The public half is two pages, `ForgotPasswordPage.vue` at `/forgot-password` and `ResetPasswordPage.vue` at `/reset-password/:token`. Both are `meta.public`, for the reason the invitation page is: whoever opens them cannot sign in.

## The list

```text
GET /users?q=ada&status=active&status=invited&roleId=…&page=2&perPage=10&sort=email&order=desc
    -> { "items": [ … ], "total": 34, "page": 2, "perPage": 10 }
```

| Parameter        | Takes                                                     |
| ---------------- | --------------------------------------------------------- |
| `q`              | Matched against the name and the email                    |
| `status`         | `invited` · `active` · `disabled` — **repeatable**        |
| `roleId`         | Anyone holding any of these roles — **repeatable**        |
| `includeDeleted` | `true` · `false` (default) — show soft-deleted rows too   |
| `page`           | From 1, default 1                                         |
| `perPage`        | 1–100, default 10                                         |
| `sort`           | `name` · `email` · `status` · `lastLoginAt` · `createdAt` |
| `order`          | `asc` · `desc`                                            |

`includeDeleted` is an **enum of two strings**, not a coerced boolean: `z.coerce.boolean()` reads the string `"false"` as `true` — every non-empty string is truthy — so a client that spells the default out would get the opposite of what it asked for.

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

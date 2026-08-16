# Authentication

Session-based, with an opaque token in an `httpOnly` cookie. No JWTs — the reasoning is in [ADR-0001](../decisions/ADR-0001-session-cookies-over-jwt.md).

| Concern                      | File                                           |
| ---------------------------- | ---------------------------------------------- |
| Endpoints                    | `apps/api/src/modules/auth/auth.routes.ts`     |
| Rules                        | `apps/api/src/modules/auth/auth.service.ts`    |
| Token generation and hashing | `apps/api/src/lib/token.ts`                    |
| The cookie                   | `apps/api/src/lib/session-cookie.ts`           |
| Session rows                 | `apps/api/src/platform/session.repo.ts`        |
| Reset rows                   | `apps/api/src/platform/password-reset.repo.ts` |
| Password hashing             | `apps/api/src/lib/password.ts`                 |
| Identity + session tables    | `apps/api/src/db/schema/identity.ts`           |

## Endpoints

| Method | Path                          | Guard           | Answers                                      |
| ------ | ----------------------------- | --------------- | -------------------------------------------- |
| `POST` | `/auth/login`                 | public          | `{ user, expiresAt }` and sets the cookie    |
| `GET`  | `/auth/invitation/:token`     | public          | `{ invitation: { email, name, expiresAt } }` |
| `POST` | `/auth/invitation/accept`     | public          | Sets a password, activates, signs in         |
| `POST` | `/auth/forgot-password`       | public          | `{ ok: true }` — always, whatever happened   |
| `GET`  | `/auth/password-reset/:token` | public          | `{ reset: { email, expiresAt } }`            |
| `POST` | `/auth/reset-password`        | public          | Sets the password, signs in, kills the rest  |
| `GET`  | `/auth/me`                    | `requireAuth()` | `{ user, permissions }`                      |
| `POST` | `/auth/logout`                | public          | Clears the cookie, revokes the session       |

The invitation and reset endpoints are public **on purpose**: the people who open them are precisely the ones without an active account. The capability is the token in the URL, not a session.

`/auth/logout` is public too, and always answers `200`. A token that does not exist, has expired, or was already revoked still gets a success — otherwise the endpoint becomes a way to test whether a token was ever valid.

## The token

```text
sess_hCq3n7pQ...   43 characters of base64url
inv_9dLmR2f...
rst_Kw8tXb1...
```

A prefix, an underscore, and 32 random bytes as base64url — always exactly 43 characters, no padding.

- **The prefix is functional.** A token leaked into a log or a repository is recognisable on sight, and secret scanners have a pattern to match.
- **256 bits of randomness.** Guessing one takes more attempts than there is time.
- **Only the SHA-256 hash is stored.** If a database dump leaks, its contents cannot be replayed into a session. Unsalted SHA-256 is enough here — unlike for a password — because the token is full-entropy randomness with no dictionary to run against it.
- **`looksLikeToken()` runs before any query.** A stale cookie from an older deployment, or a random string from a scanner, does not deserve a database round trip each.

The full token exists exactly once, in the response that issues it. It is never read back out of the database, because it is not there.

## The cookie

```text
Set-Cookie: app_session=sess_...; Path=/; HttpOnly; SameSite=Lax; Expires=...
```

| Attribute  | Value           | Why                                                                                                                                                                                                                        |
| ---------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `httpOnly` | always          | A single XSS anywhere can read `localStorage` and post the token elsewhere. An `httpOnly` cookie is invisible to JavaScript entirely.                                                                                      |
| `sameSite` | `Lax`           | Closes CSRF for every non-GET request from another site, without a separate CSRF token. `Strict` would make a link from an email land looking signed-out; `None` would reopen the door for a capability we may never need. |
| `secure`   | production only | `localhost` over HTTP silently refuses a `Secure` cookie — the failure mode is "the cookie is simply never stored".                                                                                                        |
| `path`     | `/`             |                                                                                                                                                                                                                            |

> **Clearing a cookie must use the same attributes it was set with.** A browser matches the cookie to remove by name + domain + path. Differ in one and you get a second, empty cookie while the original keeps being sent — a sign-out that looks successful and is not. `clearSessionCookie()` reuses `baseOptions()` for exactly this reason.

Because the token lives in a cookie, every frontend `fetch` needs `credentials: 'include'`. It is set once, in each app's `src/lib/api.ts`.

## Signing in

Two properties are held to strictly in `auth.service.ts`:

**One failure message for every cause.** Unknown email, wrong password, an account still sitting on an invitation — all of them answer `Wrong email or password.` A message that distinguishes between them turns the sign-in endpoint into an email verifier that anyone can query.

**Comparable response times.** Every failing path still runs one argon2 verification through `verifyDummyPassword()`. Without it, "no such email" comes back roughly 25 ms sooner than "wrong password", and that gap is measurable from the outside.

There is one deliberate exception. An account that has **already proved its password** but is disabled gets a clear message. Nothing leaks at that point — the person demonstrably owns the account — and answering "wrong email or password" to somebody whose access was just revoked only ends in a support call.

Passwords are hashed with **argon2id** (`@node-rs/argon2`). If a hash was made with older parameters, `rehashIfStale()` recomputes it while the plaintext is in hand — and a failure there never fails the sign-in, because the password has already been proved correct.

## Session liveness

`findLiveSession()` decides in **one query**, in SQL:

```text
session.token_hash = $1
AND session.revoked_at IS NULL
AND session.expires_at > now()
AND user.status = 'active'
AND user.deleted_at IS NULL
```

The last two conditions are what make **"disable an account and its sessions die on the next request"** true, with no revocation sweep, no cache to invalidate, and no background job. Move any of those checks into JavaScript and the property quietly stops holding for whichever path forgets one.

`last_seen_at` is updated at most once every five minutes, after the response has been sent and deliberately not awaited. A response must not wait on a write that only updates a "last used" column.

## Invitations

A new user is created with `status = 'invited'` and a **null `password_hash`**, which is treated exactly like a user who does not exist on the sign-in path. Their way in is the link.

```text
POST /users            → creates the row, issues inv_… , returns the token once
                         console renders <origin>/invitation/<token>
GET  /auth/invitation/:token
                       → { email, name, expiresAt } so the page can say whose account it is
POST /auth/invitation/accept
                       → sets the first password, status → 'active', issues a session
```

Only the **hash** of the invitation token is stored, in `users.invite_token_hash`, under a partial unique index. A user can therefore have only one outstanding invitation: re-sending replaces the previous hash and the old link stops working, which is the behaviour anyone would expect from "re-send".

Accepting signs you straight in. The person has just proved two things at once — they hold the link, and they chose the password — so making them retype an email and a password they picked three seconds ago adds no security, only mistyped support calls.

> **No email is sent.** The template returns the invitation token to the caller and the console shows the link in a dialog. Wire your provider in `users.service.ts` where the token is issued, and stop returning the token in the response when you do.

## Password resets

Two doors into the same mechanism, and the difference between them is who is asking.

```text
POST /auth/forgot-password      → { ok: true }, always. The link goes to the person, never
                                  to the caller
POST /users/:id/reset-password  → user.reset_password. Returns rst_… once, the way an
                                  invitation does
GET  /auth/password-reset/:token
                                → { email, expiresAt } so the page can say whose account it is
POST /auth/reset-password       → sets the password, revokes every session, issues a new one
```

Stored exactly like an invitation: the SHA-256 in `users.password_reset_token_hash` under a partial unique index, so an account has **one** live link and asking for another kills the first. A reset lives **`PASSWORD_RESET_TTL_MINUTES`** (default 60, capped at a day) rather than the invitation's 72 hours — an invitation has to survive a weekend, a reset only the walk to an inbox, and every extra hour is another hour a link sitting in a mailbox is a live credential.

### `POST /auth/forgot-password` tells you nothing

It answers `200 { ok: true }` for an address that does not exist, for one that is invited or disabled or deleted, and for one whose cooldown has not elapsed. `requestPasswordReset()` resolves `void` so the route has nothing to branch on. This is the same rule the sign-in path follows, for the same reason: an honest answer here is an endpoint that tells anybody who asks whether an address has an account.

Three consequences that each look like an omission:

- **The audit entry is written only when a token was really issued.** An entry for an unknown address would turn the audit log into the enumeration oracle the endpoint refuses to be — and it is read by exactly the people who could then use it.
- **A 60-second per-address cooldown**, so the endpoint is not an email cannon pointed at anybody whose address is known. It leaves the outstanding link alone rather than rotating it: a mail already on its way would otherwise be dead on arrival.
- **The cooldown is a condition on the row**, not a read followed by a write, so two requests arriving together cannot both pass it. There is no `password_reset_issued_at` column — a token issued _n_ seconds ago expires `ttl - n` from now, so "issued within the cooldown" is "expires later than `now + ttl - cooldown`".

Which accounts may reset is decided **in SQL**, in `issueReset()` and again in `findPendingReset()`: `status = 'active' AND deleted_at IS NULL`. An invited account's way in is its invitation, and a disabled one must not be able to reset its way back in — otherwise "switch this person off" is undone by a form anybody can post to.

The console's half is `ForgotPasswordPage.vue`, reached from a link beside the password field on the sign-in page. It shows **one sentence whatever happened** — _"If … belongs to an account, a link to set a new password is on its way"_ — because a page that says "no such account" undoes the endpoint's whole point. The only failure it can report is one that stopped the request being answered at all: a malformed address, or a network that dropped it.

### Using the link

`consumeReset()` carries the token hash in its `WHERE`, exactly as `acceptInvite()` does, so a double-clicked button cannot apply twice: the second request matches zero rows and is answered like an expired link rather than overwriting the password the first one just set.

`ResetPasswordPage.vue` at `/reset-password/:token` mirrors `AcceptInvitePage.vue`: it previews first, so a link that has been used, superseded or expired says so _before_ somebody invents a password rather than after, and it lands them signed in.

Then **every session is revoked**, before the new one is created. "I forgot my password" and "I think somebody else has my password" arrive through the same door, and only one of them is safe to leave signed in elsewhere. Ordering it after would sign the person out of the session the reset had just handed them.

> **No email is sent here either.** Outside production the link is written to the API log (`password reset requested — no mailer is configured`), because a self-service token is the one that can never be returned in a response. That log line goes when the mail subsystem takes over the send.

## Conventions

- Never put a session token in a response body. The cookie is the only channel.
- Never store identity in `localStorage`. `GET /auth/me` is the single source of truth, and a copy in local storage keeps saying "allowed" after access has been revoked.
- Keep the uniform failure message. Any new sign-in path gets `failLogin()`, dummy verification included.
- Any condition that decides whether a session is usable goes into the SQL in `findLiveSession()`, not into a check afterwards.
- Every new token family gets a prefix in `TOKEN_PREFIX` and a `looksLikeToken()` check before its first query. A family of its own is also what stops an invitation link being traded at the reset door.
- An endpoint anybody can post an email address to answers the same way whatever it found, and writes its audit entry only when something actually happened.
- Reuse `baseOptions()` for anything that sets or clears the session cookie.

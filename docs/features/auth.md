# Authentication

Session-based, with an opaque token in an `httpOnly` cookie. No JWTs — the reasoning is in [ADR-0001](../decisions/ADR-0001-session-cookies-over-jwt.md).

| Concern                      | File                                        |
| ---------------------------- | ------------------------------------------- |
| Endpoints                    | `apps/api/src/modules/auth/auth.routes.ts`  |
| Rules                        | `apps/api/src/modules/auth/auth.service.ts` |
| Token generation and hashing | `apps/api/src/lib/token.ts`                 |
| The cookie                   | `apps/api/src/lib/session-cookie.ts`        |
| Session rows                 | `apps/api/src/platform/session.repo.ts`     |
| Password hashing             | `apps/api/src/lib/password.ts`              |
| Identity + session tables    | `apps/api/src/db/schema/identity.ts`        |

## Endpoints

| Method | Path                      | Guard           | Answers                                      |
| ------ | ------------------------- | --------------- | -------------------------------------------- |
| `POST` | `/auth/login`             | public          | `{ user, expiresAt }` and sets the cookie    |
| `GET`  | `/auth/invitation/:token` | public          | `{ invitation: { email, name, expiresAt } }` |
| `POST` | `/auth/invitation/accept` | public          | Sets a password, activates, signs in         |
| `GET`  | `/auth/me`                | `requireAuth()` | `{ user, permissions }`                      |
| `POST` | `/auth/logout`            | public          | Clears the cookie, revokes the session       |

The invitation endpoints are public **on purpose**: the people who open them are precisely the ones without an active account. The capability is the token in the URL, not a session.

`/auth/logout` is public too, and always answers `200`. A token that does not exist, has expired, or was already revoked still gets a success — otherwise the endpoint becomes a way to test whether a token was ever valid.

## The token

```text
sess_hCq3n7pQ...   43 characters of base64url
inv_9dLmR2f...
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

## Conventions

- Never put a session token in a response body. The cookie is the only channel.
- Never store identity in `localStorage`. `GET /auth/me` is the single source of truth, and a copy in local storage keeps saying "allowed" after access has been revoked.
- Keep the uniform failure message. Any new sign-in path gets `failLogin()`, dummy verification included.
- Any condition that decides whether a session is usable goes into the SQL in `findLiveSession()`, not into a check afterwards.
- Every new token family gets a prefix in `TOKEN_PREFIX` and a `looksLikeToken()` check before its first query.
- Reuse `baseOptions()` for anything that sets or clears the session cookie.

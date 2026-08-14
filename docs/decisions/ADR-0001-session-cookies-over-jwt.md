# ADR-0001 — Session cookies over JWT

- **Status:** accepted
- **Date:** 2026-08-15
- **Affects:** `apps/api/src/lib/session-cookie.ts`, `apps/api/src/lib/token.ts`, `apps/api/src/platform/session.repo.ts`, `apps/api/src/middleware/session.ts`

## Context

Authentication had to work for a back-office console today and for whatever a consuming project adds later — a customer portal, a mobile client, a public storefront. Two shapes were on the table.

**A stateless JWT.** The API signs a token carrying the user id and their permissions; every request verifies the signature and trusts the claims. Nothing is read from the database on the hot path. This is the default answer in most TypeScript starters.

**An opaque session token.** The API stores a random token, hands it to the browser, and looks it up on every request.

The deciding question was not performance. It was: **what happens between the moment an account is disabled and the moment the holder of its token stops being able to act?**

With a JWT the honest answer is "until it expires". Every mitigation people reach for — a short TTL with refresh tokens, a revocation list, a `tokenVersion` column checked on each request — reintroduces the database lookup that the JWT existed to avoid, while keeping the JWT's complexity. A revocation list is a session table with worse ergonomics.

This template ships user disabling and role editing as first-class features. A permission removed in the console at 14:00 that keeps working until 14:15 is not a feature with a caveat; it is a broken feature.

## Decision

Sessions are **opaque server-side tokens in an `httpOnly` cookie**.

- The token is a prefix plus 32 random bytes, base64url — `sess_` for sessions, `inv_` for invitations (`lib/token.ts`). It carries no meaning and no claims.
- Only its SHA-256 is stored. A leaked database backup does not contain usable session tokens.
- It travels in a cookie: `httpOnly`, `SameSite=Lax`, `Secure` in production, `Path=/`. It is never in a response body — nothing that can be read by JavaScript can be exfiltrated by an XSS.
- **Liveness is one SQL query.** `findLiveSession()` joins the session to its user and requires, in a single statement: the token hash matches, `revoked_at IS NULL`, `expires_at > now()`, `users.status = 'active'`, `users.deleted_at IS NULL`.

That last point is the whole decision compressed into one join. Disabling an account kills its sessions on the next request, with no revocation sweep, no cache invalidation, and no background job. `permissions` are loaded per request for the same reason.

## Consequences

**What we get.** Instant revocation. No key rotation ceremony. No refresh-token flow, which is where most JWT implementations grow their bugs. No `localStorage` token for an XSS to steal. Sessions are inspectable — `select * from sessions` answers "who is signed in right now", which is a support question that gets asked.

**What we pay.** One indexed lookup on every authenticated request; on a database this small it does not register, but it is a real dependency — an unreachable database means nobody is signed in, rather than degraded service.

The API is now **stateful with respect to the database**, though still stateless with respect to the process: any replica serves any request, because the state is in Postgres and not in memory.

Because the cookie is sent automatically, CSRF is a separate concern. It is handled by `SameSite=Lax` plus the CORS origin allowlist in `app.ts`, not by a CSRF token. `SameSite=None` would reopen that door and is deliberately not used.

**Cross-origin costs something.** Every frontend must send `credentials: 'include'`, and its origin must be in `CORS_ORIGINS`. This is the most common way a new frontend fails, which is why [`../guides/add-frontend-app.md`](../guides/add-frontend-app.md) leads with it.

**Third-party consumers are not served by this.** A cookie is a browser mechanism. Anything that is not a browser under your own domains needs something else.

## What would change this

Add a token-based path **alongside** sessions rather than replacing them:

- **A native mobile app.** Cookies are workable in a native HTTP client but unpleasant. A personal-access-token table — the same opaque-token-hashed-at-rest design, a different lifetime, and its own middleware — is the smaller change.
- **A machine-to-machine API.** API keys, scoped, rotatable, and rate-limited per key.
- **SSO / OIDC.** The identity provider issues a JWT; the API verifies it **once**, at sign-in, and then issues a session of its own. The JWT authenticates the login, it does not become the session.
- **Genuine read scale.** If the session lookup ever becomes a measured bottleneck, cache it in Redis with a short TTL and delete the key on revocation — keeping the database as the source of truth. That is a cache, not a change of model, and it does not need a new ADR.

None of these reverse this decision. A short-lived JWT that also needs a database lookup to be trusted would.

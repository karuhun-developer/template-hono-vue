# Mail

Email that is written inside the transaction that decided to send it, and sent by a worker afterwards.

| Concern                   | File                              |
| ------------------------- | --------------------------------- |
| The only way to send      | `apps/api/src/mail/outbox.ts`     |
| The template catalog      | `apps/api/src/mail/templates.ts`  |
| The templates             | `apps/api/src/mail/templates/`    |
| The driver interface      | `apps/api/src/mail/mailer.ts`     |
| Drivers                   | `apps/api/src/mail/driver/`       |
| Row access                | `apps/api/src/mail/mail.repo.ts`  |
| The `mail_messages` table | `apps/api/src/db/schema/mail.ts`  |
| The jobs                  | `apps/api/src/queue/jobs/mail.ts` |
| The console's endpoints   | `apps/api/src/modules/mail/`      |

## Sending

```ts
await transaction(async (tx, defer) => {
  const user = await inviteUser(tx, input)
  await queueMail(tx, defer, {
    to: { email: user.email, name: user.name },
    template: 'invitation',
    payload: { name: user.name, token, expiresAt: expiresAt.toISOString() },
  })
})
```

`queueMail()` is **the only public way to send**, and three things happen in it, in this order:

1. **Render**, so a template that cannot render fails inside the caller's transaction rather than three retries later in a worker log.
2. **Store the masked body** through the caller's `tx`, so the message commits with the change that caused it.
3. **Enqueue `mail.send`**, passing both `tx` and `defer` so the driver honours whichever it can.

`mailer` is deliberately **not** reachable from a service. A `mailer.send()` on a request path would be an email sent for a row that may still roll back — the recipient gets an invitation to an account that does not exist — and it would put a mail server's bad afternoon inside somebody's browser tab. The transport is the send job's business.

> **`#mail` and `#queue` do not import each other.** `mailer.ts` never enqueues and `outbox.ts` never sends; the two subsystems meet in exactly one file, `queue/jobs/mail.ts`. That is what keeps the cycle from forming, and both files say so at the top.

### What gets sent today

| Template         | From                                                        | Also returns the token?              |
| ---------------- | ----------------------------------------------------------- | ------------------------------------ |
| `invitation`     | `POST /users`, `POST /users/:id/invite`                     | Under `MAIL_DRIVER=log` only         |
| `password-reset` | `POST /users/:id/reset-password` (`triggeredByAdmin: true`) | Under `MAIL_DRIVER=log` only         |
| `password-reset` | `POST /auth/forgot-password`                                | **Never** — that is the whole attack |

`revealTokens()` in `mail/outbox.ts` is the one place the first two are decided, so they cannot drift apart. The third is not its business: a self-service reset would be handing the link to whoever typed the address in.

## The outbox property

The row is written inside the transaction. That buys the two halves of one guarantee:

- **No message for a change that rolled back.** The 409 on a duplicate email takes the `mail_messages` row down with it.
- **No lost message for a change that committed.** Under `QUEUE_DRIVER=redis` the enqueue happens after the commit and a crash in between loses the job — but not the row, and `mail.sweep-stuck` re-enqueues anything still `queued` after five minutes.

Under `database` the sweep should find nothing. The day it does, something is wrong with the worker rather than with the outbox.

## Why a stored body is not a way in

**A mail log that shows the rendered body is, naively implemented, an account-takeover feature.** The invitation body contains a live `inv_…` link, so anyone able to read a stored copy could accept somebody else's invitation. Three mechanisms close that, and **all three are required**:

| Mechanism                                                                                          | Where                                   |
| -------------------------------------------------------------------------------------------------- | --------------------------------------- |
| The template declares `secrets`; the outbox stores the body with each one replaced by `[redacted]` | `mail/templates/*.ts` → `maskSecrets()` |
| `payload` is absent from `mailColumns`, so no read path can select it                              | `mail/mail.repo.ts`                     |
| `payload` is set to `NULL` at every terminal state                                                 | `markMailSent()` / `markMailFailed()`   |

Masking runs over the **rendered** strings and replaces the token, not the URL — which blanks it inside the link as well, and the link is the part somebody reading the mail log would click. The send job re-renders the unmasked body from `template` + `payload`, which is why the stored copy never has to be the sendable one.

`mail.read` being owner-only sits on top of all three. It is the fourth layer, not the first.

## Templates

Plain TypeScript in a registry, the third `as const satisfies` catalog in the codebase after `PERMISSIONS` and `JOBS`:

```ts
export const TEMPLATES = {
  invitation: { payload: invitationPayload, render: renderInvitation },
  'password-reset': { payload: passwordResetPayload, render: renderPasswordReset },
} as const satisfies TemplateCatalog
```

`TemplateName` and `TemplatePayload<N>` are derived from it, so `queueMail(tx, defer, { template: 'invitaton', … })` is a compile error rather than a message nobody can render.

- **Both parts, always.** Text-only is a spam score; HTML-only is broken in half the clients that matter, and `renderLayout()` produces the two from one description so they cannot drift into saying different things.
- **No MJML, no `react-email`.** A template here is a function from a payload to four strings — unit-testable without a renderer, readable without a second templating language. A designed newsletter is a different system.
- **Payloads are JSON, and only JSON**, for the same reason a job payload is: it goes into `jsonb` and is re-parsed when the send job runs. Every schema uses `z.iso.datetime()` or an id, never `z.date()`.
- **Every link is absolute and built from `CONSOLE_URL`.** `window.location.origin`, which `InviteTokenDialog.vue` uses today, does not exist in a worker.
- **A name is escaped into the HTML part.** It is attacker-influenced text arriving in an inbox that renders HTML.

## Drivers

| `MAIL_DRIVER` | Sends to      | Writes `mail_messages` | Needs configuration |
| ------------- | ------------- | ---------------------- | ------------------- |
| `log`         | the log       | yes                    | none                |
| `smtp`        | a mail server | yes                    | `SMTP_HOST`         |

`log` is the default and a **real driver**, not a stub. A fresh clone has no SMTP server, no provider account and no API key, and the first thing anybody does with this template is invite somebody — with this driver that works, the row lands in the table, and the link is in the terminal running `make dev`. Outside production it logs the text body for exactly that reason; in production it does not, because a log aggregator holding invitation links is a credential store nobody is treating as one.

`MAIL_DRIVER=log` in production is **allowed** — an internal tool where accounts are handed out in person is a real thing — and warns at boot, because the other reason to be running it there is having forgotten to configure a transport.

### `smtp`

`nodemailer`, one pooled transport, opened by the **first send** and closed through `onShutdown`. Every vendor worth using speaks SMTP, so an SDK would tie the template to one of them; `node:net` would mean hand-writing STARTTLS and AUTH negotiation, two things only ever noticed when they are wrong.

**`verify()` is never called, at boot or anywhere else.** A mail server having a bad afternoon must not be an API that refuses to start — the failure belongs where every other transient failure here belongs, which is a job that retries. That is also why constructing the driver opens nothing.

Two settings are guesses the driver makes for you, and both fail in ways that read as somebody else's fault:

- **Implicit TLS is inferred from the port** — `465` yes, anything else no. On `587` nodemailer upgrades through `STARTTLS` on its own; opening `465` in the clear _hangs_ rather than failing. `SMTP_SECURE` exists for the relay that put SMTPS somewhere unusual.
- **`auth` is omitted entirely when `SMTP_USER` is unset**, not sent as an empty pair. A relay that authenticates by IP is offered no credentials at all; the alternative reads as a rejected password on a server that never wanted one.

`smtpTransportOptions()` is a pure function for exactly that reason, and it is all the driver's unit tests touch. Nothing pretends to reach a server — what would be under test is nodemailer.

For development, `make up-mail` starts **Mailpit**: SMTP on `1025`, an inbox on <http://localhost:8025>, nothing delivered anywhere. It lives in the dev compose overlay only, so no production stack can grow one by accident.

```bash
make up-mail
# .env
MAIL_DRIVER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
```

## The jobs

| Job                | Schedule  | What it does                                             |
| ------------------ | --------- | -------------------------------------------------------- |
| `mail.send`        | on demand | Re-reads the row, re-renders, sends, records the outcome |
| `mail.sweep-stuck` | periodic  | Re-enqueues anything still `queued` after five minutes   |
| `mail.prune`       | periodic  | Deletes finished messages past `MAIL_RETENTION_DAYS`     |

`mail.send` carries **an id, not the message**. The row is re-read on every attempt, so a retry after a half-finished attempt sees what actually happened and a message already `sent` is skipped rather than sent twice.

A payload that no longer parses is a **terminal** failure rather than a retry — the same bytes will not parse on the second attempt either, and three identical failures is one confusing log line repeated rather than any more information. Everything else follows the queue's own attempt accounting: `attempt >= maxAttempts` is how the handler knows it is on its last chance, and that is when the payload goes.

`mail.prune` deletes only `sent` and `failed` rows. A `queued` row past the window is the sweep's business; deleting it would throw away a message rather than a record of one.

## Endpoints

| Method | Path                 | Permission  |
| ------ | -------------------- | ----------- |
| `GET`  | `/mail-messages`     | `mail.read` |
| `GET`  | `/mail-messages/:id` | `mail.read` |

Paged, with `status` and `template` facets and a `q` across the recipient and the subject. Not the body: it is the largest column in the table, and the parts of the stored copy worth searching read `[redacted]` anyway.

Both routes select through `mailColumns`, including the detail one — the place a body is actually rendered is no closer to `payload` than the list is. `mail-log.test.ts` asserts that against the **raw response text**, because the question is whether the token left the process at all, not whether some particular field was cleared.

**There is no resend, and no delete.** By the time a message is terminal its `payload` is `NULL`, so the only thing left to send is the masked copy — a button that silently delivered an invitation reading `[redacted]` would be worse than no button. Sending again is inviting again, from the endpoint that knows how to issue a fresh token. And deleting is `mail.prune`'s job, on a schedule, rather than a control that lets somebody remove the record of a message they would rather nobody read.

`mail.read` is **owner-only** — a stricter bar than the rest of the Operations group, because what these two routes return is a copy of every message this application has sent, including the ones about whoever is asking.

## Settings

| Variable              | Default                 | Notes                                                                     |
| --------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `MAIL_DRIVER`         | `log`                   | `log` \| `smtp`. Works with no configuration at all                       |
| `MAIL_FROM`           | `no-reply@example.com`  | Copied onto every row as it read at the time                              |
| `MAIL_FROM_NAME`      | unset                   | The display name, quoted into the `From:` header                          |
| `MAIL_RETENTION_DAYS` | `30`                    | A mail log that grows forever is a table nobody vacuums                   |
| `CONSOLE_URL`         | `http://localhost:7301` | Every link is built from it — **its origin must be in `CORS_ORIGINS`**    |
| `SMTP_HOST`           | unset                   | **Required when `MAIL_DRIVER=smtp`** — the API refuses to boot without it |
| `SMTP_PORT`           | `587`                   | Submission with `STARTTLS`, which is what a relay offers by default       |
| `SMTP_SECURE`         | inferred                | Implicit TLS. Unset means `port === 465`                                  |
| `SMTP_USER`           | unset                   | Unset means no `AUTH` at all, for a relay that authenticates by IP        |
| `SMTP_PASSWORD`       | unset                   | Never in a compose file and never in `.env.example`                       |

Both cross-field rules are a `superRefine` and the API refuses to boot without them. `SMTP_HOST` missing under `MAIL_DRIVER=smtp` would otherwise surface as every invitation retrying three times and landing `failed` — a broken-looking mail server that is really a missing setting. A `CONSOLE_URL` outside `CORS_ORIGINS` means an invitation that lands on a page whose first request is blocked — a failure that looks like a broken invitation and is actually a typo in a different variable.

## Adding a template

1. Write it in `mail/templates/`, returning `{ subject, text, html, secrets }` through `renderLayout()`.
2. **List every credential in `secrets`.** The outbox masks what the template declares and nothing else.
3. Add the payload schema and the renderer to `TEMPLATES` — JSON-only fields.
4. Call `queueMail(tx, defer, …)` from inside a `transaction()`.
5. Test that the stored body does not contain the secret and that a capturing driver receives one that does.

## Conventions

- `queueMail()` is the door. Nothing imports `mailer` outside `mail/` and the send job.
- A template declares its secrets. A secret that is not declared is a secret that gets stored.
- Nothing on a request path talks to a mail server.
- A payload carries **ids and strings**, never a row and never a `Date`.
- The read API selects through `mailColumns`. A `select()` with no projection over this table is a bug.
- There is **no resend button**, and there will not be one: the token has been nulled, and a button that silently sends a dead link is worse than no button.

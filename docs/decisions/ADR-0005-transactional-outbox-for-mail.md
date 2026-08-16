# ADR-0005 — A transactional outbox for mail

- **Status:** accepted
- **Date:** 2026-08-16
- **Affects:** `apps/api/src/mail/outbox.ts`, `apps/api/src/db/schema/mail.ts`, `apps/api/src/queue/jobs/mail.ts`, `apps/api/src/scheduler/schedules.ts`

## Context

An invitation is two things that must agree: a user row with a token on it, and an email carrying that token. Getting them to agree is the entire problem, and there are only three places to put the send.

**Inside the transaction.** `await mailer.send(...)` between the insert and the commit. Simple, and wrong in both directions: a rollback after a successful send emails somebody a link to an account that does not exist, and a mail server having a slow afternoon becomes a transaction held open in somebody's browser tab. SMTP is not transactional and never will be.

**After the commit, in the request.** Correct about ordering, and it fails the moment anything goes wrong: the process is redeployed between the commit and the send, or the provider is down, and the email is simply never sent. There is no record that it should have been, so nobody finds out until the person says they never got their invitation. It also puts a network call to a third party on a request path.

**After the commit, from a queue.** Correct, but only if the _decision to send_ commits with the change. An `enqueue` that happens after the commit has the same hole as the send does — smaller, but the same shape.

The queue this template ships makes the third option genuinely available: under `QUEUE_DRIVER=database` an enqueue is an insert through the caller's `tx`, so the job commits with the change. But it is one driver of three, and `redis` cannot join a Postgres transaction. A design that only works under one driver is a trap for whoever switches.

There is a second problem tangled with the first. A `mail_messages` row that stores the rendered body stores **a live invitation link**, and the console has a page that displays it. Naively implemented, "view the mail log" is "accept somebody else's invitation".

## Decision

**`queueMail(tx, defer, message)` is the only public way to send an email**, and it does three things in this order:

1. **Render**, so a template that cannot render fails inside the caller's transaction rather than three retries later in a worker log.
2. **Insert the `mail_messages` row through the caller's `tx`** — with every secret masked in the stored body.
3. **`enqueue('mail.send', { messageId }, { tx, defer })`.**

The **row**, not the job, is the outbox. That is the distinction the whole design rests on: the job is a pointer at a row that has already committed. Under `database` both commit together; under `redis` and `sync` the row commits and the dispatch happens afterwards, and if that dispatch is lost the row is still there, still `queued`. `mail.sweep-stuck` re-enqueues anything still `queued` after five minutes, which closes the hole with the schedule rather than with a second transactional system.

`mail.send` re-reads the row, so a retry sends what is true now rather than a copy of what was true at enqueue, and a message already `sent` is a no-op.

Three further decisions come with it, and all three are required together:

- **`mailer` is not exported from the mail barrel.** A later `mailer.send()` inside a service would reintroduce the send-inside-a-transaction bug silently, and nothing would catch it. The only door is `queueMail`.
- **The stored body is masked; the sent body is not.** A template returns `{ subject, text, html, secrets }`, and the outbox writes `maskSecrets(...)` while the send job renders its own copy from `template` + `payload`. `payload` is excluded from `mailColumns` the way `passwordHash` is excluded from `userColumns`, and it is set to `NULL` at a terminal state — so a token cannot outlive its send. `mail.read` is owner-only on top of all three.
- **There is no resend button.** The token has been nulled by then, and a button that silently sends a dead link is worse than no button.

## Consequences

**An email is never sent for a change that did not happen**, under every driver. That is the property the whole arrangement exists to buy.

**Nothing on a request path talks to a mail server.** A provider having a bad day is a queue depth and a retry, not a timeout in somebody's browser.

**Every message has a record before anybody tries to send it.** "Did that invitation go out?" is a row with a status, an attempt count and an error — answerable from the console by somebody who is not reading logs.

**A message can be sent twice under `redis`.** The sweep re-enqueues a row still `queued` after five minutes; if the original dispatch was merely slow rather than lost, two jobs can exist for one row. `mail.send` re-reads and skips a row that is no longer `queued`, which closes the ordinary case, but two workers claiming the two jobs at the same instant is a genuine race. A duplicate invitation email is an acceptable outcome; a duplicate _payment_ email would not be, and a project sending those should give the send its own idempotency key at the provider.

**The delay is real.** Under `database` the send waits up to `QUEUE_POLL_MS`, and up to five minutes if the dispatch was lost. An email is not a synchronous operation any more, and a test that expects one is testing the old design.

**The mail log is safe to look at, but only because all three mechanisms are present.** Remove any one — mask, omit `payload`, null at terminal — and the page becomes an account-takeover feature. This is called out in `db/schema/mail.ts`, in `outbox.ts` and in [`../features/mail.md`](../features/mail.md), because a future edit that "simplifies" one of them will look harmless.

**The queue is now on the critical path for invitations.** A worker that is not running means invitations that are not delivered. The Jobs page and the mail log both make that visible within a minute, which is better than the previous design's answer, but it is a new operational dependency and it should be monitored.

## What would change this

**A provider with a durable ingestion API** — one that accepts a message with an idempotency key and takes responsibility for it. The outbox row is still worth having as a record, but the sweep's duplicate window closes and `mail.send` becomes a thin call.

**Mail that must never be duplicated.** Move the idempotency key from the row into the provider call, so the second send is refused at the far end rather than avoided by a status check on our side.

**A dedicated relay process.** If the number of transactional side effects grows past mail — webhooks, search indexing, third-party sync — the honest shape is one outbox table and one relay that drains it, rather than a `*_messages` table per consequence. That is a larger change than this ADR describes and would supersede it.

This ADR is **not** superseded by switching `QUEUE_DRIVER`. Weakening the guarantee is exactly the case it was written for; see [ADR-0004](ADR-0004-jobs-in-postgres-by-default.md).

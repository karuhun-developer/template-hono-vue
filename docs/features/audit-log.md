# Audit log

Who changed what, when, and from where. Append-only, written inside the transaction of the action it describes.

| Concern                              | File                                         |
| ------------------------------------ | -------------------------------------------- |
| Writing, reading, redaction, diffing | `apps/api/src/modules/audit/audit.repo.ts`   |
| The read endpoint                    | `apps/api/src/modules/audit/audit.routes.ts` |
| Query validation                     | `apps/api/src/modules/audit/audit.schema.ts` |
| Table                                | `apps/api/src/db/schema/audit.ts`            |
| Console                              | `apps/console/src/pages/AuditLogPage.vue`    |

## Writing an entry

```ts
return db.transaction(async (tx) => {
  await tx.update(users).set({ status }).where(eq(users.id, userId))

  await recordAudit(tx, actor, {
    action: 'user.disable',
    subjectType: 'users',
    subjectId: target.id,
    subjectLabel: target.email,
    before: { status: target.status },
    after: { status },
  })
})
```

`recordAudit` takes the **caller's database handle**, so it joins their transaction. A change that commits while its trail entry rolls back — or the reverse — is a state that must not be reachable, and passing `tx` is what makes that structural rather than a matter of remembering.

`actorFromContext(c)` builds the actor from the request in flight. It is a separate function so that `recordAudit` stays callable from a scheduled job that has no `Context` at all; such a job passes `{ type: 'system' }`.

## What is stored

| Column                        | Note                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `actor_type`                  | `user` or `system`                                        |
| `actor_id`                    | **No foreign key.** See below                             |
| `actor_label`                 | The email **as it was at the time**                       |
| `action`                      | `user.disable`, `role.update` — the permission vocabulary |
| `subject_type` / `subject_id` | `users`, `roles`, plus the row id                         |
| `subject_label`               | Readable by a human: `member@example.com`                 |
| `before` / `after`            | `jsonb`, the **changed columns only**, redacted           |
| `reason`                      | Optional free text                                        |
| `request_id` / `ip_address`   | Ties the entry to its log lines                           |
| `created_at`                  | And nothing else — no `updated_at`                        |

### `actor_id` has no foreign key

The trail outlives the actor. A user erased at the end of a retention period must not take the record of what they did with them, and a foreign key would either block the delete or cascade the history away. `actor_label` is a snapshot for exactly this reason: people change their email address, and a row holding nothing but a UUID becomes unreadable the moment the account behind it is gone.

### There is no `updated_at`

A trail you can edit is not a trail. The table has `created_at` and nothing else, there is no update or delete endpoint, and there is not going to be one — a trail with a delete button gets tidied up by precisely the person who should not be tidying it.

### Changed columns only

Storing the whole row feels safer and is not. The entry becomes a copy of the table — including columns that had nothing to do with the change — in the one place people look while they are investigating something. `diffFields(before, after)` returns only what actually differs, comparing `Date` by value and ignoring any key the request invented that was not in the original row.

### Redaction

`redact()` replaces the **values** of `passwordHash`, `inviteTokenHash`, `tokenHash`, `token`, `password` and their snake_case spellings with `[redacted]`, in both cases. Without it, the one table everybody is allowed to read would be where every secret ends up.

## Reading it

`GET /audit-logs`, behind `audit.read`. Read-only — there is nothing else on the router.

| Query                   | Meaning                                 |
| ----------------------- | --------------------------------------- |
| `action`, `subjectType` | Exact match, optional, **repeatable**   |
| `subjectId`, `actorId`  | Exact match, optional                   |
| `cursor`                | The `nextCursor` from the previous page |
| `limit`                 | 1–100, default 50                       |

Every filter is an exact match. A free-text search across `before` / `after` would be a sequential scan over the largest table in the database dressed up as a feature.

**Repeatable** means `?action=user.disable&action=user.enable` is read as a set and answered with `IN (…)` — `repeatable()` in `apps/api/src/lib/query.ts`. It exists because the console's facets tick more than one box, and a filter that quietly honours only the first tick is worse than one that refuses. A single value parses as it always did.

**Paging is by cursor, not by page number.** The trail grows at the top while somebody reads it, and `?page=2` under those conditions quietly repeats rows it has already shown. The cursor is the id of the last row on screen — and because ids are UUIDv7, "older than this id" and "older than this moment" are the same ordering. The query asks for `limit + 1` rows: if the extra one comes back there is another page, and no `count(*)` over the whole table is needed to say so.

There is no `audit.service.ts`. Nothing here decides anything. Add one the moment a filter starts depending on who is asking.

## The console page

`AuditLogPage.vue` is a `DataTable` in `cursor` mode — see [`data-table.md`](data-table.md). Its footer offers **Previous** and **Next** and no page count, because there is no honest count to print. Action and subject-type facets narrow it; `⋯` opens the entry's before/after as raw JSON in a dialog, on purpose: the shape differs per action, and a table built for `users` would silently drop half of a `roles` entry.

A keyset cannot be walked backwards, so the page remembers the cursor each page started from:

```ts
const trail = ref<(string | null)[]>([null])
const index = ref(0)
```

**Next** appends the current `nextCursor` and steps forward; **Previous** steps the index back and re-requests with a cursor already used. One array is the whole cost of offering a Previous button without inventing a page number.

`ACTIONS` in that file lists the eight actions this template writes. Extend it as you add modules that record one:

```text
user.invite · user.invite_resend · user.update · user.enable · user.disable
role.create · role.update · role.delete
```

## Conventions

- Record anything somebody may have to answer for later: access granted or taken away, accounts switched off, roles edited. Not reads, and not routine noise — a trail nobody can scan is a trail nobody reads.
- `action` reuses the permission vocabulary: `<subject>.<verb>`, past-tense-free.
- Always pass the caller's transaction handle. Never open a second one for the entry.
- Use `diffFields()`. Never store a whole row.
- Add a new secret-bearing column name to `REDACTED_KEYS` in the same commit that introduces the column.
- Never add an endpoint that updates or deletes an entry.

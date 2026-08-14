import { and, desc, eq, lt, type SQL } from 'drizzle-orm'
import type { Context } from 'hono'

import { db, type DatabaseHandle } from '#db/client'
import { auditLogs, type AuditActorType } from '#db/schema'
import { clientInfo } from '#lib/request-info'
import type { AppBindings } from '#middleware/request-context'
import type { ListAuditLogsQuery } from '#modules/audit/audit.schema'

/**
 * Writing and reading the "who changed what" trail.
 *
 * Two things about the write path matter more than the rest:
 *
 * - `recordAudit(handle, actor, entry)` takes the database handle **from the caller**, so
 *   it joins their transaction. A change that commits while its trail entry rolls back —
 *   or the reverse — is a state that must not be reachable.
 * - `actorFromContext(c)` builds the actor from the request, kept separate so `recordAudit`
 *   stays callable from a scheduled job that has no `Context` at all.
 */

/** Keys whose **values** must never reach `before` / `after`. */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'passwordHash',
  'password_hash',
  'inviteTokenHash',
  'invite_token_hash',
  'tokenHash',
  'token_hash',
  'token',
  'password',
])

const REDACTED = '[redacted]'

export type AuditActor = {
  type: AuditActorType
  id?: string | undefined
  label?: string | undefined
  requestId?: string | undefined
  ipAddress?: string | undefined
}

export type AuditEntry = {
  /** The same vocabulary as the permission keys: `user.disable`, `role.update`, … */
  action: string
  /** The table acted on: `users`, `roles`. */
  subjectType: string
  subjectId?: string | undefined
  /** Readable by a human: `member@example.com`. */
  subjectLabel?: string | undefined
  before?: Record<string, unknown> | undefined
  after?: Record<string, unknown> | undefined
  reason?: string | undefined
}

export async function recordAudit(
  handle: DatabaseHandle,
  actor: AuditActor,
  entry: AuditEntry,
): Promise<void> {
  await handle.insert(auditLogs).values({
    actorType: actor.type,
    actorId: actor.id ?? null,
    actorLabel: actor.label ?? null,
    requestId: actor.requestId ?? null,
    ipAddress: actor.ipAddress ?? null,

    action: entry.action,
    subjectType: entry.subjectType,
    subjectId: entry.subjectId ?? null,
    subjectLabel: entry.subjectLabel ?? null,
    before: entry.before ? redact(entry.before) : null,
    after: entry.after ? redact(entry.after) : null,
    reason: entry.reason ?? null,
  })
}

/**
 * Build the actor from the request in flight.
 *
 * `actorLabel` stores the email **as it was at the time** rather than pointing at the user
 * row. People change their email address, and a row holding nothing but a uuid becomes
 * unreadable the moment the account behind it is erased.
 */
export function actorFromContext(c: Context<AppBindings>): AuditActor {
  const session = c.get('session')
  const { ipAddress } = clientInfo(c)
  const base = { requestId: c.get('requestId'), ipAddress: ipAddress ?? undefined }

  if (!session) return { type: 'system', ...base }

  return { type: 'user', id: session.user.id, label: session.user.email, ...base }
}

export type AuditLogRow = {
  id: string
  actorType: AuditActorType
  actorId: string | null
  actorLabel: string | null
  action: string
  subjectType: string
  subjectId: string | null
  subjectLabel: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reason: string | null
  createdAt: Date
}

export type AuditLogPage = {
  items: AuditLogRow[]
  /** Pass back as `cursor` for the next page; `null` once there is nothing older. */
  nextCursor: string | null
}

/**
 * The reader behind `GET /audit-logs`.
 *
 * Paginated by **keyset**, not by `offset`. The primary key is a UUIDv7, so ordering by
 * `id` is ordering by time, and "everything older than the last row I saw" is one indexed
 * comparison. An `offset` would make page 400 read the 399 pages before it, and — worse
 * here — rows written while somebody is paging would shift every later page along by one.
 */
export async function listAuditLogs(query: ListAuditLogsQuery): Promise<AuditLogPage> {
  const filters: SQL[] = []

  if (query.action) filters.push(eq(auditLogs.action, query.action))
  if (query.subjectType) filters.push(eq(auditLogs.subjectType, query.subjectType))
  if (query.subjectId) filters.push(eq(auditLogs.subjectId, query.subjectId))
  if (query.actorId) filters.push(eq(auditLogs.actorId, query.actorId))
  if (query.cursor) filters.push(lt(auditLogs.id, query.cursor))

  // One row more than asked for: if it comes back, there is a next page — and no separate
  // `count(*)` over the whole table just to answer that.
  const rows = await db
    .select({
      id: auditLogs.id,
      actorType: auditLogs.actorType,
      actorId: auditLogs.actorId,
      actorLabel: auditLogs.actorLabel,
      action: auditLogs.action,
      subjectType: auditLogs.subjectType,
      subjectId: auditLogs.subjectId,
      subjectLabel: auditLogs.subjectLabel,
      before: auditLogs.before,
      after: auditLogs.after,
      reason: auditLogs.reason,
      createdAt: auditLogs.createdAt,
    })
    .from(auditLogs)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(auditLogs.id))
    .limit(query.limit + 1)

  const items = rows.slice(0, query.limit)
  const nextCursor = rows.length > query.limit ? (items.at(-1)?.id ?? null) : null

  return { items, nextCursor }
}

/**
 * The columns that genuinely changed, each with its old and new value.
 *
 * Storing the whole row feels safer and is not: the audit entry becomes a copy of the
 * table — including columns that had nothing to do with the change — in the one place
 * people look when they are investigating something. The question being answered is "what
 * changed", not "what did the row look like".
 */
export function diffFields<T extends Record<string, unknown>>(
  before: T,
  after: Partial<T>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {}
  const changedAfter: Record<string, unknown> = {}

  for (const [key, next] of Object.entries(after)) {
    // A key invented by a request body must not be able to fabricate a change.
    if (!(key in before)) continue
    if (sameValue(before[key], next)) continue

    changedBefore[key] = before[key]
    changedAfter[key] = next
  }

  if (Object.keys(changedAfter).length === 0) return null
  return { before: changedBefore, after: changedAfter }
}

/** `Date` is compared by value; two equal instants are still two different objects. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Replace secret values with a marker instead of dropping their keys.
 *
 * The key stays on purpose: "the password was changed" is exactly what somebody
 * investigating wants to see, and removing the key makes that change invisible. Only the
 * value goes.
 */
export function redact(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, item] of Object.entries(value)) {
    if (REDACTED_KEYS.has(key)) {
      // `null` is left as it is, so "never set" stays distinguishable from "set, hidden".
      out[key] = item == null ? item : REDACTED
      continue
    }
    out[key] =
      item && typeof item === 'object' && !Array.isArray(item) && !(item instanceof Date)
        ? redact(item as Record<string, unknown>)
        : item
  }

  return out
}

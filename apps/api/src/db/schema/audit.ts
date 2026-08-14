import { index, jsonb, pgEnum, pgTable, text, uuid } from 'drizzle-orm/pg-core'

import { primaryId, timestamptz } from '#db/columns'

/**
 * The trail of who changed what.
 *
 * What belongs here is the handful of actions **somebody may later have to answer for**:
 * access granted or revoked, an account disabled, a role edited. Not every request — pino
 * already logs those, and a table that records everything is a table nobody ever reads.
 *
 * Rows here are **never UPDATEd and never DELETEd**. A trail you can edit is not a trail.
 * That is why there is no `updated_at` and no soft delete below; removing rows is a
 * retention policy decision, made deliberately in a migration.
 */

/**
 * The actor is not always a person. `system` covers scheduled jobs and the seeder — work
 * that changes rows with no request behind it. Add a member here (`device`, `api_key`, …)
 * when you add a principal that can act; the enum is what stops the column from turning
 * into free text.
 */
export const auditActorType = pgEnum('audit_actor_type', ['user', 'system'])

export type AuditActorType = (typeof auditActorType.enumValues)[number]

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: primaryId(),

    actorType: auditActorType('actor_type').notNull(),
    /**
     * The actor's id **without a foreign key**, and that is deliberate: a user erased at
     * their own request must not take with them the record that they once disabled
     * somebody else's account. `actor_label` keeps the name and email exactly as they read
     * at the time, so the row still means something once the account is gone.
     */
    actorId: uuid('actor_id'),
    actorLabel: text('actor_label'),

    /** `user.disable`, `role.update`, … — the same vocabulary as the permission keys. */
    action: text('action').notNull(),

    /** What was acted on: `users`, `roles` … plus the id of the row. */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id'),
    /** Something a human can read, e.g. `member@example.com`. */
    subjectLabel: text('subject_label'),

    /**
     * Only the columns that changed, not the whole row. A full snapshot sounds safer and
     * is the opposite: `password_hash` and every other secret would land in the one table
     * people open most often when investigating something.
     */
    before: jsonb('before'),
    after: jsonb('after'),

    /** Why — the UI asks for it on the destructive actions. */
    reason: text('reason'),

    requestId: text('request_id'),
    ipAddress: text('ip_address'),

    /**
     * `created_at` alone, not `...timestamps()`. The row never changes, so an `updated_at`
     * that is forever equal to `created_at` would only invite somebody to believe editing
     * the trail is allowed.
     */
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (table) => [
    /** The question is always "what happened recently", so time leads the index. */
    index('audit_logs_created_idx').on(table.createdAt.desc()),
    index('audit_logs_subject_idx').on(table.subjectType, table.subjectId),
    index('audit_logs_actor_idx').on(table.actorId),
  ],
)

export type AuditLog = typeof auditLogs.$inferSelect
export type NewAuditLog = typeof auditLogs.$inferInsert

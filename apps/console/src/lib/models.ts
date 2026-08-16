import type { InferResponseType } from 'hono/client'

import type { api } from '@/lib/api'

/**
 * The shapes the pages work with, derived straight from the API routes.
 *
 * Not one type here is written by hand — every one of them is read out of `AppType`. A
 * column that disappears from the backend becomes a TypeScript error in the page that used
 * it, rather than an `undefined` somebody notices on screen a week later.
 *
 * Note that a `Date` in the API arrives as a `string` here. That is exactly what
 * `JSON.stringify` produces, and it is worth having the type say so instead of pretending
 * the wire carries `Date` objects.
 */

/**
 * A module's own types live with its calls, in `features/<module>/api.ts`, and are
 * re-exported here so that `@/lib/models` stays the one import a page reaches for. What is
 * declared *here* is what belongs to no single module.
 */
export type { JobStatus, JobSummary } from '@/features/jobs/api'
export type { MailMessage, MailStatus } from '@/features/mail/api'
export type { ScheduleRun, ScheduleSummary } from '@/features/schedules/api'
export type { PermissionCatalog, RoleSummary } from '@/features/roles/api'
export type { UserRoleRef, UserStatus, UserSummary } from '@/features/users/api'

export type AuditLogEntry = InferResponseType<(typeof api)['audit-logs']['$get']>['items'][number]

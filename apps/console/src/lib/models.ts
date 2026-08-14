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

export type UserSummary = InferResponseType<typeof api.users.$get>['items'][number]
export type UserStatus = UserSummary['status']
export type UserRoleRef = UserSummary['roles'][number]

export type RoleSummary = InferResponseType<typeof api.roles.$get>['items'][number]

/**
 * The catalog *and* what the caller holds, in one type — because that is how the endpoint
 * answers, and because the role matrix cannot be rendered correctly from either half
 * alone: the first decides the rows, the second decides which ticks may be touched.
 */
export type PermissionCatalog = InferResponseType<typeof api.roles.permissions.$get>

export type AuditLogEntry = InferResponseType<(typeof api)['audit-logs']['$get']>['items'][number]

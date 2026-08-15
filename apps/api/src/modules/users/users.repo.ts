import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import type { PgColumn } from 'drizzle-orm/pg-core'

import { db, type DatabaseHandle } from '#db/client'
import { roles, userRoles, users, type UserStatus } from '#db/schema'
import type { ListUsersSort } from '#modules/users/users.schema'

/**
 * Reading and writing the user list and the roles attached to it.
 *
 * Every function here takes the database handle from its caller rather than reaching for
 * the module-level `db`. That is what lets a service run the write and its audit entry
 * inside one transaction — see `recordAudit`.
 */

export type UserRole = {
  roleId: string
  roleKey: string
  roleName: string
}

export type UserRow = {
  id: string
  email: string
  name: string
  status: UserStatus
  lastLoginAt: Date | null
  inviteExpiresAt: Date | null
  createdAt: Date
}

export type UserWithRoles = UserRow & { roles: UserRole[] }

const userColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
  inviteExpiresAt: users.inviteExpiresAt,
  createdAt: users.createdAt,
} as const

/**
 * The orderings this table offers, mapped to the columns behind them.
 *
 * A whitelist, not a lookup convenience: `sort` arrives from a query string, and the only
 * reason it can never carry SQL is that it is used to *pick* from this object rather than
 * being interpolated anywhere. The keys are the same enum `listUsersQuery` validates.
 */
const SORTABLE = {
  name: users.name,
  email: users.email,
  status: users.status,
  lastLoginAt: users.lastLoginAt,
  createdAt: users.createdAt,
} as const satisfies Record<ListUsersSort, PgColumn>

export type ListUsersFilter = {
  /** Any of these statuses. Empty or absent means all of them. */
  status?: readonly UserStatus[] | undefined
  q?: string | undefined
  /** Anyone holding at least one of these roles. */
  roleId?: readonly string[] | undefined
  page: number
  perPage: number
  sort: ListUsersSort
  order: 'asc' | 'desc'
}

export type ListUsersPage = {
  rows: UserWithRoles[]
  /** Rows matching the filter, not rows returned — the pager needs the first number. */
  total: number
}

export async function listUsers(filter: ListUsersFilter): Promise<ListUsersPage> {
  const where: SQL[] = [isNull(users.deletedAt)]
  if (filter.status?.length) where.push(inArray(users.status, [...filter.status]))
  if (filter.q) {
    const needle = `%${escapeLike(filter.q)}%`
    where.push(or(ilike(users.name, needle), ilike(users.email, needle)) as SQL)
  }
  if (filter.roleId?.length) {
    // A subquery rather than a join: joining `user_roles` multiplies a user by the number
    // of roles they hold, which would repeat rows here and inflate the count beside them.
    where.push(
      inArray(
        users.id,
        db
          .select({ userId: userRoles.userId })
          .from(userRoles)
          .where(inArray(userRoles.roleId, [...filter.roleId])),
      ),
    )
  }

  const condition = and(...where)
  const direction = filter.order === 'desc' ? desc : asc

  const [rows, [counted]] = await Promise.all([
    db
      .select(userColumns)
      .from(users)
      .where(condition)
      // `id` breaks ties. Sorting by `status` alone leaves rows with the same status in
      // whatever order the plan happens to produce, and two pages of an unstable sort can
      // show the same person twice while skipping somebody else entirely.
      .orderBy(direction(SORTABLE[filter.sort]), asc(users.id))
      .limit(filter.perPage)
      .offset((filter.page - 1) * filter.perPage),

    // The same `where`, deliberately. A count over a different condition is a pager that
    // promises pages which are not there.
    db.select({ value: count() }).from(users).where(condition),
  ])

  return { rows: await attachRoles(db, rows), total: counted?.value ?? 0 }
}

export async function findUser(handle: DatabaseHandle, id: string): Promise<UserWithRoles | null> {
  const [row] = await handle
    .select(userColumns)
    .from(users)
    .where(and(eq(users.id, id), isNull(users.deletedAt)))
    .limit(1)

  if (!row) return null

  const [withRoles] = await attachRoles(handle, [row])
  return withRoles ?? null
}

/** Matched through `lower()` so it agrees with the unique index on the column. */
export async function emailTaken(handle: DatabaseHandle, address: string): Promise<boolean> {
  const [row] = await handle
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${address})`)
    .limit(1)

  return row !== undefined
}

async function attachRoles(
  handle: DatabaseHandle,
  rows: readonly UserRow[],
): Promise<UserWithRoles[]> {
  if (rows.length === 0) return []

  const assigned = await loadUserRoles(
    handle,
    rows.map((row) => row.id),
  )

  return rows.map((row) => ({ ...row, roles: assigned.get(row.id) ?? [] }))
}

export async function loadUserRoles(
  handle: DatabaseHandle,
  userIds: readonly string[],
): Promise<Map<string, UserRole[]>> {
  if (userIds.length === 0) return new Map()

  const rows = await handle
    .select({
      userId: userRoles.userId,
      roleId: roles.id,
      roleKey: roles.key,
      roleName: roles.name,
    })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(inArray(userRoles.userId, [...userIds]))
    .orderBy(asc(roles.name))

  const byUser = new Map<string, UserRole[]>()
  for (const row of rows) {
    const bucket = byUser.get(row.userId) ?? []
    bucket.push({ roleId: row.roleId, roleKey: row.roleKey, roleName: row.roleName })
    byUser.set(row.userId, bucket)
  }

  return byUser
}

/**
 * Replace a user's roles wholesale.
 *
 * Delete-then-write, not a diff. A diff saves a query and adds a path that can be wrong
 * without looking wrong — and this is access data, where "one row that was not deleted"
 * means somebody still holds what was supposed to be taken away. The lists are always
 * short.
 */
export async function replaceUserRoles(
  handle: DatabaseHandle,
  userId: string,
  wanted: readonly string[],
): Promise<void> {
  await handle.delete(userRoles).where(eq(userRoles.userId, userId))
  if (wanted.length === 0) return

  await handle
    .insert(userRoles)
    .values(wanted.map((roleId) => ({ userId, roleId })))
    // The payload is allowed to repeat itself; the composite primary key is the referee,
    // not an extra check up here.
    .onConflictDoNothing()
}

/** `%`, `_` and `\` typed into a search box are literal characters, not wildcards. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

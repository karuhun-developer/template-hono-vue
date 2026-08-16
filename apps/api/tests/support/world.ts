import type { PermissionKey } from '@app/contract'
import { eq, like, sql } from 'drizzle-orm'

import { db } from '#db/client'
import {
  auditLogs,
  mailMessages,
  rolePermissions,
  roles,
  userRoles,
  users,
  type MailMessage,
  type UserStatus,
} from '#db/schema'
import { env } from '#env'
import { hashPassword } from '#lib/password'
import { syncPermissionCatalog } from '#modules/rbac/rbac.service'

/**
 * Shared scaffolding for the integration suites.
 *
 * The suites run against one real database, so every fixture is **tagged**: emails end in
 * `@<tag>.test` and role keys start with `<tag>-`. `cleanFixtures(tag)` then removes
 * exactly what a suite created and nothing that belongs to another one — which is what
 * makes `fileParallelism: false` a safety net rather than the only thing keeping the
 * suites apart.
 *
 * Requests go through `app.request()`, so what is exercised is the whole stack: the
 * middleware, zod validation, `onError`, and the `Set-Cookie` header. Auth bugs live in
 * the joints between layers far more often than inside one of them.
 */

export const TEST_PASSWORD = 'test-password-2026'

/** One hashing pass for the whole file — argon2id is deliberately slow. */
let cachedHash: Promise<string> | null = null

function testPasswordHash(): Promise<string> {
  cachedHash ??= hashPassword(TEST_PASSWORD)
  return cachedHash
}

export function emailFor(tag: string, local: string): string {
  return `${local}@${tag}.test`
}

export async function cleanFixtures(tag: string): Promise<void> {
  // Users first: their `user_roles` rows go with them through the cascade, and
  // `user_roles.role_id` is ON DELETE RESTRICT, so roles cannot go before their holders.
  await db.delete(users).where(like(users.email, `%@${tag}.test`))
  await db.delete(roles).where(like(roles.key, `${tag}-%`))
  await db.delete(auditLogs).where(like(auditLogs.actorLabel, `%@${tag}.test`))
  await db.delete(auditLogs).where(like(auditLogs.subjectLabel, `%@${tag}.test`))
  // Mail is addressed to the same tagged addresses, and a message outlives its recipient
  // on purpose — nothing cascades it away.
  await db.delete(mailMessages).where(like(mailMessages.toEmail, `%@${tag}.test`))
}

/**
 * The newest message sent to an address, or `null`.
 *
 * Reads the whole row, `payload` included — which is the one place in the repository
 * outside the send job that does. A suite asserting that a token is **not** in the stored
 * body has to be able to see what the body actually is.
 */
export async function lastMailTo(email: string): Promise<MailMessage | null> {
  const [row] = await db
    .select()
    .from(mailMessages)
    .where(eq(mailMessages.toEmail, email))
    .orderBy(sql`${mailMessages.createdAt} desc`)
    .limit(1)

  return row ?? null
}

/** The permission catalog has to exist before any role can reference a key. */
export async function ensureCatalog(): Promise<void> {
  await syncPermissionCatalog(db)
}

export async function createRole(
  tag: string,
  key: string,
  permissions: readonly PermissionKey[],
  options: { isSystem?: boolean } = {},
): Promise<string> {
  const [role] = await db
    .insert(roles)
    .values({
      key: `${tag}-${key}`,
      name: key,
      isSystem: options.isSystem ?? false,
    })
    .returning({ id: roles.id })

  if (!role) throw new Error(`could not create the ${key} test role`)

  if (permissions.length > 0) {
    await db
      .insert(rolePermissions)
      .values(permissions.map((permissionKey) => ({ roleId: role.id, permissionKey })))
  }

  return role.id
}

export async function createUser(
  email: string,
  options: { name?: string; status?: UserStatus; roleIds?: readonly string[] } = {},
): Promise<string> {
  const status = options.status ?? 'active'

  const [user] = await db
    .insert(users)
    .values({
      email,
      name: options.name ?? email,
      // An invited account has no password yet — that is the whole point of the status.
      passwordHash: status === 'invited' ? null : await testPasswordHash(),
      status,
    })
    .returning({ id: users.id })

  if (!user) throw new Error(`could not create the test user ${email}`)

  for (const roleId of options.roleIds ?? []) {
    await db.insert(userRoles).values({ userId: user.id, roleId })
  }

  return user.id
}

// --- Talking to the app -----------------------------------------------------

export type RequestInit_ = {
  method?: string
  body?: unknown
  cookie?: string | null
  headers?: Record<string, string>
}

/**
 * Anything that can answer a request — the real `app`, or a throwaway one mounting a single
 * middleware. Hono's `request()` is typed `Response | Promise<Response>`, so this signature
 * has to allow both.
 */
export type Requestable = {
  request: (path: string, init: RequestInit) => Response | Promise<Response>
}

export async function request(
  app: Requestable,
  path: string,
  init: RequestInit_ = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...init.headers }
  if (init.cookie) headers['cookie'] = `${env.SESSION_COOKIE_NAME}=${init.cookie}`

  return app.request(path, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
}

/** The session cookie value out of a `Set-Cookie` header, or `null` if none was set. */
export function sessionCookie(res: Response): string | null {
  const raw = res.headers.get('set-cookie')
  const match = raw ? new RegExp(`${env.SESSION_COOKIE_NAME}=([^;]*)`).exec(raw) : null
  const value = match?.[1]
  return value === undefined || value === '' ? null : value
}

export async function login(
  app: Requestable,
  email: string,
  password: string = TEST_PASSWORD,
): Promise<string> {
  const res = await request(app, '/auth/login', {
    method: 'POST',
    body: { email, password },
  })

  const token = sessionCookie(res)
  if (!token) throw new Error(`login as ${email} failed: ${res.status} ${await res.text()}`)
  return token
}

/** How many audit rows a suite's actor has written for one action. */
export async function countAuditRows(tag: string, action: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(sql`${auditLogs.action} = ${action} and ${auditLogs.actorLabel} like ${`%@${tag}.test`}`)

  return row?.total ?? 0
}

export { db, eq }

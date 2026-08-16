import { isPermissionKey, type PermissionKey } from '@app/contract'
import { eq } from 'drizzle-orm'

import { cache, forget, remember, type CacheDriver } from '#cache/cache'
import { db } from '#db/client'
import { rolePermissions, userRoles } from '#db/schema'
import { env } from '#env'

/**
 * Works out what a user is allowed to do.
 *
 * The answer is a flat set, because in a single-tenant application there is exactly one
 * scope. If you later add tenants or branches, this is the type that has to grow a second
 * dimension — and docs/guides/add-multi-tenancy.md walks through what that costs.
 *
 * This is also the hottest read in the codebase — one query on every authenticated request —
 * which is why it is the one thing with an optional cache in front of it. See
 * `CACHE_ACCESS_PERMISSIONS`, which is **off** by default, and the invalidation matrix in
 * `docs/features/cache.md`.
 */

export type AccessContext = {
  userId: string
  permissions: ReadonlySet<PermissionKey>
}

/**
 * One cache entry per user, so invalidation can be exact.
 *
 * A single entry holding every user's permissions would have to be rewritten whenever
 * anybody's roles changed, which under load is a value that is never warm.
 */
function accessKey(userId: string): string {
  return `access:${userId}`
}

/**
 * Load a user's permissions in one query.
 *
 * The `userId` comes from a verified session row, never from a client.
 *
 * What is cached is the **raw** list of keys as the database holds it, and the filtering
 * happens on the way out — on the cached path as well as the fresh one. A key that was in
 * the catalog when the entry was written and has since been renamed away therefore still
 * grants nothing, rather than being honoured until the entry expires.
 */
export async function loadAccess(
  userId: string,
  driver: CacheDriver = cache,
): Promise<AccessContext> {
  if (!env.CACHE_ACCESS_PERMISSIONS) {
    return { userId, permissions: toPermissions(await readPermissionKeys(userId)) }
  }

  const keys = await remember(
    accessKey(userId),
    env.CACHE_ACCESS_TTL_SECONDS * 1000,
    () => readPermissionKeys(userId),
    driver,
  )

  return { userId, permissions: toPermissions(keys) }
}

/**
 * Drop one user's cached permissions.
 *
 * Call it from `defer`, **after** the commit. Dropping the entry inside the transaction that
 * changed the roles means any concurrent request can re-read the old rows and cache them
 * again before the commit lands, at which point the stale value is the one that survives —
 * see the note at the top of `db/tx.ts`.
 */
export async function forgetAccess(userId: string, driver: CacheDriver = cache): Promise<void> {
  // Nothing was written, so there is nothing to drop. Without this the `database` driver
  // would run a DELETE on every user edit in every installation that never turned the
  // feature on, which is a cost paid for a row that cannot exist.
  if (!env.CACHE_ACCESS_PERMISSIONS) return

  await forget(accessKey(userId), driver)
}

/**
 * Drop the cached permissions of everybody holding a role.
 *
 * The explicit fan-out the cache's header talks about, and the reason there is no tag
 * support: `user_roles` already answers "who holds this", so the alternative would be a
 * second index maintained inside every driver to answer a question one join answers here.
 *
 * It reads through `db` rather than a transaction handle on purpose — it runs post-commit,
 * when the `tx` it would have been given is already closed, and the rows it needs are the
 * committed ones.
 */
export async function forgetAccessForRole(
  roleId: string,
  driver: CacheDriver = cache,
): Promise<void> {
  if (!env.CACHE_ACCESS_PERMISSIONS) return

  const holders = await db
    .select({ userId: userRoles.userId })
    .from(userRoles)
    .where(eq(userRoles.roleId, roleId))

  // Sequentially, not `Promise.all`: this is invalidation after a role edit, not a request
  // path, and a hundred holders is a hundred round trips either way. Serial keeps it from
  // being a burst against whichever store the cache lives in.
  for (const holder of holders) {
    await forget(accessKey(holder.userId), driver)
  }
}

/** Is this user allowed to do `permission`? */
export function can(access: AccessContext, permission: PermissionKey): boolean {
  return access.permissions.has(permission)
}

/** Everything the user holds — used to render the console's navigation. */
export function allPermissions(access: AccessContext): PermissionKey[] {
  return [...access.permissions].sort()
}

// --- Internals --------------------------------------------------------------

/** The keys as the database holds them, unfiltered — which is also what is cached. */
async function readPermissionKeys(userId: string): Promise<string[]> {
  const rows = await db
    .select({ permissionKey: rolePermissions.permissionKey })
    .from(userRoles)
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, userRoles.roleId))
    .where(eq(userRoles.userId, userId))

  return rows.map((row) => row.permissionKey)
}

/**
 * A key that is in the database but has since disappeared from the catalog is ignored. An
 * unrecognised permission must not grant access to anything — whether it arrived from a
 * query a moment ago or from a cache entry written before the rename.
 */
function toPermissions(keys: readonly string[]): ReadonlySet<PermissionKey> {
  const permissions = new Set<PermissionKey>()
  for (const key of keys) {
    if (isPermissionKey(key)) permissions.add(key)
  }
  return permissions
}

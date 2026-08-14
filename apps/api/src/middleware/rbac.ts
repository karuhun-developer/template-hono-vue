import type { PermissionKey } from '@app/contract'
import type { MiddlewareHandler } from 'hono'

import { forbidden } from '#lib/errors'
import type { AppBindings } from '#middleware/request-context'
import { currentAccess } from '#middleware/session'
import { can } from '#modules/rbac/rbac.repo'

/**
 * Permission checks, mounted on the route — not buried inside a service.
 *
 * On the route, so the access requirement reads next to the method and the path. A route
 * that names no permission then looks suspicious at a glance, and that property is worth
 * more than tidiness.
 */
export const requirePermission = (
  ...permissions: readonly [PermissionKey, ...PermissionKey[]]
): MiddlewareHandler<AppBindings> => {
  return async (c, next) => {
    const access = currentAccess(c)

    // Several permissions mean **all** of them, not any. "Any" is a dangerous default: a
    // route needing `user.disable` + `audit.read` would let through whoever holds the
    // easier one. Anything that genuinely wants "any" says so with `requireAnyPermission()`.
    const missing = permissions.filter((permission) => !can(access, permission))
    if (missing.length > 0) {
      c.get('logger').warn({ userId: access.userId, missing }, 'permission denied')
      throw forbidden()
    }

    await next()
  }
}

export const requireAnyPermission = (
  ...permissions: readonly [PermissionKey, ...PermissionKey[]]
): MiddlewareHandler<AppBindings> => {
  return async (c, next) => {
    const access = currentAccess(c)

    if (!permissions.some((permission) => can(access, permission))) {
      c.get('logger').warn({ userId: access.userId, permissions }, 'permission denied')
      throw forbidden()
    }

    await next()
  }
}

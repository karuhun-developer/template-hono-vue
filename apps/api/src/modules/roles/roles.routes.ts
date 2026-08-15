import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { badRequest } from '#lib/errors'
import { requirePermission } from '#middleware/rbac'
import type { AppBindings } from '#middleware/request-context'
import { currentAccess, requireAuth } from '#middleware/session'
import { actorFromContext } from '#modules/audit/audit.repo'
import { listRoles } from '#modules/roles/roles.repo'
import { createRoleBody, listRolesQuery, updateRoleBody } from '#modules/roles/roles.schema'
import { createRole, deleteRole, permissionCatalog, updateRole } from '#modules/roles/roles.service'

/**
 * Role management.
 *
 * `/permissions` is registered **before** `/:id`. The other way round, Hono matches it as
 * a role id and rejects it as an invalid uuid — a five-minute bug that reads like a
 * validation problem.
 */

const validationHook = (result: { success: boolean; error?: unknown }): void => {
  if (result.success) return
  throw badRequest('The details you sent are not valid.', result.error)
}

const idParam = z.object({ id: z.uuid('Not a valid role id.') })

export const roleRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())

  .get(
    '/',
    requirePermission('role.read'),
    zValidator('query', listRolesQuery, validationHook),
    async (c) => {
      const query = c.req.valid('query')
      const { rows, total } = await listRoles(query)

      return c.json({ items: rows, total, page: query.page, perPage: query.perPage })
    },
  )

  /**
   * The permission catalog together with what the caller holds. Both in one response,
   * because the role matrix cannot be rendered correctly without both: the first decides
   * the rows, the second decides which ticks may be touched.
   */
  .get('/permissions', requirePermission('role.read'), (c) => {
    return c.json(permissionCatalog(currentAccess(c)))
  })

  .post(
    '/',
    requirePermission('role.manage'),
    zValidator('json', createRoleBody, validationHook),
    async (c) => {
      const role = await createRole(currentAccess(c), actorFromContext(c), c.req.valid('json'))

      c.get('logger').info({ roleId: role.id, key: role.key }, 'role created')
      return c.json({ role }, 201)
    },
  )

  .patch(
    '/:id',
    requirePermission('role.manage'),
    zValidator('param', idParam, validationHook),
    zValidator('json', updateRoleBody, validationHook),
    async (c) => {
      const role = await updateRole(
        currentAccess(c),
        actorFromContext(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      )

      return c.json({ role })
    },
  )

  .delete(
    '/:id',
    requirePermission('role.manage'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      await deleteRole(actorFromContext(c), c.req.valid('param').id)
      return c.json({ ok: true as const })
    },
  )

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { badRequest } from '#lib/errors'
import { requirePermission } from '#middleware/rbac'
import type { AppBindings } from '#middleware/request-context'
import { currentAccess, requireAuth } from '#middleware/session'
import { actorFromContext } from '#modules/audit/audit.repo'
import { inviteUserBody, listUsersQuery, updateUserBody } from '#modules/users/users.schema'
import {
  inviteUser,
  listVisibleUsers,
  resendInvite,
  setUserStatus,
  updateUser,
} from '#modules/users/users.service'

/**
 * User management.
 *
 * The invitation token appears in the response of `POST /users` and
 * `POST /users/:id/invite` — once. It can never be read back from `GET /users`, because
 * what is stored is only its hash, exactly as with a session token. Hand it to the person
 * however you hand things to people; wiring up an email sender is one of the first things
 * a real project adds.
 */

const validationHook = (result: { success: boolean; error?: unknown }): void => {
  if (result.success) return
  throw badRequest('The details you sent are not valid.', result.error)
}

const idParam = z.object({ id: z.uuid('Not a valid user id.') })

const statusBody = z.object({ status: z.enum(['active', 'disabled']) })

export const userRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())

  .get(
    '/',
    requirePermission('user.read'),
    zValidator('query', listUsersQuery, validationHook),
    async (c) => {
      return c.json({ items: await listVisibleUsers(c.req.valid('query')) })
    },
  )

  .post(
    '/',
    requirePermission('user.invite'),
    zValidator('json', inviteUserBody, validationHook),
    async (c) => {
      const result = await inviteUser(currentAccess(c), actorFromContext(c), c.req.valid('json'))

      c.get('logger').info({ userId: result.user.id }, 'user invited')
      return c.json(result, 201)
    },
  )

  .post(
    '/:id/invite',
    requirePermission('user.invite'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      const result = await resendInvite(actorFromContext(c), c.req.valid('param').id)

      c.get('logger').info({ userId: result.user.id }, 'invitation re-sent')
      return c.json(result)
    },
  )

  .patch(
    '/:id',
    requirePermission('user.update'),
    zValidator('param', idParam, validationHook),
    zValidator('json', updateUserBody, validationHook),
    async (c) => {
      const user = await updateUser(
        currentAccess(c),
        actorFromContext(c),
        c.req.valid('param').id,
        c.req.valid('json'),
      )

      return c.json({ user })
    },
  )

  /**
   * Enabling and disabling sits behind its own permission and its own endpoint rather than
   * being a field on `PATCH /users/:id`. Locking somebody out is not the same kind of act
   * as correcting the spelling of their name, and the audit entry it writes should not
   * depend on somebody remembering to look at a `status` key in a request body.
   */
  .post(
    '/:id/status',
    requirePermission('user.disable'),
    zValidator('param', idParam, validationHook),
    zValidator('json', statusBody, validationHook),
    async (c) => {
      const user = await setUserStatus(
        currentAccess(c),
        actorFromContext(c),
        c.req.valid('param').id,
        c.req.valid('json').status,
      )

      c.get('logger').info({ userId: user.id, status: user.status }, 'user status changed')
      return c.json({ user })
    },
  )

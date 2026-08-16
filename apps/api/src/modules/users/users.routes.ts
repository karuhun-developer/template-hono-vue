import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { badRequest } from '#lib/errors'
import { requirePermission } from '#middleware/rbac'
import type { AppBindings } from '#middleware/request-context'
import { currentAccess, requireAuth } from '#middleware/session'
import { actorFromContext } from '#modules/audit/audit.repo'
import {
  createUserBody,
  inviteUserBody,
  listUsersQuery,
  updateUserBody,
} from '#modules/users/users.schema'
import {
  createUser,
  deleteUser,
  getUser,
  inviteUser,
  listVisibleUsers,
  resendInvite,
  restoreUser,
  setUserStatus,
  triggerPasswordReset,
  updateUser,
} from '#modules/users/users.service'

/**
 * User management.
 *
 * Every route that issues a one-time link **sends it by email**, from inside the same
 * transaction that issued it. `POST /users`, `POST /users/:id/invite` and
 * `POST /users/:id/reset-password` additionally carry the token in their response — once,
 * and only under `MAIL_DRIVER=log`, where nothing reached an inbox and the console dialog
 * is the only way to hand somebody the link. See `revealTokens()`.
 *
 * Either way it cannot be read back from `GET /users`: what is stored is only the hash,
 * exactly as with a session token.
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
      // `{ items, total, page, perPage }`, handed back whole: the envelope is the contract
      // every list in this API answers with, and the console's derived types read `items`.
      return c.json(await listVisibleUsers(c.req.valid('query')))
    },
  )

  .get(
    '/:id',
    requirePermission('user.read'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      return c.json({ user: await getUser(c.req.valid('param').id) })
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

  /**
   * Creating an account with a password, as opposed to inviting one.
   *
   * A second route rather than a mode on `POST /users`, because the permission belongs on
   * the route, next to the method and the path. Folding both into one endpoint would mean
   * `requireAnyPermission` plus an `if` about the caller inside the handler — and a 403
   * test that can no longer say which of the two capabilities it is asserting.
   */
  .post(
    '/create',
    requirePermission('user.create'),
    zValidator('json', createUserBody, validationHook),
    async (c) => {
      const user = await createUser(currentAccess(c), actorFromContext(c), c.req.valid('json'))

      c.get('logger').info({ userId: user.id }, 'user created')
      return c.json({ user }, 201)
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

  /**
   * Deleting is soft, and restoring is its mirror — so both sit behind the same permission.
   * Splitting them would mean somebody could remove an account and then be unable to put it
   * back, which is a worse position than not being allowed to remove it at all.
   */
  .delete(
    '/:id',
    requirePermission('user.delete'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      const user = await deleteUser(currentAccess(c), actorFromContext(c), c.req.valid('param').id)

      c.get('logger').info({ userId: user.id }, 'user deleted')
      return c.json({ user })
    },
  )

  /**
   * Its own permission rather than `user.update`, because starting a credential flow on
   * somebody else's account is not the same act as correcting the spelling of their name —
   * and whoever may do the second should not automatically be able to do the first.
   */
  .post(
    '/:id/reset-password',
    requirePermission('user.reset_password'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      const result = await triggerPasswordReset(
        currentAccess(c),
        actorFromContext(c),
        c.req.valid('param').id,
      )

      c.get('logger').info({ userId: result.user.id }, 'password reset issued')
      return c.json(result)
    },
  )

  .post(
    '/:id/restore',
    requirePermission('user.delete'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      const user = await restoreUser(actorFromContext(c), c.req.valid('param').id)

      c.get('logger').info({ userId: user.id }, 'user restored')
      return c.json({ user })
    },
  )

import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'

import { badRequest } from '#lib/errors'
import { requirePermission } from '#middleware/rbac'
import type { AppBindings } from '#middleware/request-context'
import { requireAuth } from '#middleware/session'
import { listMailQuery } from '#modules/mail/mail.schema'
import { getMail, listMail } from '#modules/mail/mail.service'

/**
 * The mail log, from the outside.
 *
 * One key, `mail.read`, and it is **owner-only** — a stricter bar than the rest of the
 * Operations group, because what these two routes return is the copy of every message this
 * application has sent, including the ones addressed to whoever is asking about the person
 * they are asking about.
 *
 * There is no `POST` of any kind. Not resend (the payload is gone by the time a message is
 * terminal, so the only thing left to send is the masked copy), and not delete — retention
 * is `mail.prune`'s job, on a schedule, rather than a button that lets somebody remove the
 * record of a message they would rather nobody read.
 */

const validationHook = (result: { success: boolean; error?: unknown }): void => {
  if (result.success) return
  throw badRequest('The details you sent are not valid.', result.error)
}

const idParam = z.object({ id: z.uuid('Not a valid message id.') })

export const mailRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())

  .get(
    '/',
    requirePermission('mail.read'),
    zValidator('query', listMailQuery, validationHook),
    async (c) => {
      return c.json(await listMail(c.req.valid('query')))
    },
  )

  .get(
    '/:id',
    requirePermission('mail.read'),
    zValidator('param', idParam, validationHook),
    async (c) => {
      // Selected through `mailColumns` like everything else here, so the detail view — the
      // one place a body is actually rendered — is no closer to `payload` than the list is.
      return c.json({ message: await getMail(c.req.valid('param').id) })
    },
  )

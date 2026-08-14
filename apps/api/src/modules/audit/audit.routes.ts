import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'

import { badRequest } from '#lib/errors'
import { requirePermission } from '#middleware/rbac'
import type { AppBindings } from '#middleware/request-context'
import { requireAuth } from '#middleware/session'
import { listAuditLogs } from '#modules/audit/audit.repo'
import { listAuditLogsQuery } from '#modules/audit/audit.schema'

/**
 * Reading the audit log. **Read-only, on purpose** — there is no endpoint here that writes,
 * edits or deletes an entry. Entries are written as a side effect of the action they
 * describe, inside its transaction (see `recordAudit`), and a trail with a delete endpoint
 * is a trail that can be tidied up by whoever most wants it tidied.
 *
 * There is no `audit.service.ts`: nothing here decides anything. Add one the moment a
 * filter starts depending on who is asking.
 */

const validationHook = (result: { success: boolean; error?: unknown }): void => {
  if (result.success) return
  throw badRequest('The details you sent are not valid.', result.error)
}

export const auditRoutes = new Hono<AppBindings>()
  .use('*', requireAuth())
  .get(
    '/',
    requirePermission('audit.read'),
    zValidator('query', listAuditLogsQuery, validationHook),
    async (c) => {
      return c.json(await listAuditLogs(c.req.valid('query')))
    },
  )

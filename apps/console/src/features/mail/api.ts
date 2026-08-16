import type { InferResponseType } from 'hono/client'

import { listResult, type ResourceQuery } from '@/composables/useResourceList'
import { api } from '@/lib/api'
import { readApiError, type ApiFailure } from '@/lib/api-error'

/**
 * Everything this console knows about the mail log: the shapes, and the calls.
 *
 * Read-only, all of it, and that is the API's decision rather than an omission here. There
 * is no resend: a terminal message has had its `payload` set to `NULL`, so the only copy
 * left is the **masked** one — a button that silently delivered an invitation whose link
 * reads `[redacted]` would be worse than no button. Sending again is inviting again.
 */

const mail = api['mail-messages']

/** The envelope, because `templates` travels with the page and the facet is built from it. */
export type MailListResponse = InferResponseType<typeof mail.$get>

export type MailMessage = MailListResponse['items'][number]
export type MailStatus = MailMessage['status']

/** The keys `listMailQuery` accepts as `?sort=`. Anything else falls back to the default. */
export const MAIL_SORTABLE = ['createdAt', 'sentAt', 'status'] as const

export type MailSortKey = (typeof MAIL_SORTABLE)[number]

export type MailFilters = {
  statuses: string[]
  templates: string[]
}

export function fetchMailMessages(
  query: ResourceQuery<MailSortKey>,
  filters: MailFilters,
): Promise<MailListResponse | { failure: ApiFailure }> {
  return listResult(
    mail.$get(
      {
        query: {
          // Matched against the recipient and the subject — the two things support asks by.
          ...(query.q === '' ? {} : { q: query.q }),
          // Sent once per ticked box; the API reads a repeated parameter as a set.
          ...(filters.statuses.length === 0 ? {} : { status: filters.statuses as MailStatus[] }),
          ...(filters.templates.length === 0 ? {} : { template: filters.templates }),
          page: String(query.page),
          perPage: String(query.perPage),
          sort: query.sort,
          order: query.order,
        },
      },
      { init: { signal: query.signal } },
    ),
  )
}

/**
 * One message, as it reads **now**.
 *
 * The list already carries the body, so this is not fetched for the content — it is fetched
 * because a message that was `queued` when the page loaded may have been sent or failed
 * since, and a preview is exactly where somebody looks to find that out. The row is what is
 * rendered until this answers, so the dialog never opens empty.
 */
export async function fetchMailMessage(
  id: string,
): Promise<{ message: MailMessage } | { failure: ApiFailure }> {
  const response = await mail[':id'].$get({ param: { id } })
  if (!response.ok) return { failure: await readApiError(response) }
  return response.json()
}

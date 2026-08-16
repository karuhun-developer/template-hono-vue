import { ref, type Ref } from 'vue'

import { useResourceList, type UseResourceList } from '@/composables/useResourceList'
import {
  fetchMailMessages,
  MAIL_SORTABLE,
  type MailMessage,
  type MailSortKey,
} from '@/features/mail/api'

/**
 * The mail list, ready to hand to `MailTable`.
 *
 * `catalog` is the template registry, and it arrives with every page rather than being
 * declared here: the console cannot import `TEMPLATES` from the API, and a hand-kept copy
 * would drift the first time somebody adds a template. The facet therefore offers exactly
 * what the running API knows about, while the filter itself still accepts any string — a
 * message sent under a template since renamed is still a row, and usually the row somebody
 * is looking for.
 */

export type UseMailList = UseResourceList<MailMessage, MailSortKey> & {
  statuses: Ref<string[]>
  templates: Ref<string[]>
  /** The template registry, for the facet. From the API, so there is no second copy. */
  catalog: Ref<string[]>
}

export function useMailList(): UseMailList {
  const statuses = ref<string[]>([])
  const templates = ref<string[]>([])

  const catalog = ref<string[]>([])

  const list = useResourceList<MailMessage, MailSortKey>({
    sortable: MAIL_SORTABLE,
    // Newest first: the question this page answers is almost always "did that just go out".
    defaultSort: { key: 'createdAt', order: 'desc' },
    filters: { statuses, templates },
    perPage: 20,
    fetch: async (query) => {
      const result = await fetchMailMessages(query, {
        statuses: statuses.value,
        templates: templates.value,
      })
      if ('failure' in result) return result

      // Kept from the last successful load, so a failed refresh does not empty the facet.
      catalog.value = [...result.templates]

      return result
    },
  })

  return { ...list, statuses, templates, catalog }
}

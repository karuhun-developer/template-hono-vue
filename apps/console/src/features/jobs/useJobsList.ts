import { ref, type Ref } from 'vue'

import { useResourceList, type UseResourceList } from '@/composables/useResourceList'
import {
  fetchJobs,
  JOB_SORTABLE,
  type JobCoverage,
  type JobSortKey,
  type JobSummary,
} from '@/features/jobs/api'

/**
 * The jobs list, ready to hand to `JobsTable`.
 *
 * Three of the fields below do not describe the rows at all — they describe the **queue**
 * the rows came out of, and they arrive with every page because they are answers to
 * questions an empty list cannot distinguish: is there nothing to show, or is this a driver
 * that stores nothing? They are kept from the last successful load, so a failed refresh does
 * not blank out the explanation of what the page is looking at.
 *
 * No search box: `listJobsQuery` offers no `q`, and its comment says why — `payload` is
 * `jsonb`, so a free-text filter over it would be a sequential scan dressed up as a feature.
 */

export type UseJobsList = UseResourceList<JobSummary, JobSortKey> & {
  statuses: Ref<string[]>
  names: Ref<string[]>
  /** What the rows mean under the configured driver: `all`, `failures` or `none`. */
  coverage: Ref<JobCoverage>
  /** False means retry and cancel would answer 409, so the table offers neither. */
  manageable: Ref<boolean>
  /** The job catalog, for the name facet. From the API, so there is no second copy. */
  catalog: Ref<string[]>
}

export function useJobsList(): UseJobsList {
  const statuses = ref<string[]>([])
  const names = ref<string[]>([])

  const coverage = ref<JobCoverage>('all')
  const manageable = ref(false)
  const catalog = ref<string[]>([])

  const list = useResourceList<JobSummary, JobSortKey>({
    sortable: JOB_SORTABLE,
    // Newest first: the question this page answers is almost always "what just happened".
    defaultSort: { key: 'createdAt', order: 'desc' },
    filters: { statuses, names },
    perPage: 20,
    fetch: async (query) => {
      const result = await fetchJobs(query, { statuses: statuses.value, names: names.value })
      if ('failure' in result) return result

      coverage.value = result.coverage
      manageable.value = result.manageable
      catalog.value = [...result.names]

      return result
    },
  })

  return { ...list, statuses, names, coverage, manageable, catalog }
}

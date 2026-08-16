import { onMounted, ref, type Ref } from 'vue'

import { fetchSchedules, type ScheduleSummary } from '@/features/schedules/api'
import { networkFailure, type ApiFailure } from '@/lib/api-error'

/**
 * The schedule list.
 *
 * Not `useResourceList`, and the reason is the same one the API gives for having no list
 * query: there is nothing to page, sort or filter. What this needs instead is the two fields
 * that describe the **scheduler** rather than the rows — the timezone every expression is
 * read in, and whether anything is ticking them at all.
 */

export type UseSchedules = {
  rows: Ref<ScheduleSummary[]>
  loading: Ref<boolean>
  failure: Ref<ApiFailure | null>
  /** The zone the cron expressions are read in. An instant means nothing without it. */
  timezone: Ref<string>
  /** False is a legitimate configuration — see the note the page renders when it is. */
  enabled: Ref<boolean>
  reload: () => Promise<void>
}

export function useSchedules(): UseSchedules {
  const rows = ref<ScheduleSummary[]>([])
  const loading = ref(true)
  const failure = ref<ApiFailure | null>(null)

  const timezone = ref('UTC')
  const enabled = ref(false)

  async function reload(): Promise<void> {
    loading.value = true
    failure.value = null

    try {
      const result = await fetchSchedules()
      if ('failure' in result) {
        failure.value = result.failure
        return
      }

      rows.value = result.items
      timezone.value = result.timezone
      enabled.value = result.enabled
    } catch (error) {
      // The request never arrived, so there is no status to read — see `networkFailure`.
      failure.value = networkFailure(error)
    } finally {
      loading.value = false
    }
  }

  onMounted(() => void reload())

  return { rows, loading, failure, timezone, enabled, reload }
}

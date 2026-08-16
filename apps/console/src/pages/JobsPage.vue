<script setup lang="ts">
import { computed, ref } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import { cancelJob, retryJob, type JobSummary } from '@/features/jobs/api'
import JobDetailSheet from '@/features/jobs/JobDetailSheet.vue'
import JobsTable from '@/features/jobs/JobsTable.vue'
import { useJobsList } from '@/features/jobs/useJobsList'

/**
 * What the queue has been doing.
 *
 * The page answers support questions — "did that invitation ever go out" — which is why
 * reading it is a different permission from changing it: running a job again executes code
 * against live data, and cancelling throws work away.
 *
 * What the rows *mean* depends on `QUEUE_DRIVER`, and the note below says which of the three
 * this installation is. That honesty is the whole reason `coverage` travels in the response:
 * an empty table under the sync driver is a correct answer, not a broken page.
 *
 * The page is the wiring: the list state is `useJobsList`, the table is
 * `features/jobs/JobsTable.vue`, and what happens on a click is here.
 */

const list = useJobsList()

const detailOpen = ref(false)
const selected = ref<JobSummary | null>(null)

const note = computed(() => {
  if (list.coverage.value === 'none') {
    return 'Jobs run inline in the request that enqueued them under QUEUE_DRIVER=sync, and nothing is stored. Switch to the database or redis driver to keep a record.'
  }
  if (list.coverage.value === 'failures') {
    return 'Redis is carrying the queue, so what is listed here are the jobs that failed for good — mirrored back into the database. Retry and cancel belong to Redis and are not offered.'
  }
  return null
})

function openDetails(job: JobSummary): void {
  selected.value = job
  detailOpen.value = true
}

async function retry(job: JobSummary): Promise<void> {
  list.failure.value = null

  const result = await retryJob(job.id)
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  await list.reload()
}

async function cancel(job: JobSummary): Promise<void> {
  if (!window.confirm(`Cancel this ${job.name} job? It will not run.`)) return

  list.failure.value = null

  const result = await cancelJob(job.id)
  if ('failure' in result) {
    list.failure.value = result.failure
    return
  }

  await list.reload()
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Jobs</h2>
      <p class="text-muted-foreground text-sm">
        Work that runs outside a request — sending mail, nightly cleanups, anything a browser should
        not have to wait for.
      </p>
    </div>

    <p v-if="note" class="text-muted-foreground bg-muted rounded-lg px-3 py-2 text-sm">
      {{ note }}
    </p>

    <FailureAlert :failure="list.failure.value" />

    <JobsTable :list="list" @details="openDetails" @retry="retry" @cancel="cancel" />

    <JobDetailSheet v-model:open="detailOpen" :job="selected" />
  </div>
</template>

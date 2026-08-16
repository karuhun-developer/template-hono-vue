<script setup lang="ts">
import {
  Badge,
  Button,
  DataTable,
  DataTableFacetedFilter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  type DataTableColumn,
} from '@app/ui'
import { Ban, Ellipsis, Eye, RefreshCw, X } from '@lucide/vue'
import { computed } from 'vue'

import { jobActions, type JobStatus, type JobSummary } from '@/features/jobs/api'
import type { UseJobsList } from '@/features/jobs/useJobsList'
import { formatDateTime } from '@/lib/format'
import { useSessionStore } from '@/stores/session'

/**
 * The jobs list, as a table.
 *
 * It renders and it emits; it decides nothing. Retry and cancel are hidden on rows the API
 * would refuse anyway — see `jobActions` — to keep people from finding the status rules out
 * by collecting 409s, not to enforce them. `requirePermission('job.manage')` does that.
 */

const props = defineProps<{ list: UseJobsList }>()

const emit = defineEmits<{
  details: [job: JobSummary]
  retry: [job: JobSummary]
  cancel: [job: JobSummary]
}>()

const session = useSessionStore()

// Destructured once: the composable hands back refs, and the object it returns never gets
// replaced. `<script setup>` unwraps them in the template; reading `props.list.page` there
// would not.
const { rows, total, loading, sort, page, perPage, filtered, statuses, names, reset } = props.list

const { coverage, manageable, catalog } = props.list

/** Both halves have to hold: the key, and a driver on which the change means anything. */
const canManage = computed(() => session.can('job.manage') && manageable.value)

const STATUS_LABEL: Record<JobStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const STATUS_VARIANT: Record<JobStatus, 'secondary' | 'success' | 'destructive' | 'info'> = {
  pending: 'secondary',
  running: 'info',
  succeeded: 'success',
  failed: 'destructive',
  // A decision, not a problem — which is the whole reason it is a separate status.
  cancelled: 'secondary',
}

const STATUS_FACETS = (Object.keys(STATUS_LABEL) as JobStatus[]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}))

const nameFacets = computed(() => catalog.value.map((name) => ({ value: name, label: name })))

/**
 * What an empty page means depends entirely on the driver, and saying the wrong thing here
 * is how a correct configuration gets reported as a bug.
 */
const empty = computed(() => {
  if (coverage.value === 'none') {
    return 'Jobs run inline in this configuration, so there is nothing to list.'
  }
  if (coverage.value === 'failures') {
    return 'Nothing recorded. Redis carries the queue, and only jobs that failed for good are kept here.'
  }
  return 'No jobs match that.'
})

/**
 * The columns.
 *
 * `key` is both the slot name and the value sent as `?sort=`, so a sortable key here has to
 * be one the API's enum accepts — `JOB_SORTABLE` is that list, and `useResourceList` checks
 * against it.
 */
const COLUMNS: DataTableColumn[] = [
  { key: 'name', header: 'Job', sortable: true, hideable: false },
  { key: 'status', header: 'Status', sortable: true, class: 'w-32' },
  { key: 'attempts', header: 'Attempts', class: 'w-28', align: 'end' },
  { key: 'runAt', header: 'Due', sortable: true, class: 'w-48' },
  { key: 'createdAt', header: 'Queued', sortable: true, class: 'w-48' },
  { key: 'finishedAt', header: 'Finished', class: 'w-48', hidden: true },
]
</script>

<template>
  <DataTable
    v-model:sort="sort"
    v-model:page="page"
    v-model:per-page="perPage"
    :columns="COLUMNS"
    :rows="rows"
    :loading="loading"
    :total="total"
    row-key="id"
    storage-key="jobs"
    :empty="empty"
  >
    <template #toolbar>
      <DataTableFacetedFilter v-model="statuses" label="Status" :options="STATUS_FACETS" />
      <DataTableFacetedFilter
        v-if="nameFacets.length > 0"
        v-model="names"
        label="Job"
        :options="nameFacets"
      />

      <Button v-if="filtered" variant="ghost" size="sm" @click="reset">
        Reset
        <X />
      </Button>
    </template>

    <template #cell:name="{ row }">
      <div class="min-w-0">
        <code class="font-mono text-xs font-medium">{{ row.name }}</code>
        <!--
          A dedupe key only ever comes from the scheduler, so its presence is the one thing
          that distinguishes "the clock asked for this" from "a request did".
        -->
        <p v-if="row.dedupeKey" class="text-muted-foreground truncate text-xs">Scheduled</p>
      </div>
    </template>

    <template #cell:status="{ row }">
      <Badge :variant="STATUS_VARIANT[row.status]">{{ STATUS_LABEL[row.status] }}</Badge>
    </template>

    <template #cell:attempts="{ row }">
      <span class="text-muted-foreground text-sm tabular-nums">
        {{ row.attempts }} / {{ row.maxAttempts }}
      </span>
    </template>

    <template #cell:runAt="{ row }">
      <span class="text-muted-foreground text-sm">{{ formatDateTime(row.runAt) }}</span>
    </template>

    <template #cell:createdAt="{ row }">
      <span class="text-muted-foreground text-sm">{{ formatDateTime(row.createdAt) }}</span>
    </template>

    <template #cell:finishedAt="{ row }">
      <span class="text-muted-foreground text-sm">{{ formatDateTime(row.finishedAt) }}</span>
    </template>

    <template #actions="{ row }">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${row.name}`">
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" class="w-44">
          <DropdownMenuItem @select="emit('details', row)">
            <Eye />
            Details
          </DropdownMenuItem>

          <template v-if="canManage && (jobActions(row).retry || jobActions(row).cancel)">
            <DropdownMenuSeparator />

            <DropdownMenuItem v-if="jobActions(row).retry" @select="emit('retry', row)">
              <RefreshCw />
              Run again
            </DropdownMenuItem>

            <DropdownMenuItem
              v-if="jobActions(row).cancel"
              variant="destructive"
              @select="emit('cancel', row)"
            >
              <Ban />
              Cancel
            </DropdownMenuItem>
          </template>
        </DropdownMenuContent>
      </DropdownMenu>
    </template>
  </DataTable>
</template>

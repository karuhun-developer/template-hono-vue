<script setup lang="ts">
import {
  Badge,
  Button,
  DataTable,
  DataTableFacetedFilter,
  Input,
  type DataTableColumn,
} from '@app/ui'
import { Eye, Search, X } from '@lucide/vue'
import { computed } from 'vue'

import type { MailMessage, MailStatus } from '@/features/mail/api'
import type { UseMailList } from '@/features/mail/useMailList'
import { formatDateTime } from '@/lib/format'

/**
 * The mail log, as a table.
 *
 * It renders and it emits; it decides nothing — and here there is nothing to decide, because
 * the API offers no write of any kind. The one action is Preview, which is why it is a button
 * rather than a menu with a single item in it.
 *
 * Searching, filtering, sorting and paging all happen in the API. The search matches the
 * recipient and the subject only: the body is the largest column in the table and the
 * interesting parts of the stored copy read `[redacted]` anyway.
 */

const props = defineProps<{ list: UseMailList }>()

const emit = defineEmits<{ preview: [message: MailMessage] }>()

// Destructured once: the composable hands back refs, and the object it returns never gets
// replaced. `<script setup>` unwraps them in the template; reading `props.list.page` there
// would not.
const { rows, total, loading, search, sort, page, perPage, filtered, statuses, templates, reset } =
  props.list

const { catalog } = props.list

const STATUS_LABEL: Record<MailStatus, string> = {
  queued: 'Queued',
  sent: 'Sent',
  failed: 'Failed',
}

const STATUS_VARIANT: Record<MailStatus, 'secondary' | 'success' | 'destructive'> = {
  queued: 'secondary',
  sent: 'success',
  failed: 'destructive',
}

const STATUS_FACETS = (Object.keys(STATUS_LABEL) as MailStatus[]).map((value) => ({
  value,
  label: STATUS_LABEL[value],
}))

const templateFacets = computed(() =>
  catalog.value.map((template) => ({ value: template, label: template })),
)

/**
 * The columns.
 *
 * `key` is both the slot name and the value sent as `?sort=`, so a sortable key here has to
 * be one the API's enum accepts — `MAIL_SORTABLE` is that list, and `useResourceList` checks
 * against it.
 */
const COLUMNS: DataTableColumn[] = [
  { key: 'toEmail', header: 'To', hideable: false },
  { key: 'subject', header: 'Subject' },
  { key: 'template', header: 'Template', class: 'w-44' },
  { key: 'status', header: 'Status', sortable: true, class: 'w-32' },
  { key: 'createdAt', header: 'Queued', sortable: true, class: 'w-48' },
  { key: 'sentAt', header: 'Sent', sortable: true, class: 'w-48', hidden: true },
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
    storage-key="mail-log"
    empty="No messages match that."
  >
    <template #toolbar>
      <div class="relative w-full sm:w-64">
        <Search class="text-muted-foreground pointer-events-none absolute top-2.5 left-3 size-4" />
        <Input v-model="search" placeholder="Search by recipient or subject" class="pl-9" />
      </div>

      <DataTableFacetedFilter v-model="statuses" label="Status" :options="STATUS_FACETS" />
      <DataTableFacetedFilter
        v-if="templateFacets.length > 0"
        v-model="templates"
        label="Template"
        :options="templateFacets"
      />

      <Button v-if="filtered" variant="ghost" size="sm" @click="reset">
        Reset
        <X />
      </Button>
    </template>

    <template #cell:toEmail="{ row }">
      <div class="min-w-0">
        <p class="truncate font-medium">{{ row.toEmail }}</p>
        <p v-if="row.toName" class="text-muted-foreground truncate text-xs">{{ row.toName }}</p>
      </div>
    </template>

    <template #cell:subject="{ row }">
      <p class="truncate">{{ row.subject }}</p>
    </template>

    <template #cell:template="{ row }">
      <code class="font-mono text-xs">{{ row.template }}</code>
    </template>

    <template #cell:status="{ row }">
      <div class="flex items-center gap-2">
        <Badge :variant="STATUS_VARIANT[row.status]">{{ STATUS_LABEL[row.status] }}</Badge>
        <!--
          Which driver actually handled it, and only when it is not the one that sends: a
          message written under `MAIL_DRIVER=log` was never delivered anywhere, and that is
          worth seeing without opening the row.
        -->
        <Badge v-if="row.driver === 'log'" variant="outline">log</Badge>
      </div>
    </template>

    <template #cell:createdAt="{ row }">
      <span class="text-muted-foreground text-sm">{{ formatDateTime(row.createdAt) }}</span>
    </template>

    <template #cell:sentAt="{ row }">
      <span class="text-muted-foreground text-sm">{{ formatDateTime(row.sentAt) }}</span>
    </template>

    <template #actions="{ row }">
      <Button
        variant="ghost"
        size="icon-sm"
        :aria-label="`Preview the message to ${row.toEmail}`"
        @click="emit('preview', row)"
      >
        <Eye />
      </Button>
    </template>
  </DataTable>
</template>

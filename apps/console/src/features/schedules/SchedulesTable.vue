<script setup lang="ts">
import { Badge, Button, DataTable, type DataTableColumn } from '@app/ui'
import { History, Play } from '@lucide/vue'
import { computed } from 'vue'

import { scheduleOutcome, type ScheduleSummary } from '@/features/schedules/api'
import type { UseSchedules } from '@/features/schedules/useSchedules'
import { formatDateTime } from '@/lib/format'
import { useSessionStore } from '@/stores/session'

/**
 * The schedules, as a table.
 *
 * It renders and it emits; it decides nothing. `mode="none"` on the pager because the
 * registry is a file — six rows today — and a pager under six rows is furniture.
 *
 * Nothing here is sortable either: sorting sends `?sort=`, and there is no list query to
 * send it to. A column header that reordered rows in the browser would be a different
 * behaviour from every other table in this console.
 */

const props = defineProps<{ list: UseSchedules; busyKey: string | null }>()

const emit = defineEmits<{
  history: [schedule: ScheduleSummary]
  run: [schedule: ScheduleSummary]
}>()

const session = useSessionStore()

// Destructured once: the composable hands back refs, and the object it returns never gets
// replaced. `<script setup>` unwraps them in the template; reading `props.list.rows` there
// would not.
const { rows, loading } = props.list

const canRun = computed(() => session.can('schedule.run'))

const COLUMNS: DataTableColumn[] = [
  { key: 'key', header: 'Schedule', hideable: false },
  { key: 'cron', header: 'When', class: 'w-40' },
  { key: 'lastRun', header: 'Last run', class: 'w-56' },
  { key: 'nextRunAt', header: 'Next run', class: 'w-48' },
]
</script>

<template>
  <DataTable
    :columns="COLUMNS"
    :rows="rows"
    :loading="loading"
    row-key="key"
    mode="none"
    :view-options="false"
    empty="No schedules are registered."
  >
    <template #cell:key="{ row }">
      <div class="min-w-0">
        <code class="font-mono text-xs font-medium">{{ row.key }}</code>
        <p class="text-muted-foreground truncate text-xs">{{ row.description }}</p>
      </div>
    </template>

    <template #cell:cron="{ row }">
      <div class="min-w-0">
        <code class="font-mono text-xs">{{ row.cron }}</code>
        <p class="text-muted-foreground truncate text-xs">{{ row.job }}</p>
      </div>
    </template>

    <!--
      The badge says what the *job* came to, which is not the same thing as what the tick
      did — see `scheduleOutcome`. "Enqueued" with no outcome is the honest answer under a
      driver that keeps no row to join to, and it is not an error.
    -->
    <template #cell:lastRun="{ row }">
      <div v-if="row.lastRun" class="flex items-center gap-2">
        <Badge :variant="scheduleOutcome(row.lastRun)?.variant ?? 'secondary'">
          {{ scheduleOutcome(row.lastRun)?.label }}
        </Badge>
        <span class="text-muted-foreground truncate text-sm">
          {{ formatDateTime(row.lastRun.firedFor) }}
        </span>
      </div>
      <span v-else class="text-muted-foreground text-sm">Never</span>
    </template>

    <template #cell:nextRunAt="{ row }">
      <span class="text-muted-foreground text-sm">{{ formatDateTime(row.nextRunAt) }}</span>
    </template>

    <template #actions="{ row }">
      <div class="flex items-center justify-end gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          :aria-label="`History for ${row.key}`"
          @click="emit('history', row)"
        >
          <History />
        </Button>

        <!--
          Deliberately not hidden when the scheduler is disabled: that setting decides
          whether the clock is watched, and this button does not watch the clock. A
          deployment that ticks nothing on purpose can still run a cleanup by hand.
        -->
        <Button
          v-if="canRun"
          variant="ghost"
          size="icon-sm"
          :disabled="busyKey !== null"
          :aria-label="`Run ${row.key} now`"
          @click="emit('run', row)"
        >
          <Play />
        </Button>
      </div>
    </template>
  </DataTable>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import { runSchedule, type ScheduleSummary } from '@/features/schedules/api'
import ScheduleRunsSheet from '@/features/schedules/ScheduleRunsSheet.vue'
import SchedulesTable from '@/features/schedules/SchedulesTable.vue'
import { useSchedules } from '@/features/schedules/useSchedules'

/**
 * What runs on a clock.
 *
 * Read-only apart from one button, because the registry is code: there is no create, no edit
 * and no pause, and the closest thing to switching a schedule off is a deploy. That is the
 * whole argument for keeping the expressions in a file rather than in a table, and an
 * endpoint that quietly reintroduced the table would undo it.
 *
 * "Run now" enqueues immediately and records a `manual` run, which the unique tick index
 * excludes — so pressing it cannot suppress tonight's real fire.
 */

const list = useSchedules()

const historyOpen = ref(false)
const selected = ref<ScheduleSummary | null>(null)

/** Which row is mid-request, so the buttons can go quiet without a spinner per row. */
const busyKey = ref<string | null>(null)

const note = computed(() =>
  list.enabled.value
    ? null
    : 'SCHEDULER_ENABLED is off, so nothing here fires on its own. The next-run times are what would happen if a worker were watching the clock; "Run now" still works, and a worker will drain what it enqueues.',
)

function openHistory(schedule: ScheduleSummary): void {
  selected.value = schedule
  historyOpen.value = true
}

async function run(schedule: ScheduleSummary): Promise<void> {
  if (!window.confirm(`Run ${schedule.key} now? It will do real work against live data.`)) return

  list.failure.value = null
  busyKey.value = schedule.key

  try {
    const result = await runSchedule(schedule.key)
    if ('failure' in result) {
      list.failure.value = result.failure
      return
    }

    await list.reload()
  } finally {
    busyKey.value = null
  }
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Scheduled jobs</h2>
      <p class="text-muted-foreground text-sm">
        The work that runs on a clock — nightly cleanups and the sweeps that keep the queue and the
        outbox honest. Times are read in {{ list.timezone.value }}.
      </p>
    </div>

    <p v-if="note" class="text-muted-foreground bg-muted rounded-lg px-3 py-2 text-sm">
      {{ note }}
    </p>

    <FailureAlert :failure="list.failure.value" />

    <SchedulesTable :list="list" :busy-key="busyKey" @history="openHistory" @run="run" />

    <ScheduleRunsSheet v-model:open="historyOpen" :schedule="selected" />
  </div>
</template>

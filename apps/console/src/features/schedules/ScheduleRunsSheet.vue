<script setup lang="ts">
import { Badge, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@app/ui'
import { ref, watch } from 'vue'

import {
  fetchScheduleRuns,
  scheduleOutcome,
  type ScheduleRun,
  type ScheduleSummary,
} from '@/features/schedules/api'
import FailureAlert from '@/components/FailureAlert.vue'
import { formatDateTime } from '@/lib/format'
import type { ApiFailure } from '@/lib/api-error'

/**
 * What a schedule has actually been doing.
 *
 * A sheet rather than a route: this is a detour from the list — "has the nightly cleanup been
 * running" — and closing it should put the list back exactly as it was.
 *
 * The history is loaded on open rather than with the list, because it is one request per
 * schedule and nobody opens six of them. `manual` is called out on every row that has it: a
 * run somebody started by hand does not tell you the clock is working.
 */

const props = defineProps<{
  open: boolean
  schedule: ScheduleSummary | null
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

const runs = ref<ScheduleRun[]>([])
const loading = ref(false)
const failure = ref<ApiFailure | null>(null)

watch(
  () => [props.open, props.schedule?.key] as const,
  ([open, key]) => {
    runs.value = []
    failure.value = null
    if (!open || key === undefined) return

    loading.value = true
    void fetchScheduleRuns(key)
      .then((result) => {
        // Guard against the answer arriving after somebody moved on to another schedule.
        if (props.schedule?.key !== key) return
        if ('failure' in result) failure.value = result.failure
        else runs.value = result
      })
      .finally(() => (loading.value = false))
  },
)
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-md">
      <template v-if="schedule">
        <SheetHeader>
          <SheetTitle class="font-mono text-sm break-all">{{ schedule.key }}</SheetTitle>
          <SheetDescription>{{ schedule.description }}</SheetDescription>
        </SheetHeader>

        <div class="space-y-4 px-4 pb-6 text-sm">
          <FailureAlert :failure="failure" />

          <p v-if="loading" class="text-muted-foreground">Loading…</p>
          <p v-else-if="runs.length === 0 && !failure" class="text-muted-foreground">
            This schedule has not fired yet.
          </p>

          <div v-for="run in runs" :key="run.id" class="space-y-1 border-b pb-3 last:border-b-0">
            <div class="flex flex-wrap items-center gap-2">
              <Badge :variant="scheduleOutcome(run)?.variant ?? 'secondary'">
                {{ scheduleOutcome(run)?.label }}
              </Badge>
              <!--
                The distinction the unique tick index is built around: a manual run is
                excluded from it, so it can neither suppress the real tick nor stand in as
                evidence that the clock fired.
              -->
              <Badge v-if="run.manual" variant="outline">Run by hand</Badge>
              <span class="text-muted-foreground text-xs">
                {{ formatDateTime(run.firedFor) }}
              </span>
            </div>

            <p v-if="run.job" class="text-muted-foreground text-xs">
              <code class="font-mono">{{ run.job.name }}</code>
              · attempt {{ run.job.attempts }} of {{ run.job.maxAttempts }}
              <template v-if="run.job.finishedAt">
                · finished {{ formatDateTime(run.job.finishedAt) }}
              </template>
            </p>

            <pre
              v-if="run.job?.lastError"
              class="border-destructive/30 bg-destructive/10 text-destructive overflow-x-auto rounded-lg border p-2 font-mono text-xs whitespace-pre-wrap"
              >{{ run.job.lastError }}</pre>
          </div>
        </div>
      </template>
    </SheetContent>
  </Sheet>
</template>

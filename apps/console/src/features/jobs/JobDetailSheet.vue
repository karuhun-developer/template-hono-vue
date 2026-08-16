<script setup lang="ts">
import { Badge, Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@app/ui'
import { computed } from 'vue'

import type { JobSummary } from '@/features/jobs/api'
import { formatDateTime } from '@/lib/format'

/**
 * One job, in full.
 *
 * A sheet rather than a route: this is a detour from the list — "why did that one fail" —
 * and closing it should put the list back exactly as it was, scroll position included.
 *
 * Everything shown here is already in the row the list loaded, so opening it costs no
 * request. There is no `GET /jobs/:id` for the same reason: it would answer with the object
 * the console is holding.
 */

const props = defineProps<{
  open: boolean
  job: JobSummary | null
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

/**
 * Two spaces, and `JSON.stringify` rather than anything cleverer: the payload is JSON in the
 * database — that is the rule `registry.ts` states — so the honest rendering is the JSON.
 */
const payload = computed(() => JSON.stringify(props.job?.payload ?? {}, null, 2))

const facts = computed(() => {
  const job = props.job
  if (!job) return []

  return [
    { label: 'Attempts', value: `${job.attempts} of ${job.maxAttempts}` },
    { label: 'Queued', value: formatDateTime(job.createdAt) },
    { label: 'Due', value: formatDateTime(job.runAt) },
    { label: 'Finished', value: formatDateTime(job.finishedAt) },
    // Who is holding the row, and since when. Not a lock — the evidence a worker that died
    // mid-job leaves behind, which is what `queue.reap` looks for.
    { label: 'Claimed by', value: job.lockedBy ?? '—' },
    { label: 'Claimed at', value: formatDateTime(job.lockedAt) },
  ]
})
</script>

<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-md">
      <template v-if="job">
        <SheetHeader>
          <SheetTitle class="font-mono text-sm break-all">{{ job.name }}</SheetTitle>
          <SheetDescription>
            <span class="font-mono text-xs break-all">{{ job.id }}</span>
          </SheetDescription>
        </SheetHeader>

        <div class="space-y-6 px-4 pb-6 text-sm">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{{ job.status }}</Badge>
            <!--
              A dedupe key is the scheduler's fingerprint: `<schedule>:<instant>`, and the
              reason the same tick on two replicas produces one job rather than two.
            -->
            <Badge v-if="job.dedupeKey" variant="secondary" class="font-mono">
              {{ job.dedupeKey }}
            </Badge>
          </div>

          <dl class="grid grid-cols-2 gap-x-4 gap-y-3">
            <div v-for="fact in facts" :key="fact.label" class="min-w-0">
              <dt class="text-muted-foreground text-xs">{{ fact.label }}</dt>
              <dd class="truncate">{{ fact.value }}</dd>
            </div>
          </dl>

          <!--
            The last error only, not a history of them: a row carries one `last_error`
            column, and inventing a list from it would be inventing information.
          -->
          <div v-if="job.lastError" class="space-y-1">
            <p class="text-muted-foreground text-xs">Last error</p>
            <pre
              class="border-destructive/30 bg-destructive/10 text-destructive overflow-x-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap"
              >{{ job.lastError }}</pre>
          </div>

          <div class="space-y-1">
            <p class="text-muted-foreground text-xs">Payload</p>
            <pre
              class="bg-muted overflow-x-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap"
              >{{ payload }}</pre>
          </div>
        </div>
      </template>
    </SheetContent>
  </Sheet>
</template>

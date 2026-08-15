<script setup lang="ts">
import {
  Badge,
  Button,
  DataTable,
  DataTableFacetedFilter,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  type DataTableColumn,
} from '@app/ui'
import { Diff, X } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import { api } from '@/lib/api'
import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'
import { formatDateTime } from '@/lib/format'
import type { AuditLogEntry } from '@/lib/models'

/**
 * Who changed what.
 *
 * Read-only, and there is no endpoint that would make it anything else: entries are written
 * inside the transaction of the action they describe, and a trail with a delete button is a
 * trail that gets tidied up by exactly the person who should not be tidying it.
 *
 * Paging is by cursor, not by page number — which is why this table runs in `cursor` mode
 * and shows no page count. The trail grows at the top while somebody reads it, and `?page=2`
 * under those conditions quietly repeats rows it has already shown. The cursor is the id of
 * the last row on screen, so "older than this" stays true no matter what arrives meanwhile.
 *
 * Going *back* is the one thing a cursor cannot do on its own, so the cursors already used
 * are kept in `trail`. That is a list of at most one string per page turned, and it is the
 * whole reason this page can offer Previous without inventing a page number.
 */

/** Every action this template writes. Extend it as you add modules that record one. */
const ACTIONS = [
  'user.invite',
  'user.invite_resend',
  'user.update',
  'user.enable',
  'user.disable',
  'role.create',
  'role.update',
  'role.delete',
] as const

const SUBJECTS = [
  { value: 'users', label: 'Users' },
  { value: 'roles', label: 'Roles' },
]

const entries = ref<AuditLogEntry[]>([])
const nextCursor = ref<string | null>(null)
const loading = ref(true)
const failure = ref<ApiFailure | null>(null)

const actions = ref<string[]>([])
const subjectTypes = ref<string[]>([])

/** The cursor each page started from. `null` is the first page, so the trail is never empty. */
const trail = ref<(string | null)[]>([null])
const index = ref(0)
const perPage = ref(20)

const detail = ref<AuditLogEntry | null>(null)

const ACTION_FACETS = ACTIONS.map((value) => ({ value, label: value }))

const COLUMNS: DataTableColumn[] = [
  { key: 'createdAt', header: 'When', class: 'w-48', hideable: false },
  { key: 'actorLabel', header: 'Actor', class: 'w-56' },
  { key: 'action', header: 'Action', class: 'w-52' },
  { key: 'subjectLabel', header: 'Subject' },
  { key: 'reason', header: 'Reason', hidden: true },
]

const filtered = computed(() => actions.value.length > 0 || subjectTypes.value.length > 0)

onMounted(async () => {
  await load()
})

/** A different question is a different list, so the trail starts again from the top. */
watch([actions, subjectTypes, perPage], () => {
  trail.value = [null]
  index.value = 0
})

watch([actions, subjectTypes, perPage, index], () => void load())

async function load(): Promise<void> {
  loading.value = true
  failure.value = null

  const from = trail.value[index.value] ?? null

  try {
    const response = await api['audit-logs'].$get({
      query: {
        limit: String(perPage.value),
        // Sent once per ticked box; the API reads a repeated parameter as a set.
        ...(actions.value.length === 0 ? {} : { action: actions.value }),
        ...(subjectTypes.value.length === 0 ? {} : { subjectType: subjectTypes.value }),
        ...(from === null ? {} : { cursor: from }),
      },
    })

    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    const body = await response.json()
    entries.value = body.items
    nextCursor.value = body.nextCursor
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    loading.value = false
  }
}

function older(): void {
  if (nextCursor.value === null) return

  // Recorded rather than replaced: it is what Previous walks back along.
  trail.value = [...trail.value.slice(0, index.value + 1), nextCursor.value]
  index.value += 1
}

function newer(): void {
  if (index.value > 0) index.value -= 1
}

function reset(): void {
  actions.value = []
  subjectTypes.value = []
}

/** The dialog is opened by picking a row, so closing it is the only thing it reports back. */
function onDetail(open: boolean): void {
  if (!open) detail.value = null
}

function hasChanges(entry: AuditLogEntry): boolean {
  return entry.before !== null || entry.after !== null
}

/**
 * Rendered as raw JSON on purpose. `before` and `after` hold whichever columns changed, so
 * their shape differs per action — and a table built for `users` would silently drop half
 * of a `roles` entry. Secrets never reach here: `redact()` replaces them on the way in.
 */
function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Audit log</h2>
      <p class="text-muted-foreground text-sm">
        Access granted, accounts disabled, roles edited — the changes somebody may have to answer
        for later.
      </p>
    </div>

    <FailureAlert :failure="failure" />

    <DataTable
      v-model:per-page="perPage"
      :columns="COLUMNS"
      :rows="entries"
      :loading="loading"
      mode="cursor"
      :has-prev="index > 0"
      :has-next="nextCursor !== null"
      row-key="id"
      storage-key="audit-log"
      empty="Nothing recorded yet."
      @prev="newer"
      @next="older"
    >
      <template #toolbar>
        <DataTableFacetedFilter v-model="actions" label="Action" :options="ACTION_FACETS" />
        <DataTableFacetedFilter v-model="subjectTypes" label="Subject" :options="SUBJECTS" />

        <Button v-if="filtered" variant="ghost" size="sm" @click="reset">
          Reset
          <X />
        </Button>
      </template>

      <template #cell:createdAt="{ row }">
        <span class="text-muted-foreground text-sm">{{ formatDateTime(row.createdAt) }}</span>
      </template>

      <template #cell:actorLabel="{ row }">
        <Badge :variant="row.actorType === 'system' ? 'secondary' : 'outline'">
          {{ row.actorType === 'system' ? 'system' : (row.actorLabel ?? 'unknown') }}
        </Badge>
      </template>

      <template #cell:action="{ row }">
        <code class="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{{ row.action }}</code>
      </template>

      <template #cell:subjectLabel="{ row }">
        <span class="truncate">{{ row.subjectLabel ?? row.subjectType }}</span>
      </template>

      <template #actions="{ row }">
        <!--
          Only where there is something to show. An entry such as `user.invite` records no
          before/after, and a button that opens an empty dialog is worse than no button.
        -->
        <Button
          v-if="hasChanges(row)"
          variant="ghost"
          size="icon-sm"
          :aria-label="`Show what changed in ${row.action}`"
          @click="detail = row"
        >
          <Diff />
        </Button>
      </template>
    </DataTable>

    <Dialog :open="detail !== null" @update:open="onDetail">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ detail?.action }}</DialogTitle>
          <DialogDescription>
            {{ detail?.subjectLabel ?? detail?.subjectType }} ·
            {{ formatDateTime(detail?.createdAt) }}
          </DialogDescription>
        </DialogHeader>

        <p v-if="detail?.reason" class="text-sm">{{ detail.reason }}</p>

        <div class="grid gap-3 sm:grid-cols-2">
          <div v-if="detail?.before">
            <p class="text-muted-foreground mb-1 text-xs">Before</p>
            <pre class="bg-muted max-h-72 overflow-auto rounded-lg p-2 text-xs">{{
              pretty(detail.before)
            }}</pre>
          </div>
          <div v-if="detail?.after">
            <p class="text-muted-foreground mb-1 text-xs">After</p>
            <pre class="bg-muted max-h-72 overflow-auto rounded-lg p-2 text-xs">{{
              pretty(detail.after)
            }}</pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>

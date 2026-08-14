<script setup lang="ts">
import { Badge, Button, Card, CardContent, Skeleton } from '@app/ui'
import { LoaderCircle } from '@lucide/vue'
import { onMounted, ref, watch } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import NativeSelect from '@/components/NativeSelect.vue'
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
 * Paging is by cursor, not by page number. The trail grows at the top while somebody reads
 * it, and `?page=2` under those conditions quietly repeats rows it has already shown. The
 * cursor is the id of the last row on screen, so "older than this" stays true no matter
 * what arrives in the meantime.
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

const PAGE_SIZE = 25

const entries = ref<AuditLogEntry[]>([])
const cursor = ref<string | null>(null)
const loading = ref(true)
const loadingMore = ref(false)
const failure = ref<ApiFailure | null>(null)

const action = ref('')
const subjectType = ref('')
const expanded = ref<string | null>(null)

onMounted(async () => {
  await load()
})

watch([action, subjectType], () => void load())

async function load(): Promise<void> {
  loading.value = true
  failure.value = null

  const page = await fetchPage(null)
  if (page) {
    entries.value = page.items
    cursor.value = page.nextCursor
  }

  loading.value = false
}

async function loadMore(): Promise<void> {
  if (loadingMore.value || cursor.value === null) return

  loadingMore.value = true

  const page = await fetchPage(cursor.value)
  if (page) {
    entries.value = [...entries.value, ...page.items]
    cursor.value = page.nextCursor
  }

  loadingMore.value = false
}

async function fetchPage(
  from: string | null,
): Promise<{ items: AuditLogEntry[]; nextCursor: string | null } | null> {
  try {
    const response = await api['audit-logs'].$get({
      query: {
        limit: String(PAGE_SIZE),
        ...(action.value === '' ? {} : { action: action.value }),
        ...(subjectType.value === '' ? {} : { subjectType: subjectType.value }),
        ...(from === null ? {} : { cursor: from }),
      },
    })

    if (!response.ok) {
      failure.value = await readApiError(response)
      return null
    }

    return await response.json()
  } catch (error) {
    failure.value = networkFailure(error)
    return null
  }
}

function toggle(id: string): void {
  expanded.value = expanded.value === id ? null : id
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
  <div class="mx-auto w-full max-w-3xl space-y-4">
    <div>
      <h1 class="text-xl font-semibold">Audit log</h1>
      <p class="text-muted-foreground text-sm">
        Access granted, accounts disabled, roles edited — the changes somebody may have to answer
        for later.
      </p>
    </div>

    <div class="flex gap-2">
      <NativeSelect v-model="action" aria-label="Filter by action" class="min-w-0 flex-1">
        <option value="">All actions</option>
        <option v-for="key in ACTIONS" :key="key" :value="key">{{ key }}</option>
      </NativeSelect>
      <NativeSelect v-model="subjectType" aria-label="Filter by subject" class="w-36 shrink-0">
        <option value="">Everything</option>
        <option value="users">Users</option>
        <option value="roles">Roles</option>
      </NativeSelect>
    </div>

    <FailureAlert :failure="failure" />

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 4" :key="i" class="h-20 w-full rounded-2xl" />
    </div>

    <Card v-else-if="entries.length === 0">
      <CardContent class="text-muted-foreground py-10 text-center text-sm">
        Nothing recorded yet.
      </CardContent>
    </Card>

    <template v-else>
      <Card v-for="entry in entries" :key="entry.id">
        <CardContent class="space-y-2">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-mono text-sm">{{ entry.action }}</p>
              <p class="text-muted-foreground truncate text-sm">
                {{ entry.subjectLabel ?? entry.subjectType }}
              </p>
            </div>
            <Badge :variant="entry.actorType === 'system' ? 'secondary' : 'outline'">
              {{ entry.actorType === 'system' ? 'system' : (entry.actorLabel ?? 'unknown') }}
            </Badge>
          </div>

          <p class="text-muted-foreground text-xs">{{ formatDateTime(entry.createdAt) }}</p>

          <p v-if="entry.reason" class="text-sm">{{ entry.reason }}</p>

          <template v-if="hasChanges(entry)">
            <Button variant="ghost" size="sm" @click="toggle(entry.id)">
              {{ expanded === entry.id ? 'Hide the change' : 'Show the change' }}
            </Button>

            <div v-if="expanded === entry.id" class="grid gap-2 sm:grid-cols-2">
              <div v-if="entry.before">
                <p class="text-muted-foreground mb-1 text-xs">Before</p>
                <pre class="bg-muted overflow-x-auto rounded-lg p-2 text-xs">{{
                  pretty(entry.before)
                }}</pre>
              </div>
              <div v-if="entry.after">
                <p class="text-muted-foreground mb-1 text-xs">After</p>
                <pre class="bg-muted overflow-x-auto rounded-lg p-2 text-xs">{{
                  pretty(entry.after)
                }}</pre>
              </div>
            </div>
          </template>
        </CardContent>
      </Card>

      <Button
        v-if="cursor"
        variant="outline"
        class="w-full"
        :disabled="loadingMore"
        @click="loadMore"
      >
        <LoaderCircle v-if="loadingMore" class="animate-spin" />
        Load older entries
      </Button>
    </template>
  </div>
</template>

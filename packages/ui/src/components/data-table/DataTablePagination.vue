<script setup lang="ts">
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/vue'
import { computed } from 'vue'

import { Button } from '../button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../select'
import type { DataTablePaginationMode } from './types'

/**
 * The footer under a table.
 *
 * `mode` decides what it is honest about. `numbered` needs a `total` and can therefore
 * offer page numbers; `cursor` has no total by design and offers prev/next and nothing
 * else. The alternative — one pager that counts rows itself — would show a page count
 * that changes every time you look at it on any list still being written to.
 */
const props = withDefaults(
  defineProps<{
    mode?: DataTablePaginationMode
    page?: number
    perPage: number
    /** `numbered` only. */
    total?: number
    /** `cursor` only: the API is the one that knows whether another page exists. */
    hasPrev?: boolean
    hasNext?: boolean
    /** Rendered on the left when the table has selection turned on. */
    selectedCount?: number
    rowCount?: number
    perPageOptions?: readonly number[]
  }>(),
  { mode: 'numbered', page: 1, total: 0, perPageOptions: () => [10, 20, 30, 50, 100] },
)

const emit = defineEmits<{
  'update:page': [value: number]
  'update:perPage': [value: number]
  prev: []
  next: []
}>()

const pageCount = computed(() => Math.max(1, Math.ceil(props.total / props.perPage)))

/** `1` and the last page always show; the rest collapses around whatever page you are on. */
const pages = computed<(number | 'gap')[]>(() => {
  const count = pageCount.value
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1)

  const out: (number | 'gap')[] = [1]
  const start = Math.max(2, props.page - 1)
  const end = Math.min(count - 1, props.page + 1)

  if (start > 2) out.push('gap')
  for (let index = start; index <= end; index += 1) out.push(index)
  if (end < count - 1) out.push('gap')
  out.push(count)

  return out
})

/** `Select` speaks strings; the rest of the app counts in numbers. */
const perPageValue = computed({
  get: () => String(props.perPage),
  set: (value: string) => emit('update:perPage', Number(value)),
})

function go(page: number): void {
  const target = Math.min(Math.max(1, page), pageCount.value)
  if (target !== props.page) emit('update:page', target)
}
</script>

<template>
  <div
    v-if="props.mode !== 'none'"
    class="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between"
  >
    <p class="text-muted-foreground text-sm">
      <template v-if="props.selectedCount">
        {{ props.selectedCount }} of {{ props.rowCount ?? 0 }} row(s) selected.
      </template>
      <template v-else-if="props.mode === 'numbered'">
        {{ props.total }} {{ props.total === 1 ? 'result' : 'results' }}
      </template>
      <template v-else> Showing {{ props.rowCount ?? 0 }} </template>
    </p>

    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2">
        <span class="hidden text-sm font-medium sm:inline">Rows per page</span>
        <Select v-model="perPageValue">
          <SelectTrigger size="sm" class="w-[4.5rem]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="option in props.perPageOptions"
              :key="option"
              :value="String(option)"
            >
              {{ option }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <template v-if="props.mode === 'numbered'">
        <span class="text-sm font-medium whitespace-nowrap sm:hidden">
          Page {{ props.page }} of {{ pageCount }}
        </span>

        <div class="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            class="hidden sm:inline-flex"
            :disabled="props.page <= 1"
            aria-label="First page"
            @click="go(1)"
          >
            <ChevronsLeft />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            :disabled="props.page <= 1"
            aria-label="Previous page"
            @click="go(props.page - 1)"
          >
            <ChevronLeft />
          </Button>

          <template v-for="(entry, index) in pages" :key="`${entry}-${index}`">
            <span v-if="entry === 'gap'" class="text-muted-foreground hidden px-1 sm:inline"
              >…</span
            >
            <Button
              v-else
              :variant="entry === props.page ? 'default' : 'outline'"
              size="icon-sm"
              class="hidden sm:inline-flex"
              :aria-current="entry === props.page ? 'page' : undefined"
              @click="go(entry)"
            >
              {{ entry }}
            </Button>
          </template>

          <Button
            variant="outline"
            size="icon-sm"
            :disabled="props.page >= pageCount"
            aria-label="Next page"
            @click="go(props.page + 1)"
          >
            <ChevronRight />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            class="hidden sm:inline-flex"
            :disabled="props.page >= pageCount"
            aria-label="Last page"
            @click="go(pageCount)"
          >
            <ChevronsRight />
          </Button>
        </div>
      </template>

      <div v-else class="flex items-center gap-1">
        <Button variant="outline" size="sm" :disabled="!props.hasPrev" @click="emit('prev')">
          <ChevronLeft />
          Previous
        </Button>
        <Button variant="outline" size="sm" :disabled="!props.hasNext" @click="emit('next')">
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  </div>
</template>

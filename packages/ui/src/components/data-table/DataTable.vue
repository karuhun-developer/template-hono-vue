<script setup lang="ts" generic="Row extends object">
import { Inbox } from '@lucide/vue'
import { computed, ref, useSlots, watch } from 'vue'

import { cn } from '../../lib/utils'
import { Button } from '../button'
import { Checkbox } from '../checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../table'
import DataTableColumnHeader from './DataTableColumnHeader.vue'
import DataTablePagination from './DataTablePagination.vue'
import DataTableSkeleton from './DataTableSkeleton.vue'
import DataTableViewOptions from './DataTableViewOptions.vue'
import type { DataTableColumn, DataTablePaginationMode, DataTableSort } from './types'

/**
 * A list of rows with a toolbar, a header that sorts, a body that pages and a skeleton
 * that stands in for all of it.
 *
 * It renders; it does not compute. Sorting, filtering and paging are all server-side, so
 * this component holds none of that state — it reports the sort you asked for and the
 * page you clicked, and the page component turns them into query parameters. The one
 * thing it does own is column visibility, because that is a preference about this screen
 * on this machine and no API needs to hear about it.
 *
 * ```vue
 * <DataTable :columns="COLUMNS" :rows="users" :loading="loading" row-key="id"
 *   v-model:sort="sort" v-model:page="page" :total="total" empty="No users match that.">
 *   <template #toolbar>…</template>
 *   <template #cell:status="{ row }"><Badge>{{ row.status }}</Badge></template>
 *   <template #actions="{ row }">…</template>
 * </DataTable>
 * ```
 */
const props = withDefaults(
  defineProps<{
    columns: readonly DataTableColumn[]
    rows: readonly Row[]
    /** The field that identifies a row: used for `:key`, for selection and for nothing else. */
    rowKey: Extract<keyof Row, string>
    loading?: boolean
    /** Shown in place of the rows when there are none. Say why the list is empty. */
    empty?: string
    selectable?: boolean
    /** `false` hides the View menu on tables where every column earns its place. */
    viewOptions?: boolean
    /** Where hidden columns are remembered. Leave unset and they reset on reload. */
    storageKey?: string
    mode?: DataTablePaginationMode
    total?: number
    hasPrev?: boolean
    hasNext?: boolean
  }>(),
  { empty: 'Nothing here yet.', viewOptions: true, mode: 'numbered', total: 0 },
)

const emit = defineEmits<{ prev: []; next: [] }>()

const sort = defineModel<DataTableSort>('sort', { default: null })
const selected = defineModel<string[]>('selected', { default: () => [] })
const page = defineModel<number>('page', { default: 1 })
const perPage = defineModel<number>('perPage', { default: 10 })

const slots = useSlots()
const hasActions = computed(() => Boolean(slots.actions))

/* ---------------------------------------------------------------- column visibility */

const hidden = ref<string[]>(
  props.columns.filter((column) => column.hidden).map((column) => column.key),
)

if (props.storageKey) {
  try {
    const stored = localStorage.getItem(`data-table:${props.storageKey}`)
    if (stored) hidden.value = JSON.parse(stored) as string[]
  } catch {
    // Unreadable or unparseable storage means the defaults. Not worth a message.
  }

  watch(hidden, (value) => {
    try {
      localStorage.setItem(`data-table:${props.storageKey}`, JSON.stringify(value))
    } catch {
      // Safari in private mode throws on write.
    }
  })
}

const visibleColumns = computed(() => props.columns.filter((c) => !hidden.value.includes(c.key)))

/** Selection and actions are columns too, as far as an empty row's `colspan` is concerned. */
const columnCount = computed(
  () => visibleColumns.value.length + (props.selectable ? 1 : 0) + (hasActions.value ? 1 : 0),
)

/* ------------------------------------------------------------------------- sorting */

function onSort(next: DataTableSort): void {
  sort.value = next
  // Re-sorting and staying on page 7 shows a page of a list you have not seen the start
  // of. Every table wants this, so it happens here rather than in each page component.
  page.value = 1
}

/* ----------------------------------------------------------------------- selection */

function idOf(row: Row): string {
  const value = cellValue(row, props.rowKey)
  return typeof value === 'number' ? String(value) : (value as string)
}

const allSelected = computed(
  () => props.rows.length > 0 && props.rows.every((row) => selected.value.includes(idOf(row))),
)

const headerState = computed<boolean | 'indeterminate'>(() => {
  if (allSelected.value) return true
  return selected.value.length > 0 ? 'indeterminate' : false
})

function toggleAll(value: boolean | 'indeterminate'): void {
  selected.value = value === true ? props.rows.map(idOf) : []
}

/**
 * Where a range starts. `Shift`-click is the difference between selecting forty rows and
 * giving up at six, and it costs one ref.
 */
const anchor = ref<number | null>(null)
const shiftHeld = ref(false)

function toggleRow(index: number, value: boolean | 'indeterminate'): void {
  const checked = value === true
  const from = shiftHeld.value && anchor.value !== null ? anchor.value : index
  const [start, end] = from <= index ? [from, index] : [index, from]

  const affected = props.rows.slice(start, end + 1).map(idOf)
  const rest = selected.value.filter((id) => !affected.includes(id))

  selected.value = checked ? [...rest, ...affected] : rest
  anchor.value = index
}

// The rows underneath changed; a count carried over from the previous page would refer to
// rows that are no longer on screen, and a bulk action would then hit the wrong ones.
watch([page, perPage], () => {
  selected.value = []
  anchor.value = null
})

/* -------------------------------------------------------------------------- cells */

/** A column key is a plain string, so reading a row by one costs a cast. Once, here. */
function cellValue(row: Row, key: string): unknown {
  return (row as Record<string, unknown>)[key]
}

function display(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  // An array of roles, a nested object: only the page knows how those should look, and
  // it says so with a `#cell:` slot. Printing `[object Object]` would be worse than a dash.
  return '—'
}
</script>

<template>
  <div class="space-y-4">
    <div v-if="slots.toolbar || props.viewOptions" class="flex items-start gap-2">
      <div class="flex flex-1 flex-wrap items-center gap-2">
        <slot name="toolbar" />
      </div>
      <DataTableViewOptions v-if="props.viewOptions" v-model="hidden" :columns="props.columns" />
    </div>

    <div class="bg-card overflow-hidden rounded-xl border">
      <Table>
        <TableHeader class="bg-muted/50">
          <TableRow class="hover:bg-transparent">
            <TableHead v-if="props.selectable" class="w-10">
              <Checkbox
                :model-value="headerState"
                aria-label="Select all rows on this page"
                @update:model-value="toggleAll"
              />
            </TableHead>

            <TableHead
              v-for="column in visibleColumns"
              :key="column.key"
              :class="cn(column.class, column.align === 'end' && 'text-right')"
            >
              <DataTableColumnHeader
                :column="column"
                :sort="sort"
                :hideable="props.viewOptions && column.hideable !== false"
                @update:sort="onSort"
                @hide="(key) => (hidden = [...hidden, key])"
              />
            </TableHead>

            <TableHead v-if="hasActions" class="w-12">
              <span class="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          <DataTableSkeleton
            v-if="props.loading"
            :columns="visibleColumns"
            :rows="perPage"
            :selectable="props.selectable"
            :actions="hasActions"
          />

          <TableRow v-else-if="props.rows.length === 0" class="hover:bg-transparent">
            <TableCell :colspan="columnCount" class="h-40">
              <slot name="empty">
                <div class="text-muted-foreground flex flex-col items-center gap-2 text-sm">
                  <Inbox class="size-6" />
                  {{ props.empty }}
                </div>
              </slot>
            </TableCell>
          </TableRow>

          <TableRow
            v-for="(row, index) in props.rows"
            v-else
            :key="idOf(row)"
            :data-state="selected.includes(idOf(row)) ? 'selected' : undefined"
          >
            <TableCell
              v-if="props.selectable"
              class="w-10"
              @click.capture="(event: MouseEvent) => (shiftHeld = event.shiftKey)"
            >
              <Checkbox
                :model-value="selected.includes(idOf(row))"
                :aria-label="`Select row ${index + 1}`"
                @update:model-value="(value) => toggleRow(index, value)"
              />
            </TableCell>

            <TableCell
              v-for="column in visibleColumns"
              :key="column.key"
              :class="cn(column.class, column.align === 'end' && 'text-right')"
            >
              <slot :name="`cell:${column.key}`" :row="row" :value="cellValue(row, column.key)">
                {{ display(cellValue(row, column.key)) }}
              </slot>
            </TableCell>

            <TableCell v-if="hasActions" class="w-12 text-right">
              <slot name="actions" :row="row" />
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <DataTablePagination
      v-model:page="page"
      v-model:per-page="perPage"
      :mode="props.mode"
      :total="props.total"
      :has-prev="props.hasPrev"
      :has-next="props.hasNext"
      :row-count="props.rows.length"
      :selected-count="props.selectable ? selected.length : 0"
      @prev="emit('prev')"
      @next="emit('next')"
    />

    <!--
      Sticky rather than fixed: it stops at the bottom of the table instead of floating
      over an unrelated part of the page once you scroll past the list.
    -->
    <div
      v-if="slots.bulk && selected.length > 0"
      class="pointer-events-none sticky bottom-4 z-20 flex justify-center"
    >
      <div
        class="bg-popover text-popover-foreground pointer-events-auto flex items-center gap-3 rounded-full border px-3 py-2 shadow-lg"
      >
        <span class="pl-2 text-sm font-medium">{{ selected.length }} selected</span>
        <slot name="bulk" :selected="selected" :clear="() => (selected = [])" />
        <Button variant="ghost" size="sm" class="rounded-full" @click="selected = []">Clear</Button>
      </div>
    </div>
  </div>
</template>

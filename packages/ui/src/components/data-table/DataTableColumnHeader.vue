<script setup lang="ts">
import { ArrowDown, ArrowUp, ChevronsUpDown, EyeOff } from '@lucide/vue'
import { computed } from 'vue'

import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import type { DataTableColumn, DataTableSort } from './types'

/**
 * The label inside a `<th>`.
 *
 * A column that cannot be sorted renders as plain text, not as a button that opens a
 * menu offering nothing. Half of a table's columns are usually in that state, and a row
 * of dead affordances teaches people to stop clicking the live ones.
 */
const props = defineProps<{
  column: DataTableColumn
  sort: DataTableSort
  /** Left out by the skeleton and by tables with no View menu. */
  hideable?: boolean
}>()

const emit = defineEmits<{
  'update:sort': [value: DataTableSort]
  hide: [key: string]
}>()

/** Only when *this* column is the sorted one — every other header shows the neutral glyph. */
const order = computed(() => (props.sort?.key === props.column.key ? props.sort.order : null))

function sortBy(next: 'asc' | 'desc'): void {
  emit('update:sort', { key: props.column.key, order: next })
}
</script>

<template>
  <div
    :class="cn('flex items-center', props.column.align === 'end' ? 'justify-end' : 'justify-start')"
  >
    <span v-if="!props.column.sortable">{{ props.column.header }}</span>

    <DropdownMenu v-else>
      <DropdownMenuTrigger
        class="hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 -mx-2 flex h-8 items-center gap-1.5 rounded-md px-2 outline-none focus-visible:ring-[3px]"
        :aria-label="`Sort by ${props.column.header}`"
      >
        <span>{{ props.column.header }}</span>
        <ArrowUp v-if="order === 'asc'" class="size-3.5" />
        <ArrowDown v-else-if="order === 'desc'" class="size-3.5" />
        <ChevronsUpDown v-else class="size-3.5 opacity-50" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" class="min-w-[10rem]">
        <DropdownMenuItem @select="sortBy('asc')">
          <ArrowUp />
          Ascending
        </DropdownMenuItem>
        <DropdownMenuItem @select="sortBy('desc')">
          <ArrowDown />
          Descending
        </DropdownMenuItem>
        <template v-if="props.hideable">
          <DropdownMenuSeparator />
          <DropdownMenuItem @select="emit('hide', props.column.key)">
            <EyeOff />
            Hide column
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
</template>

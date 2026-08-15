<script setup lang="ts">
import { Skeleton } from '../skeleton'
import { TableCell, TableRow } from '../table'
import type { DataTableColumn } from './types'

/**
 * Placeholder rows, rendered inside the real `<thead>`'s table and with the real columns.
 *
 * That is the whole point of a skeleton over a spinner: the header, the column widths and
 * the row height are already correct, so when the data lands nothing moves. A spinner
 * followed by a table is two layouts; this is one layout twice.
 */
withDefaults(
  defineProps<{
    columns: readonly DataTableColumn[]
    /** Match the page size, so the table does not grow taller as the rows arrive. */
    rows?: number
    selectable?: boolean
    actions?: boolean
  }>(),
  { rows: 10 },
)

/**
 * Cycled by column index. Equal-width bars read as a placeholder for a spreadsheet;
 * uneven ones read as a placeholder for text, which is what is usually coming.
 */
const WIDTHS = ['w-32', 'w-24', 'w-40', 'w-20', 'w-28'] as const
</script>

<template>
  <TableRow v-for="row in rows" :key="row" class="hover:bg-transparent">
    <TableCell v-if="selectable" class="w-10">
      <Skeleton class="size-5 rounded-[4px]" />
    </TableCell>

    <TableCell
      v-for="(column, index) in columns"
      :key="column.key"
      :class="[column.class, column.align === 'end' && 'text-right']"
    >
      <Skeleton :class="['inline-block h-4', WIDTHS[index % WIDTHS.length]]" />
    </TableCell>

    <TableCell v-if="actions" class="w-12 text-right">
      <Skeleton class="ml-auto size-8 rounded-md" />
    </TableCell>
  </TableRow>
</template>

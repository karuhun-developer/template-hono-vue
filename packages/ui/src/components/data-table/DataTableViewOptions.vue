<script setup lang="ts">
import { Settings2 } from '@lucide/vue'
import { computed } from 'vue'

import { Button } from '../button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../dropdown-menu'
import type { DataTableColumn } from './types'

/**
 * The **View** menu: one checkbox per column the table is willing to hide.
 *
 * Columns with `hideable: false` never appear here. There has to be at least one column
 * left that says which row you are looking at, and the cheapest way to guarantee that is
 * to make it impossible to switch off.
 */
const props = defineProps<{ columns: readonly DataTableColumn[] }>()

/** The *hidden* keys, not the visible ones — an empty array is the default state. */
const hidden = defineModel<string[]>({ required: true })

const offerable = computed(() => props.columns.filter((column) => column.hideable !== false))

function toggle(key: string, visible: boolean): void {
  hidden.value = visible ? hidden.value.filter((k) => k !== key) : [...hidden.value, key]
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="outline" size="sm">
        <Settings2 />
        View
      </Button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-44">
      <DropdownMenuLabel>Toggle columns</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuCheckboxItem
        v-for="column in offerable"
        :key="column.key"
        :model-value="!hidden.includes(column.key)"
        @update:model-value="(value) => toggle(column.key, value === true)"
        @select="(event) => event.preventDefault()"
      >
        {{ column.header }}
      </DropdownMenuCheckboxItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { Check, CirclePlus } from '@lucide/vue'
import { computed } from 'vue'

import { cn } from '../../lib/utils'
import { Badge } from '../badge'
import { Button } from '../button'
import { Popover, PopoverContent, PopoverTrigger } from '../popover'
import { Separator } from '../separator'
import type { DataTableFacet } from './types'

/**
 * The `⊕ Status` pill: a popover holding a checkbox list, with the chosen values shown
 * on the trigger itself.
 *
 * Showing them on the trigger is the point. A filter you cannot see is how someone ends
 * up reporting that a row "disappeared" when they narrowed the list four minutes ago and
 * scrolled past the control since.
 */
const props = withDefaults(
  defineProps<{
    label: string
    options: readonly DataTableFacet[]
    /** Past this many, the trigger shows a count instead of a row of badges. */
    maxBadges?: number
  }>(),
  { maxBadges: 2 },
)

const selected = defineModel<string[]>({ required: true })

const chosen = computed(() =>
  props.options.filter((option) => selected.value.includes(option.value)),
)

function toggle(value: string): void {
  selected.value = selected.value.includes(value)
    ? selected.value.filter((v) => v !== value)
    : [...selected.value, value]
}
</script>

<template>
  <Popover>
    <PopoverTrigger as-child>
      <Button variant="outline" size="sm" class="border-dashed">
        <CirclePlus />
        {{ props.label }}

        <template v-if="selected.length > 0">
          <Separator orientation="vertical" class="mx-0.5 h-4" />
          <Badge v-if="selected.length > props.maxBadges" variant="secondary" class="rounded-sm">
            {{ selected.length }} selected
          </Badge>
          <Badge
            v-for="option in chosen"
            v-else
            :key="option.value"
            variant="secondary"
            class="rounded-sm"
          >
            {{ option.label }}
          </Badge>
        </template>
      </Button>
    </PopoverTrigger>

    <PopoverContent align="start" class="w-56 p-1">
      <div class="max-h-72 overflow-y-auto">
        <button
          v-for="option in props.options"
          :key="option.value"
          type="button"
          class="hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent flex w-full items-center gap-2 rounded-md px-2 py-2 text-sm outline-none"
          :aria-pressed="selected.includes(option.value)"
          @click="toggle(option.value)"
        >
          <span
            :class="
              cn(
                'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                selected.includes(option.value)
                  ? 'bg-primary border-primary text-primary-foreground'
                  : 'border-input',
              )
            "
          >
            <Check v-if="selected.includes(option.value)" class="size-3" />
          </span>
          <span class="truncate">{{ option.label }}</span>
          <span v-if="option.count !== undefined" class="text-muted-foreground ml-auto text-xs">
            {{ option.count }}
          </span>
        </button>
      </div>

      <template v-if="selected.length > 0">
        <Separator class="my-1" />
        <button
          type="button"
          class="hover:bg-accent hover:text-accent-foreground w-full rounded-md px-2 py-2 text-center text-sm outline-none"
          @click="selected = []"
        >
          Clear {{ props.label.toLowerCase() }}
        </button>
      </template>
    </PopoverContent>
  </Popover>
</template>

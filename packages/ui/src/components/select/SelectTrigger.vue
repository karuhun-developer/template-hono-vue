<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'
import { SelectIcon, SelectTrigger, useForwardProps, type SelectTriggerProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = withDefaults(
  defineProps<SelectTriggerProps & { class?: HTMLAttributes['class']; size?: 'sm' | 'default' }>(),
  { size: 'default' },
)

const delegated = computed(() => {
  const { class: _class, size: _size, ...rest } = props
  return rest
})

const forwarded = useForwardProps(delegated)
</script>

<template>
  <SelectTrigger
    v-bind="forwarded"
    data-slot="select-trigger"
    :data-size="props.size"
    :class="
      cn(
        'border-input bg-background flex w-fit items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder]:text-muted-foreground',
        `[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4`,
        props.size === 'sm' ? 'h-9' : 'h-11',
        props.class,
      )
    "
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDown class="size-4 opacity-50" />
    </SelectIcon>
  </SelectTrigger>
</template>

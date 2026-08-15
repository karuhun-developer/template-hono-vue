<script setup lang="ts">
import { DropdownMenuLabel, useForwardProps, type DropdownMenuLabelProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<
  DropdownMenuLabelProps & { class?: HTMLAttributes['class']; inset?: boolean }
>()

const delegated = computed(() => {
  const { class: _class, inset: _inset, ...rest } = props
  return rest
})

const forwarded = useForwardProps(delegated)
</script>

<template>
  <DropdownMenuLabel
    v-bind="forwarded"
    data-slot="dropdown-menu-label"
    :class="cn('px-2 py-1.5 text-sm font-medium', props.inset && 'pl-8', props.class)"
  >
    <slot />
  </DropdownMenuLabel>
</template>

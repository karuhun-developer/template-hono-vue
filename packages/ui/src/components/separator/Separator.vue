<script setup lang="ts">
import { Separator, type SeparatorProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = withDefaults(defineProps<SeparatorProps & { class?: HTMLAttributes['class'] }>(), {
  orientation: 'horizontal',
  decorative: true,
})
</script>

<template>
  <Separator
    data-slot="separator"
    :orientation="props.orientation"
    :decorative="props.decorative"
    :as="props.as"
    :as-child="props.asChild"
    :class="
      cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        props.class,
      )
    "
  >
    <slot />
  </Separator>
</template>

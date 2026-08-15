<script setup lang="ts">
import { AvatarFallback, useForwardProps, type AvatarFallbackProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<AvatarFallbackProps & { class?: HTMLAttributes['class'] }>()

const delegated = computed(() => {
  const { class: _ignored, ...rest } = props
  return rest
})

const forwarded = useForwardProps(delegated)
</script>

<template>
  <AvatarFallback
    v-bind="forwarded"
    data-slot="avatar-fallback"
    :class="
      cn(
        'bg-muted text-muted-foreground flex size-full items-center justify-center rounded-lg text-xs font-medium uppercase',
        props.class,
      )
    "
  >
    <slot />
  </AvatarFallback>
</template>

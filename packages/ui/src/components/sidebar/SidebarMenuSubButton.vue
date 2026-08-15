<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = withDefaults(
  defineProps<PrimitiveProps & { active?: boolean; class?: HTMLAttributes['class'] }>(),
  { as: 'a' },
)
</script>

<template>
  <Primitive
    data-slot="sidebar-menu-sub-button"
    :as="props.as"
    :as-child="props.asChild"
    :data-active="props.active"
    :class="
      cn(
        'text-sidebar-foreground/80 flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-sm outline-hidden',
        'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring focus-visible:ring-2',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium',
        '[&>svg]:size-4 [&>svg]:shrink-0',
        props.class,
      )
    "
  >
    <slot />
  </Primitive>
</template>

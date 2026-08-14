<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'
import { badgeVariants, type BadgeVariants } from './index'

const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      variant?: BadgeVariants['variant']
      class?: HTMLAttributes['class']
    }
  >(),
  { as: 'span' },
)
</script>

<template>
  <Primitive
    data-slot="badge"
    :as="props.as"
    :as-child="props.asChild"
    :class="cn(badgeVariants({ variant: props.variant }), props.class)"
  >
    <slot />
  </Primitive>
</template>

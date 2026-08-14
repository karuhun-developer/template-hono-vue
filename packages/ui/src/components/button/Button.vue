<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'
import { buttonVariants, type ButtonVariants } from './index'

const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      variant?: ButtonVariants['variant']
      size?: ButtonVariants['size']
      class?: HTMLAttributes['class']
    }
  >(),
  { as: 'button' },
)
</script>

<template>
  <Primitive
    data-slot="button"
    :as="props.as"
    :as-child="props.asChild"
    :class="cn(buttonVariants({ variant: props.variant, size: props.size }), props.class)"
  >
    <slot />
  </Primitive>
</template>

<script setup lang="ts">
import { Check, Minus } from '@lucide/vue'
import {
  CheckboxIndicator,
  CheckboxRoot,
  useForwardPropsEmits,
  type CheckboxRootEmits,
  type CheckboxRootProps,
} from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<CheckboxRootProps & { class?: HTMLAttributes['class'] }>()
const emits = defineEmits<CheckboxRootEmits>()

const delegated = computed(() => {
  const { class: _ignored, ...rest } = props
  return rest
})

const forwarded = useForwardPropsEmits(delegated, emits)
</script>

<template>
  <CheckboxRoot
    v-bind="forwarded"
    data-slot="checkbox"
    :class="
      cn(
        // size-5 rather than size-4: the permission matrix is a grid of these, and a
        // 16px hit area next to another 16px hit area is a mis-tap waiting to happen.
        'peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:border-primary size-5 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
        props.class,
      )
    "
  >
    <CheckboxIndicator
      data-slot="checkbox-indicator"
      class="flex items-center justify-center text-current transition-none"
    >
      <Minus v-if="props.modelValue === 'indeterminate'" class="size-3.5" />
      <Check v-else class="size-3.5" />
    </CheckboxIndicator>
  </CheckboxRoot>
</template>

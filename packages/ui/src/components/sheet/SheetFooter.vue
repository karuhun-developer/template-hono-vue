<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <!-- pb-safe: a footer button pinned to the bottom must clear the iPhone home indicator. -->
  <div
    data-slot="sheet-footer"
    :class="cn('mt-auto flex flex-col gap-2 border-t p-5 pb-safe', props.class)"
  >
    <slot />
  </div>
</template>

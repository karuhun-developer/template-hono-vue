<script setup lang="ts">
import { DialogTitle, type DialogTitleProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<DialogTitleProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <DialogTitle
    data-slot="sheet-title"
    :as="props.as"
    :as-child="props.asChild"
    :class="cn('text-foreground text-lg font-semibold', props.class)"
  >
    <slot />
  </DialogTitle>
</template>

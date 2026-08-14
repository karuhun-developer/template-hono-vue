<script setup lang="ts">
import { DialogDescription, type DialogDescriptionProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<DialogDescriptionProps & { class?: HTMLAttributes['class'] }>()
</script>

<template>
  <DialogDescription
    data-slot="dialog-description"
    :as="props.as"
    :as-child="props.asChild"
    :class="cn('text-muted-foreground text-sm', props.class)"
  >
    <slot />
  </DialogDescription>
</template>

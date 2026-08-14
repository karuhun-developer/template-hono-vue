<script setup lang="ts">
import { cn, inputBaseClass, inputStateClass } from '@app/ui'
import type { HTMLAttributes } from 'vue'

/**
 * The browser's own `<select>`, wrapped so it matches `Input` exactly.
 *
 * A custom dropdown is worth building only when it needs something the native control
 * cannot do — search inside the list, multi-select, rich rows. Until then the native one
 * wins on every axis that matters: it is keyboard accessible for free, it opens as a
 * proper picker on a phone, and it never renders behind a scrolling dialog.
 */
defineProps<{ class?: HTMLAttributes['class']; disabled?: boolean }>()

const model = defineModel<string>({ required: true })
</script>

<template>
  <select
    v-model="model"
    :disabled="disabled"
    :class="cn(inputBaseClass, inputStateClass, 'cursor-pointer pr-8', $props.class)"
  >
    <slot />
  </select>
</template>

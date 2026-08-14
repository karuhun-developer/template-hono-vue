<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <!-- pb-safe: tombol "Tambah — Rp 24.000" tidak boleh tertutup home indicator iPhone. -->
  <div
    data-slot="sheet-footer"
    :class="cn('mt-auto flex flex-col gap-2 border-t p-5 pb-safe', props.class)"
  >
    <slot />
  </div>
</template>

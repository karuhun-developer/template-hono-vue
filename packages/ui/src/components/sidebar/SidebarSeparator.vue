<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <hr
    data-slot="sidebar-separator"
    :class="cn('bg-sidebar-border mx-2 h-px border-0', props.class)"
  />
</template>

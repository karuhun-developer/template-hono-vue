<script setup lang="ts">
import { DropdownMenuSeparator } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <DropdownMenuSeparator
    data-slot="dropdown-menu-separator"
    :class="cn('bg-border -mx-1 my-1 h-px', props.class)"
  />
</template>

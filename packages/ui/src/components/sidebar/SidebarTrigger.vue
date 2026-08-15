<script setup lang="ts">
import { PanelLeft } from '@lucide/vue'
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'
import { Button } from '../button'
import { useSidebar } from './context'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()

const { toggle } = useSidebar()
</script>

<template>
  <Button
    data-slot="sidebar-trigger"
    variant="ghost"
    size="icon-sm"
    :class="cn('shrink-0', props.class)"
    @click="toggle"
  >
    <PanelLeft />
    <span class="sr-only">Toggle the sidebar</span>
  </Button>
</template>

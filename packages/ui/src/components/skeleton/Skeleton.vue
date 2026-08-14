<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<{ class?: HTMLAttributes['class'] }>()
</script>

<template>
  <!--
    A skeleton is not decoration. Give it the size of the content it stands in for and
    the layout stops jumping when the data lands — which matters most on the row a
    finger is already moving towards.
  -->
  <div data-slot="skeleton" :class="cn('bg-accent animate-pulse rounded-md', props.class)" />
</template>

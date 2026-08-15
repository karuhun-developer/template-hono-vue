<script setup lang="ts">
import { AvatarImage, useForwardProps, type AvatarImageProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<AvatarImageProps & { class?: HTMLAttributes['class'] }>()

const delegated = computed(() => {
  const { class: _ignored, ...rest } = props
  return rest
})

const forwarded = useForwardProps(delegated)
</script>

<template>
  <AvatarImage
    v-bind="forwarded"
    data-slot="avatar-image"
    :class="cn('aspect-square size-full object-cover', props.class)"
  />
</template>

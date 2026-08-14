<script setup lang="ts">
import { X } from '@lucide/vue'
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
  type DialogContentEmits,
  type DialogContentProps,
} from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<
  DialogContentProps & {
    class?: HTMLAttributes['class']
    /** Hide the close cross — for a dialog that must be answered through its buttons. */
    hideClose?: boolean
  }
>()
const emits = defineEmits<DialogContentEmits>()

const delegated = computed(() => {
  const { class: _class, hideClose: _hideClose, ...rest } = props
  return rest
})

const forwarded = useForwardPropsEmits(delegated, emits)
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      data-slot="dialog-overlay"
      class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50"
    />
    <DialogContent
      v-bind="forwarded"
      data-slot="dialog-content"
      :class="
        cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-2xl border p-6 shadow-lg duration-200 sm:max-w-lg',
          props.class,
        )
      "
    >
      <slot />
      <DialogClose
        v-if="!props.hideClose"
        class="ring-offset-background focus:ring-ring data-[state=open]:bg-accent absolute top-4 right-4 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:pointer-events-none"
      >
        <X class="size-4" />
        <span class="sr-only">Tutup</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>

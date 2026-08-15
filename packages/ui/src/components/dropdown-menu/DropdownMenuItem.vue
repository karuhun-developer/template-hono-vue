<script setup lang="ts">
import { DropdownMenuItem, useForwardProps, type DropdownMenuItemProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'

const props = defineProps<
  DropdownMenuItemProps & {
    class?: HTMLAttributes['class']
    /** Sign out, delete, revoke — anything the user should look at twice. */
    variant?: 'default' | 'destructive'
    inset?: boolean
  }
>()

const delegated = computed(() => {
  const { class: _class, variant: _variant, inset: _inset, ...rest } = props
  return rest
})

const forwarded = useForwardProps(delegated)
</script>

<template>
  <DropdownMenuItem
    v-bind="forwarded"
    data-slot="dropdown-menu-item"
    :data-variant="props.variant"
    :class="
      cn(
        'relative flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-sm outline-hidden select-none',
        'focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        `[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground`,
        props.variant === 'destructive' &&
          'text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg:not([class*=text-])]:text-destructive',
        props.inset && 'pl-8',
        props.class,
      )
    "
  >
    <slot />
  </DropdownMenuItem>
</template>

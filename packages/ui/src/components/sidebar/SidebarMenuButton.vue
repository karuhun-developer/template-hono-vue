<script setup lang="ts">
import { Primitive, type PrimitiveProps } from 'reka-ui'
import { computed, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../tooltip'
import { useSidebar } from './context'

/**
 * A navigation row.
 *
 * The label is hidden on the rail with `opacity-0` and a zero width rather than `v-if`,
 * because `v-if` would unmount the text mid-transition and the row would visibly reflow
 * instead of sliding.
 *
 * `tooltip` is shown **only** when collapsed. A tooltip repeating a label that is already
 * on screen is noise; one naming an icon that has lost its label is the only thing making
 * the rail usable.
 */
const props = withDefaults(
  defineProps<
    PrimitiveProps & {
      active?: boolean
      tooltip?: string
      size?: 'default' | 'sm'
      class?: HTMLAttributes['class']
    }
  >(),
  { as: 'button', size: 'default' },
)

const { state, isMobile } = useSidebar()

const showTooltip = computed(
  () => props.tooltip !== undefined && state.value === 'collapsed' && !isMobile.value,
)

const classes = computed(() =>
  cn(
    'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-lg p-2 text-left text-sm outline-hidden transition-[width,height,padding]',
    'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-sidebar-ring focus-visible:ring-2',
    'disabled:pointer-events-none disabled:opacity-50',
    'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground data-[active=true]:font-medium',
    `[&>svg]:size-4 [&>svg]:shrink-0`,
    'group-data-[state=collapsed]:!size-9 group-data-[state=collapsed]:!p-2',
    props.size === 'sm' ? 'h-8' : 'h-9',
    props.class,
  ),
)
</script>

<template>
  <Tooltip v-if="showTooltip" :delay-duration="0">
    <TooltipTrigger as-child>
      <Primitive
        data-slot="sidebar-menu-button"
        data-sidebar="menu-button"
        :as="props.as"
        :as-child="props.asChild"
        :data-active="props.active"
        :class="classes"
      >
        <slot />
      </Primitive>
    </TooltipTrigger>
    <TooltipContent side="right" :side-offset="8">{{ props.tooltip }}</TooltipContent>
  </Tooltip>

  <Primitive
    v-else
    data-slot="sidebar-menu-button"
    data-sidebar="menu-button"
    :as="props.as"
    :as-child="props.asChild"
    :data-active="props.active"
    :class="classes"
  >
    <slot />
  </Primitive>
</template>

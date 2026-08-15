<script setup lang="ts">
import type { HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '../sheet'
import { useSidebar } from './context'

/**
 * The sidebar itself.
 *
 * Below `md` it renders **the same children** inside the existing `Sheet`. That is the
 * whole reason there is no second navigation component: one tree, two arrangements, so a
 * menu item added once appears in both. The previous shell had a sidebar and a bottom bar
 * that each rendered the nav list their own way, which works right up until a nested item
 * arrives that a row of four thumb-sized tabs cannot express.
 */
const props = defineProps<{ class?: HTMLAttributes['class'] }>()

const { isMobile, openMobile, setOpenMobile, state } = useSidebar()
</script>

<template>
  <Sheet v-if="isMobile" :open="openMobile" @update:open="setOpenMobile">
    <SheetContent
      side="left"
      data-slot="sidebar"
      data-mobile="true"
      class="bg-sidebar text-sidebar-foreground w-(--sidebar-width) gap-0 p-0 [&>button]:hidden"
    >
      <!-- Required by the dialog primitive for its accessible name; visually redundant. -->
      <SheetTitle class="sr-only">Navigation</SheetTitle>
      <SheetDescription class="sr-only">Links to every section of the console.</SheetDescription>
      <div class="flex h-full w-full flex-col"><slot /></div>
    </SheetContent>
  </Sheet>

  <div
    v-else
    class="group peer text-sidebar-foreground hidden md:block"
    :data-state="state"
    data-slot="sidebar"
  >
    <!--
      Two elements, and both are load-bearing. This one is a plain block that occupies
      space in the flex row; the fixed one below is what the user sees. Animating a fixed
      element alone would leave the content beside it un-shifted, and animating a static
      one alone drops the sidebar out of view on scroll.
    -->
    <div
      class="relative h-dvh w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear group-data-[state=collapsed]:w-(--sidebar-width-icon)"
    />
    <div
      :class="
        cn(
          'fixed inset-y-0 left-0 z-10 hidden h-dvh w-(--sidebar-width) transition-[width] duration-200 ease-linear md:flex',
          'group-data-[state=collapsed]:w-(--sidebar-width-icon)',
          props.class,
        )
      "
    >
      <div
        data-sidebar="sidebar"
        class="bg-sidebar border-sidebar-border flex h-full w-full flex-col border-r"
      >
        <slot />
      </div>
    </div>
  </div>
</template>

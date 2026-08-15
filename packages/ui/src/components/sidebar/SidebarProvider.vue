<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, type HTMLAttributes } from 'vue'

import { cn } from '../../lib/utils'
import { TooltipProvider } from '../tooltip'
import { provideSidebar, SIDEBAR_STORAGE_KEY, SIDEBAR_WIDTH, SIDEBAR_WIDTH_ICON } from './context'

/**
 * Owns the sidebar's state and hands it down. Wrap the whole shell in this.
 *
 * Two independent notions of "open" live here on purpose. On a phone the sidebar is a
 * sheet that must start closed on every navigation; on a desktop it is a rail whose state
 * is a preference that should outlive the tab. Collapsing them into one flag gives you
 * either a sheet that reopens itself or a rail that forgets.
 */
const props = defineProps<{ class?: HTMLAttributes['class'] }>()

const open = ref(true)
const openMobile = ref(false)
const isMobile = ref(false)

const state = computed(() => (open.value ? ('expanded' as const) : ('collapsed' as const)))

function setOpen(value: boolean): void {
  open.value = value
  // Written on every change rather than on unmount: a tab closed by the OS never unmounts.
  try {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, String(value))
  } catch {
    // Safari in private mode throws on write. A sidebar that forgets is not a failure.
  }
}

function setOpenMobile(value: boolean): void {
  openMobile.value = value
}

function toggle(): void {
  if (isMobile.value) setOpenMobile(!openMobile.value)
  else setOpen(!open.value)
}

/**
 * `md` — the same breakpoint the rest of the console uses. Read from `matchMedia` rather
 * than from `window.innerWidth` so a rotation or a resized window is picked up without a
 * resize listener firing on every pixel.
 */
const query = '(max-width: 767px)'
let media: MediaQueryList | undefined

function onMediaChange(event: MediaQueryListEvent | MediaQueryList): void {
  isMobile.value = event.matches
  // Leaving mobile with the sheet open would otherwise leave an invisible overlay
  // swallowing clicks on the desktop layout.
  if (!event.matches) openMobile.value = false
}

onMounted(() => {
  media = window.matchMedia(query)
  onMediaChange(media)
  media.addEventListener('change', onMediaChange)

  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY)
    if (stored !== null) open.value = stored === 'true'
  } catch {
    // See setOpen.
  }

  window.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  media?.removeEventListener('change', onMediaChange)
  window.removeEventListener('keydown', onKeydown)
})

/** The shortcut everybody who has used an editor already tries. */
function onKeydown(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== 'b' || !(event.metaKey || event.ctrlKey)) return

  event.preventDefault()
  toggle()
}

provideSidebar({ open, openMobile, isMobile, state, toggle, setOpen, setOpenMobile })
</script>

<template>
  <!--
    The tooltip provider lives here because the tooltips it serves are the labels on the
    collapsed rail — a sidebar that needs a provider its caller has to remember to add is
    a sidebar that silently loses its labels the first time somebody collapses it.
  -->
  <TooltipProvider :delay-duration="0">
    <div
      data-slot="sidebar-wrapper"
      :style="{ '--sidebar-width': SIDEBAR_WIDTH, '--sidebar-width-icon': SIDEBAR_WIDTH_ICON }"
      :class="cn('group/sidebar-wrapper flex min-h-dvh w-full', props.class)"
    >
      <slot />
    </div>
  </TooltipProvider>
</template>

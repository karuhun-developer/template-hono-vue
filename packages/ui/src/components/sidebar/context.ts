import { inject, provide, type ComputedRef, type InjectionKey, type Ref } from 'vue'

/**
 * The sidebar's shared state.
 *
 * It is passed by `provide`/`inject` rather than as props because the parts that need it
 * are not the parts that own it: a `SidebarMenuButton` nested four levels down has to know
 * whether the rail is collapsed in order to decide whether to show its tooltip, and
 * threading that through every intermediate component is how a layout becomes unusable.
 */

export type SidebarState = {
  /** Desktop only. On mobile the sidebar is a sheet, and this stays whatever it was. */
  open: Ref<boolean>
  openMobile: Ref<boolean>
  isMobile: Ref<boolean>
  /** `expanded` or `collapsed` — read by the CSS through `data-state`. */
  state: ComputedRef<'expanded' | 'collapsed'>
  /** Toggles the sheet on mobile and the rail on desktop, so one button serves both. */
  toggle: () => void
  setOpen: (value: boolean) => void
  setOpenMobile: (value: boolean) => void
}

export const SIDEBAR_INJECTION_KEY = Symbol('sidebar') as InjectionKey<SidebarState>

export function provideSidebar(state: SidebarState): void {
  provide(SIDEBAR_INJECTION_KEY, state)
}

/**
 * Throws rather than returning `undefined` when there is no provider above. A sidebar part
 * rendered outside `SidebarProvider` is always a mistake, and a hard error at mount names
 * it — the alternative is a rail that silently never collapses.
 */
export function useSidebar(): SidebarState {
  const state = inject(SIDEBAR_INJECTION_KEY)
  if (!state) throw new Error('useSidebar() requires a <SidebarProvider> ancestor.')

  return state
}

/** Width of the rail when collapsed: an icon plus its padding, and nothing else. */
export const SIDEBAR_WIDTH = '16rem'
export const SIDEBAR_WIDTH_ICON = '3.25rem'
export const SIDEBAR_STORAGE_KEY = 'sidebar:open'

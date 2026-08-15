<script setup lang="ts">
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuLabel,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@app/ui'
import { ChevronRight, Command } from '@lucide/vue'
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import NavUser from '@/components/NavUser.vue'
import { visibleGroups } from '@/lib/access'
import { NAV_GROUPS } from '@/lib/nav'
import { useSessionStore } from '@/stores/session'

/**
 * The console's navigation.
 *
 * One definition — `NAV_GROUPS` — rendered once. On a phone the same markup is what the
 * sheet contains, because `Sidebar` puts its children there; there is no second mobile
 * navigation to keep in step with this one.
 */
const route = useRoute()
const session = useSessionStore()
const { setOpenMobile, isMobile } = useSidebar()

const groups = computed(() => visibleGroups(NAV_GROUPS, { permissions: session.permissions }))

/** `/` matches only itself; everything else matches its own subtree. */
function isActive(to: string): boolean {
  return to === '/' ? route.path === '/' : route.path.startsWith(to)
}

/**
 * Tapping a link on a phone navigates *behind* the sheet unless the sheet is closed. On a
 * desktop there is nothing to close, so this does nothing there.
 */
function onNavigate(): void {
  if (isMobile.value) setOpenMobile(false)
}
</script>

<template>
  <Sidebar>
    <SidebarHeader>
      <SidebarMenuButton class="h-12" as-child>
        <RouterLink to="/" @click="onNavigate">
          <span
            class="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 shrink-0 items-center justify-center rounded-lg"
          >
            <Command class="size-4" />
          </span>
          <SidebarMenuLabel class="grid text-left leading-tight">
            <span class="truncate text-sm font-semibold">Console</span>
            <span class="text-sidebar-foreground/60 truncate text-xs">Back office</span>
          </SidebarMenuLabel>
        </RouterLink>
      </SidebarMenuButton>
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup v-for="group in groups" :key="group.label">
        <SidebarGroupLabel>{{ group.label }}</SidebarGroupLabel>

        <SidebarMenu>
          <SidebarMenuItem v-for="item in group.items" :key="item.to">
            <!-- A row that expands. Open from the start when the page you are on is inside it. -->
            <Collapsible
              v-if="item.children"
              as-child
              class="group/collapsible"
              :default-open="isActive(item.to)"
            >
              <div>
                <CollapsibleTrigger as-child>
                  <SidebarMenuButton :tooltip="item.label" :active="isActive(item.to)">
                    <component :is="item.icon" />
                    <SidebarMenuLabel>{{ item.label }}</SidebarMenuLabel>
                    <ChevronRight
                      class="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90 group-data-[state=collapsed]:hidden"
                    />
                  </SidebarMenuButton>
                </CollapsibleTrigger>

                <CollapsibleContent>
                  <SidebarMenuSub>
                    <SidebarMenuSubItem v-for="child in item.children" :key="child.to">
                      <SidebarMenuSubButton as-child :active="isActive(child.to)">
                        <RouterLink :to="child.to" @click="onNavigate">
                          {{ child.label }}
                        </RouterLink>
                      </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                  </SidebarMenuSub>
                </CollapsibleContent>
              </div>
            </Collapsible>

            <SidebarMenuButton v-else as-child :tooltip="item.label" :active="isActive(item.to)">
              <RouterLink :to="item.to" @click="onNavigate">
                <component :is="item.icon" />
                <SidebarMenuLabel>{{ item.label }}</SidebarMenuLabel>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      <SidebarMenu>
        <SidebarMenuItem>
          <NavUser />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  </Sidebar>
</template>

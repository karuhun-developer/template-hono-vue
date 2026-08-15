<script setup lang="ts">
import {
  Avatar,
  AvatarFallback,
  Badge,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  initialsOf,
  SidebarMenuButton,
  SidebarMenuLabel,
  useSidebar,
} from '@app/ui'
import { ChevronsUpDown, LogOut } from '@lucide/vue'
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'

import { LOGIN_PATH } from '@/lib/access'
import { useSessionStore } from '@/stores/session'

/**
 * Who is signed in, and the way out — the row at the bottom of the sidebar.
 *
 * The permission count is shown plainly rather than as decoration. The first question when
 * somebody says "the button isn't on my screen" is whether they are signed in as the
 * account they think they are, and this answers it without a support call.
 */
const router = useRouter()
const session = useSessionStore()
const { isMobile } = useSidebar()

const leaving = ref(false)

const name = computed(() => session.user?.name ?? 'Account')
const email = computed(() => session.user?.email ?? '')

async function signOut(): Promise<void> {
  leaving.value = true
  await session.logout()
  await router.replace({ path: LOGIN_PATH })
  leaving.value = false
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <SidebarMenuButton class="h-12" :tooltip="name">
        <Avatar class="size-8 rounded-lg">
          <AvatarFallback class="rounded-lg">{{ initialsOf(name) }}</AvatarFallback>
        </Avatar>
        <SidebarMenuLabel class="grid text-left leading-tight">
          <span class="truncate text-sm font-medium">{{ name }}</span>
          <span class="text-sidebar-foreground/60 truncate text-xs">{{ email }}</span>
        </SidebarMenuLabel>
        <ChevronsUpDown class="ml-auto size-4 group-data-[state=collapsed]:hidden" />
      </SidebarMenuButton>
    </DropdownMenuTrigger>

    <!--
      Opens upward on a desktop, where it sits at the bottom of a full-height rail, and to
      the side on a phone, where the sheet leaves no room above it.
    -->
    <DropdownMenuContent
      class="w-56"
      :side="isMobile ? 'bottom' : 'right'"
      align="end"
      :side-offset="8"
    >
      <DropdownMenuLabel class="font-normal">
        <span class="block truncate text-sm font-medium">{{ name }}</span>
        <span class="text-muted-foreground block truncate text-xs">{{ email }}</span>
      </DropdownMenuLabel>

      <DropdownMenuSeparator />

      <DropdownMenuItem disabled>
        Permissions
        <Badge variant="secondary" class="ml-auto">{{ session.permissions.length }}</Badge>
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <DropdownMenuItem variant="destructive" :disabled="leaving" @select="signOut">
        <LogOut />
        {{ leaving ? 'Signing out…' : 'Sign out' }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

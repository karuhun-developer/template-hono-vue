<script setup lang="ts">
import {
  Badge,
  Button,
  Separator,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@app/ui'
import { LogOut } from '@lucide/vue'
import { ref } from 'vue'
import { useRouter } from 'vue-router'

import { LOGIN_PATH } from '@/lib/access'
import { useSessionStore } from '@/stores/session'

/**
 * The account panel: who is signed in, and the way out.
 *
 * The permission count is shown plainly rather than as decoration. The first question when
 * somebody says "the button isn't on my screen" is whether they are really signed in as
 * the account they think they are.
 */
const open = defineModel<boolean>('open', { default: false })

const router = useRouter()
const session = useSessionStore()
const leaving = ref(false)

async function signOut(): Promise<void> {
  leaving.value = true
  await session.logout()
  open.value = false
  await router.replace({ path: LOGIN_PATH })
  leaving.value = false
}
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent side="bottom" class="p-6 md:mx-auto md:max-w-md">
      <SheetHeader class="p-0">
        <SheetTitle>{{ session.user?.name ?? 'Account' }}</SheetTitle>
        <SheetDescription>{{ session.user?.email }}</SheetDescription>
      </SheetHeader>

      <div class="space-y-3 text-sm">
        <div class="flex items-center justify-between gap-3">
          <span class="text-muted-foreground">Permissions</span>
          <Badge variant="secondary">{{ session.permissions.length }}</Badge>
        </div>
      </div>

      <Separator />

      <Button variant="outline" class="w-full" :disabled="leaving" @click="signOut">
        <LogOut />
        {{ leaving ? 'Signing out…' : 'Sign out' }}
      </Button>
    </SheetContent>
  </Sheet>
</template>

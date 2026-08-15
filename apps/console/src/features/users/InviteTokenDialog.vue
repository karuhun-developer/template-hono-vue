<script setup lang="ts">
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@app/ui'
import { Check, Copy } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import { formatDateTime } from '@/lib/format'

/**
 * The invitation link, shown **once**.
 *
 * The server keeps only its hash, so this dialog is the single opportunity to copy it.
 * Which is why it cannot be dismissed with Escape or by clicking outside: closing it has to
 * be deliberate, or somebody loses the link to a reflex.
 *
 * Until the template grows an email sender, delivery is manual — chat, phone, in person.
 * Sending it by email is one of the first things a real project adds; the place to do it is
 * `inviteUser()` in `apps/api/src/modules/users/users.service.ts`.
 */

const props = defineProps<{
  open: boolean
  token: string | null
  email: string
  expiresAt: string | null
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

const copied = ref(false)

const link = computed(() =>
  props.token ? `${window.location.origin}/invitation/${props.token}` : '',
)

const expiry = computed(() =>
  props.expiresAt === null ? null : formatDateTime(props.expiresAt, ''),
)

watch(
  () => props.open,
  () => {
    copied.value = false
  },
)

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(link.value)
    copied.value = true
  } catch {
    // The clipboard API needs a secure context (https, or localhost). When it is refused
    // the link is still readable in the text box, so nothing is actually lost.
    copied.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      class="sm:max-w-lg"
      @escape-key-down.prevent
      @pointer-down-outside.prevent
      @interact-outside.prevent
    >
      <DialogHeader>
        <DialogTitle>Invitation for {{ email }}</DialogTitle>
        <DialogDescription>
          Send this link to them. It is shown only once — after this dialog closes, getting a new
          link means re-sending the invitation.
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3">
        <div class="flex gap-2">
          <Input :model-value="link" readonly spellcheck="false" class="font-mono text-xs" />
          <Button type="button" variant="secondary" @click="copy">
            <Check v-if="copied" class="text-primary" />
            <Copy v-else />
            <span class="sr-only">Copy the link</span>
          </Button>
        </div>

        <p v-if="expiry" class="text-muted-foreground text-xs">Valid until {{ expiry }}.</p>
      </div>

      <DialogFooter>
        <Button type="button" @click="emit('update:open', false)">I have copied it</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

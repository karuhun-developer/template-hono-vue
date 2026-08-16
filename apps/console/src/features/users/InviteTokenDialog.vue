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
 * A one-time link, shown **once**.
 *
 * Two kinds go through here — an invitation and a password reset — because they are the
 * same object: a token the server keeps only the hash of, so this dialog is the single
 * opportunity to copy it. Which is also why it cannot be dismissed with Escape or by
 * clicking outside: closing it has to be deliberate, or somebody loses the link to a reflex.
 *
 * `token === null` means the API decided not to hand the link back, because it has been
 * emailed instead. There is then nothing to copy and nothing to lose, so the dialog is only
 * a confirmation of where it went.
 */

const props = defineProps<{
  open: boolean
  kind: 'invite' | 'reset'
  token: string | null
  email: string
  expiresAt: string | null
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

const copied = ref(false)

/**
 * Built from the console's own origin, which is correct here and only here: this dialog
 * runs in the browser of the person who pressed the button. Anything sent by email is
 * addressed from `CONSOLE_URL` on the server, where there is no `window`.
 */
const link = computed(() => {
  if (props.token === null) return ''
  const path = props.kind === 'invite' ? 'invitation' : 'reset-password'
  return `${window.location.origin}/${path}/${props.token}`
})

const expiry = computed(() =>
  props.expiresAt === null ? null : formatDateTime(props.expiresAt, ''),
)

const title = computed(() =>
  props.kind === 'invite' ? `Invitation for ${props.email}` : `Password reset for ${props.email}`,
)

const description = computed(() => {
  if (props.token === null) return `We have emailed the link to ${props.email}.`

  return props.kind === 'invite'
    ? 'Send this link to them. It is shown only once — after this dialog closes, getting a new link means re-sending the invitation.'
    : 'Send this link to them. It is shown only once, and it signs them in as soon as they choose a new password.'
})

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
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ description }}</DialogDescription>
      </DialogHeader>

      <div v-if="token !== null" class="space-y-3">
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
        <Button type="button" @click="emit('update:open', false)">
          {{ token === null ? 'Done' : 'I have copied it' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

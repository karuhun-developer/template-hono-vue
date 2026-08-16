<script setup lang="ts">
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@app/ui'
import { ShieldAlert } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import { fetchMailMessage, type MailMessage } from '@/features/mail/api'
import { formatDateTime } from '@/lib/format'

/**
 * One message, as it was sent.
 *
 * **The HTML goes into a sandboxed `<iframe srcdoc>`, never `v-html`.** The body is
 * attacker-influenced — a user-supplied name lands in an invitation email — and rendering it
 * inside the console's own origin would be stored XSS in the one application whose users
 * hold every permission there is. `sandbox=""` with no tokens means no scripts, no forms, no
 * top-level navigation and an opaque origin: the frame can lay out text and nothing else.
 *
 * The row the list already loaded is what renders, so the dialog never opens empty. It then
 * re-reads `GET /mail-messages/:id`, because a message that was `queued` when the page loaded
 * may have been sent or failed since — and a preview is exactly where somebody looks to find
 * that out.
 */

const props = defineProps<{
  open: boolean
  message: MailMessage | null
}>()

const emit = defineEmits<{ 'update:open': [boolean] }>()

/** The refreshed copy, when it arrives. Falls back to the row while it is in flight. */
const fresh = ref<MailMessage | null>(null)

const view = ref<'html' | 'text'>('html')

const message = computed(() => fresh.value ?? props.message)

const html = computed(() => message.value?.htmlBody ?? '')
const text = computed(() => message.value?.textBody ?? '')

const facts = computed(() => {
  const current = message.value
  if (!current) return []

  return [
    { label: 'From', value: current.fromEmail },
    { label: 'Template', value: current.template },
    { label: 'Driver', value: current.driver },
    { label: 'Attempts', value: String(current.attempts) },
    { label: 'Queued', value: formatDateTime(current.createdAt) },
    { label: 'Sent', value: formatDateTime(current.sentAt) },
  ]
})

/**
 * Refresh on open, and drop the refreshed copy on close so the next message never shows the
 * previous one's body for a frame. A failure is deliberately silent: the row is already on
 * screen and complete, and an error banner over a body that is right would say the wrong
 * thing.
 */
watch(
  () => [props.open, props.message?.id] as const,
  ([open, id]) => {
    fresh.value = null
    view.value = 'html'
    if (!open || id === undefined) return

    void fetchMailMessage(id).then((result) => {
      // Guard against the answer arriving after somebody moved on to another row.
      if ('failure' in result || props.message?.id !== id) return
      fresh.value = result.message
    })
  },
)
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-3xl">
      <template v-if="message">
        <DialogHeader>
          <DialogTitle class="pr-6 break-words">{{ message.subject }}</DialogTitle>
          <DialogDescription>
            To {{ message.toEmail }}
            <template v-if="message.toName"> ({{ message.toName }})</template>
          </DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{{ message.status }}</Badge>
            <Badge v-if="message.providerMessageId" variant="secondary" class="font-mono text-xs">
              {{ message.providerMessageId }}
            </Badge>
          </div>

          <dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3">
            <div v-for="fact in facts" :key="fact.label" class="min-w-0">
              <dt class="text-muted-foreground text-xs">{{ fact.label }}</dt>
              <dd class="truncate">{{ fact.value }}</dd>
            </div>
          </dl>

          <div v-if="message.error" class="space-y-1">
            <p class="text-muted-foreground text-xs">Error</p>
            <pre
              class="border-destructive/30 bg-destructive/10 text-destructive overflow-x-auto rounded-lg border p-3 font-mono text-xs whitespace-pre-wrap"
              >{{ message.error }}</pre>
          </div>

          <!--
            Said out loud rather than left to be discovered: the copy kept here has every
            secret replaced, so the link in it is not the link that was delivered. Somebody
            comparing the two would otherwise reasonably conclude the email went out broken.
          -->
          <p
            class="text-muted-foreground bg-muted flex items-start gap-2 rounded-lg px-3 py-2 text-xs"
          >
            <ShieldAlert class="mt-0.5 size-4 shrink-0" />
            <span>
              This is the stored copy. Invitation and reset links are replaced with
              <code class="font-mono">[redacted]</code> before the message is saved, so the one that
              was delivered is not shown here.
            </span>
          </p>

          <div class="flex gap-1">
            <Button
              :variant="view === 'html' ? 'secondary' : 'ghost'"
              size="sm"
              @click="view = 'html'"
            >
              HTML
            </Button>
            <Button
              :variant="view === 'text' ? 'secondary' : 'ghost'"
              size="sm"
              @click="view = 'text'"
            >
              Plain text
            </Button>
          </div>

          <!--
            `sandbox=""` — every restriction on, no exceptions. Removing this attribute, or
            adding `allow-scripts` to it, hands script execution in the console's origin to
            whoever last typed their name into an invitation form.
          -->
          <iframe
            v-if="view === 'html'"
            :srcdoc="html"
            sandbox=""
            title="Message body"
            class="bg-background h-96 w-full rounded-lg border"
          ></iframe>

          <pre
            v-else
            class="bg-muted h-96 overflow-auto rounded-lg p-3 font-mono text-xs whitespace-pre-wrap"
            >{{ text }}</pre>
        </div>
      </template>
    </DialogContent>
  </Dialog>
</template>

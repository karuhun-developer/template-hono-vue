<script setup lang="ts">
import { ref } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import type { MailMessage } from '@/features/mail/api'
import MailPreviewDialog from '@/features/mail/MailPreviewDialog.vue'
import MailTable from '@/features/mail/MailTable.vue'
import { useMailList } from '@/features/mail/useMailList'

/**
 * Every message this application has sent.
 *
 * Read-only, and owner-only: what is listed here is other people's mail, and the ability to
 * read it is a stricter bar than the rest of the Operations group. There is no resend and no
 * delete — the API offers neither, for reasons its routes state.
 *
 * The page is the wiring: the list state is `useMailList`, the table is
 * `features/mail/MailTable.vue`, and the preview is a dialog rather than a route because it
 * is a detour from the list.
 */

const list = useMailList()

const previewOpen = ref(false)
const selected = ref<MailMessage | null>(null)

function preview(message: MailMessage): void {
  selected.value = message
  previewOpen.value = true
}
</script>

<template>
  <div class="space-y-5">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Mail log</h2>
      <p class="text-muted-foreground text-sm">
        What was sent, to whom, and whether it arrived — the record the outbox keeps of every
        message.
      </p>
    </div>

    <FailureAlert :failure="list.failure.value" />

    <MailTable :list="list" @preview="preview" />

    <MailPreviewDialog v-model:open="previewOpen" :message="selected" />
  </div>
</template>

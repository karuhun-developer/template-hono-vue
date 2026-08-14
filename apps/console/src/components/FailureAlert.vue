<script setup lang="ts">
import { computed } from 'vue'

import type { ApiFailure } from '@/lib/api-error'

/**
 * One rendering for every API failure.
 *
 * `details.permissions` is shown when it is there, and that is deliberate: a 403 from the
 * roles and users modules almost always means "you cannot hand out access you do not hold
 * yourself" — a sentence that is useless without saying *which* permissions. Without the
 * list, the only way to find out is to untick boxes one at a time.
 */
const props = defineProps<{ failure: ApiFailure | null }>()

const permissions = computed<string[]>(() => {
  const details = props.failure?.details
  if (typeof details !== 'object' || details === null) return []

  const value = (details as { permissions?: unknown }).permissions
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
})
</script>

<template>
  <div
    v-if="failure"
    role="alert"
    class="border-destructive/30 bg-destructive/10 text-destructive space-y-1 rounded-lg border px-3 py-2 text-sm"
  >
    <p>{{ failure.message }}</p>
    <p v-if="permissions.length > 0" class="font-mono text-xs opacity-80">
      {{ permissions.join(', ') }}
    </p>
  </div>
</template>

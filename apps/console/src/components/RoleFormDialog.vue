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
  Label,
  Textarea,
} from '@app/ui'
import { LoaderCircle } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import PermissionMatrix from '@/components/PermissionMatrix.vue'
import { beyondReach } from '@/lib/access'
import { api } from '@/lib/api'
import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'
import type { PermissionCatalog, RoleSummary } from '@/lib/models'

/**
 * Create and edit a role.
 *
 * The role's `key` appears nowhere in this form: it is derived from the name when the role
 * is created and never changes afterwards, so code may rely on it (`owner`, `admin`) while
 * the display name stays free to be rewritten.
 */

const props = defineProps<{
  open: boolean
  role: RoleSummary | null
  catalog: PermissionCatalog
}>()

const emit = defineEmits<{ 'update:open': [boolean]; saved: [] }>()

const mode = computed<'create' | 'edit'>(() => (props.role === null ? 'create' : 'edit'))

const name = ref('')
const description = ref('')
const permissions = ref<string[]>([])
const submitting = ref(false)
const failure = ref<ApiFailure | null>(null)

/**
 * A role carrying permissions the caller does not hold cannot have its permissions edited
 * at all — see the note at the top of `PermissionMatrix.vue`.
 */
const locked = computed(
  () =>
    props.role !== null && beyondReach(props.role.permissions, props.catalog.granted).length > 0,
)

watch(
  () => props.open,
  (open) => {
    if (!open) return

    failure.value = null
    submitting.value = false

    const role = props.role
    name.value = role?.name ?? ''
    description.value = role?.description ?? ''
    permissions.value = [...(role?.permissions ?? [])]
  },
  { immediate: true },
)

async function submit(): Promise<void> {
  if (submitting.value) return

  if (!locked.value && permissions.value.length === 0) {
    failure.value = {
      code: 'validation_failed',
      message: 'Pick at least one permission — an empty role opens nothing.',
      status: 0,
    }
    return
  }

  submitting.value = true
  failure.value = null

  try {
    const response = await (props.role === null ? create() : update(props.role.id))
    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    emit('saved')
    emit('update:open', false)
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    submitting.value = false
  }
}

function create(): Promise<Response> {
  return api.roles.$post({
    json: {
      name: name.value.trim(),
      description: description.value.trim(),
      permissions: permissions.value,
    },
  })
}

function update(id: string): Promise<Response> {
  return api.roles[':id'].$patch({
    param: { id },
    json: {
      name: name.value.trim(),
      description: description.value.trim(),
      // Locked matrix → `permissions` is deliberately left out of the payload. Sending it
      // back unchanged would still be refused: a permission the caller does not hold counts
      // as a grant, not as a copy.
      ...(locked.value ? {} : { permissions: permissions.value }),
    },
  })
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ mode === 'create' ? 'New role' : 'Edit role' }}</DialogTitle>
        <DialogDescription>
          A role is a set of permissions. What somebody can do is the union of the roles they hold.
        </DialogDescription>
      </DialogHeader>

      <form class="space-y-4" novalidate @submit.prevent="submit">
        <div class="space-y-2">
          <Label for="role-name">Name</Label>
          <Input id="role-name" v-model="name" placeholder="Support agent" required />
        </div>

        <div class="space-y-2">
          <Label for="role-description">Description</Label>
          <Textarea
            id="role-description"
            v-model="description"
            rows="2"
            placeholder="Optional — read by whoever assigns this role."
          />
        </div>

        <PermissionMatrix
          v-model="permissions"
          :catalog="catalog"
          :locked="locked"
          :disabled="submitting"
        />

        <FailureAlert :failure="failure" />

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            :disabled="submitting"
            @click="emit('update:open', false)"
          >
            Cancel
          </Button>
          <Button type="submit" :disabled="submitting">
            <LoaderCircle v-if="submitting" class="animate-spin" />
            Save
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

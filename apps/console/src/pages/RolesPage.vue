<script setup lang="ts">
import { Badge, Button, Card, CardContent, Skeleton } from '@app/ui'
import { Pencil, Plus, Trash2 } from '@lucide/vue'
import { computed, onMounted, ref } from 'vue'

import FailureAlert from '@/components/FailureAlert.vue'
import RoleFormDialog from '@/components/RoleFormDialog.vue'
import { api } from '@/lib/api'
import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'
import type { PermissionCatalog, RoleSummary } from '@/lib/models'
import { useSessionStore } from '@/stores/session'

/**
 * The roles this application has.
 *
 * Built-in roles (`isSystem`) can be edited but not deleted, and neither can a role someone
 * still holds. Both refusals are deliberate: deleting a role takes access away from
 * everybody holding it, and that should never happen as a side effect of tidying up a list.
 */

const session = useSessionStore()

const roles = ref<RoleSummary[]>([])
const catalog = ref<PermissionCatalog>({ groups: [], granted: [] })
const loading = ref(true)
const failure = ref<ApiFailure | null>(null)

const formOpen = ref(false)
const editing = ref<RoleSummary | null>(null)

const canManage = computed(() => session.can('role.manage'))

onMounted(async () => {
  await load()
})

async function load(): Promise<void> {
  loading.value = true
  failure.value = null

  try {
    const [list, permissions] = await Promise.all([
      api.roles.$get({ query: { perPage: '100' } }),
      api.roles.permissions.$get(),
    ])

    if (!list.ok) {
      failure.value = await readApiError(list)
      return
    }
    if (!permissions.ok) {
      failure.value = await readApiError(permissions)
      return
    }

    roles.value = (await list.json()).items
    catalog.value = await permissions.json()
  } catch (error) {
    failure.value = networkFailure(error)
  } finally {
    loading.value = false
  }
}

function openCreate(): void {
  editing.value = null
  formOpen.value = true
}

function openEdit(role: RoleSummary): void {
  editing.value = role
  formOpen.value = true
}

async function remove(role: RoleSummary): Promise<void> {
  if (!window.confirm(`Delete the role "${role.name}"? This cannot be undone.`)) return

  failure.value = null

  try {
    const response = await api.roles[':id'].$delete({ param: { id: role.id } })
    if (!response.ok) {
      failure.value = await readApiError(response)
      return
    }

    await load()
  } catch (error) {
    failure.value = networkFailure(error)
  }
}
</script>

<template>
  <div class="mx-auto w-full max-w-3xl space-y-4">
    <div class="flex items-start justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">Roles</h1>
        <p class="text-muted-foreground text-sm">
          Sets of permissions. What somebody can do is the union of the roles they hold.
        </p>
      </div>

      <Button v-if="canManage" @click="openCreate">
        <Plus />
        <span class="hidden sm:inline">New role</span>
      </Button>
    </div>

    <FailureAlert :failure="failure" />

    <div v-if="loading" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-24 w-full rounded-2xl" />
    </div>

    <Card v-for="role in roles" v-else :key="role.id">
      <CardContent class="space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <p class="truncate font-medium">{{ role.name }}</p>
            <p class="text-muted-foreground font-mono text-xs">{{ role.key }}</p>
          </div>
          <Badge v-if="role.isSystem" variant="secondary">Built-in</Badge>
        </div>

        <p v-if="role.description" class="text-muted-foreground text-sm">{{ role.description }}</p>

        <div class="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span>{{ role.permissions.length }} permissions</span>
          <span>held by {{ role.usedBy }}</span>
        </div>

        <div v-if="canManage" class="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" @click="openEdit(role)">
            <Pencil />
            Edit
          </Button>

          <!--
            The delete button is hidden rather than disabled for a built-in role or one
            still in use. A dead button that does not explain itself only invites people to
            click it again.
          -->
          <Button
            v-if="!role.isSystem && role.usedBy === 0"
            variant="ghost"
            size="sm"
            @click="remove(role)"
          >
            <Trash2 />
            Delete
          </Button>
        </div>
      </CardContent>
    </Card>

    <RoleFormDialog v-model:open="formOpen" :role="editing" :catalog="catalog" @saved="load" />
  </div>
</template>

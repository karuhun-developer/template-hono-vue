<script setup lang="ts">
import { Badge, Checkbox, Label } from '@app/ui'

import type { RoleSummary } from '@/lib/models'

/**
 * Which roles a person holds.
 *
 * A plain checkbox list, because a single-tenant application has nothing else to say about
 * an assignment: a role either applies to somebody or it does not. The moment you add a
 * dimension — a branch, a team, a project — this is the component that grows a second
 * column, and `user_roles` grows the matching column with it. That is walked through in
 * `docs/guides/add-multi-tenancy.md`.
 *
 * The list is sent whole on every save. The API stores roles delete-then-write, so sending
 * a subset is how somebody loses access they were supposed to keep.
 */

defineProps<{
  roles: readonly RoleSummary[]
  disabled?: boolean
}>()

const model = defineModel<string[]>({ required: true })

function toggle(roleId: string, checked: boolean): void {
  model.value = checked
    ? [...new Set([...model.value, roleId])]
    : model.value.filter((id) => id !== roleId)
}
</script>

<template>
  <div class="space-y-3">
    <Label>Roles</Label>

    <p v-if="roles.length === 0" class="text-muted-foreground text-sm">
      No roles are visible to you, so you cannot set them here. Viewing them needs
      <span class="font-mono text-xs">role.read</span>.
    </p>

    <div class="border-border divide-border divide-y rounded-xl border">
      <div v-for="role in roles" :key="role.id" class="flex items-start gap-3 p-3">
        <Checkbox
          :id="`role-${role.id}`"
          :model-value="model.includes(role.id)"
          :disabled="disabled"
          class="mt-0.5"
          @update:model-value="toggle(role.id, $event === true)"
        />
        <div class="min-w-0 flex-1">
          <Label :for="`role-${role.id}`" class="flex items-center gap-2 font-normal">
            <span class="truncate">{{ role.name }}</span>
            <Badge v-if="role.isSystem" variant="secondary">Built-in</Badge>
          </Label>
          <p class="text-muted-foreground text-xs">
            {{ role.description ?? `${role.permissions.length} permissions` }}
          </p>
        </div>
      </div>
    </div>

    <!--
      The API refuses a role carrying permissions the caller does not hold, and says which
      ones. That answer is not predicted here: the check needs the caller's own permission
      list, and two places computing the same rule disagree sooner or later.
    -->
    <p class="text-muted-foreground text-xs">
      An account with no role can sign in but cannot open anything.
    </p>
  </div>
</template>

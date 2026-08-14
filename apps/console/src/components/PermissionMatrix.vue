<script setup lang="ts">
import { Badge, Button, Checkbox, Label } from '@app/ui'
import { computed } from 'vue'

import type { PermissionCatalog } from '@/lib/models'

/**
 * The permission matrix, grouped by domain.
 *
 * One rule is what makes this more than a list of checkboxes: **nobody can hand out a
 * permission they do not hold themselves.** Permissions outside `catalog.granted` are still
 * rendered — hiding them makes people believe a role is smaller than it is — but their
 * ticks are disabled and marked.
 *
 * If the role being edited *already* holds such a permission, the whole matrix is locked
 * through the `locked` prop. That is not a display choice: the API refuses both directions
 * at once, granting (`assertGrantable`) and silently stripping (`removedBeyondReach`), so
 * the only save that can succeed is one that leaves the permissions alone.
 */

const props = defineProps<{
  catalog: PermissionCatalog
  /** Read-only matrix — the caller does not hold everything this role carries. */
  locked?: boolean
  disabled?: boolean
}>()

const model = defineModel<string[]>({ required: true })

const granted = computed(() => new Set<string>(props.catalog.granted))

function isGranted(key: string): boolean {
  return granted.value.has(key)
}

function toggle(key: string, checked: boolean): void {
  model.value = checked ? [...new Set([...model.value, key])] : model.value.filter((k) => k !== key)
}

/** Tick or clear a whole group at once — touching only what the caller may hand out. */
function toggleGroup(keys: readonly string[], checked: boolean): void {
  const allowed = keys.filter(isGranted)
  model.value = checked
    ? [...new Set([...model.value, ...allowed])]
    : model.value.filter((key) => !allowed.includes(key))
}

function countChecked(keys: readonly string[]): number {
  return keys.filter((key) => model.value.includes(key)).length
}
</script>

<template>
  <div class="space-y-4">
    <p
      v-if="locked"
      class="border-warning/30 bg-warning/10 rounded-lg border px-3 py-2 text-xs"
      role="note"
    >
      This role holds permissions you do not have, so its permission list cannot be changed here.
      The name and description still can. Ask someone with full access if the permissions need to
      move.
    </p>

    <div v-for="group in catalog.groups" :key="group.key" class="border-border rounded-xl border">
      <div class="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium capitalize">{{ group.key }}</span>
          <Badge variant="secondary">
            {{ countChecked(group.permissions.map((p) => p.key)) }}/{{ group.permissions.length }}
          </Badge>
        </div>

        <Button
          v-if="!locked"
          type="button"
          variant="ghost"
          size="sm"
          :disabled="disabled"
          @click="
            toggleGroup(
              group.permissions.map((p) => p.key),
              countChecked(group.permissions.map((p) => p.key)) === 0,
            )
          "
        >
          {{ countChecked(group.permissions.map((p) => p.key)) === 0 ? 'Select all' : 'Clear' }}
        </Button>
      </div>

      <div class="space-y-3 p-3">
        <div
          v-for="permission in group.permissions"
          :key="permission.key"
          class="flex items-start gap-3"
        >
          <Checkbox
            :id="`perm-${permission.key}`"
            :model-value="model.includes(permission.key)"
            :disabled="disabled || locked || !isGranted(permission.key)"
            class="mt-0.5"
            @update:model-value="toggle(permission.key, $event === true)"
          />
          <div class="min-w-0 flex-1">
            <Label :for="`perm-${permission.key}`" class="block text-sm leading-tight font-normal">
              {{ permission.label }}
            </Label>
            <p class="text-muted-foreground font-mono text-[11px]">
              {{ permission.key }}
              <span v-if="!isGranted(permission.key)"> · you do not hold this</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

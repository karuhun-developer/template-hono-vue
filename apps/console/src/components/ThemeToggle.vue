<script setup lang="ts">
import { Monitor, Moon, Sun } from '@lucide/vue'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@app/ui'

import { setTheme, useTheme, type Theme } from '@/composables/useTheme'

/**
 * Three choices rather than a two-way switch.
 *
 * "System" has to be reachable: someone whose machine flips to dark at sunset wants the
 * console to follow, and a toggle that only knows light and dark takes that away the first
 * time it is touched — with no way back short of clearing site data.
 */
const { theme, resolved } = useTheme()

const OPTIONS: readonly { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
]
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon-sm" aria-label="Change theme">
        <Sun v-if="resolved === 'light'" />
        <Moon v-else />
      </Button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="w-36">
      <DropdownMenuItem
        v-for="option in OPTIONS"
        :key="option.value"
        :class="option.value === theme && 'bg-accent text-accent-foreground'"
        @select="setTheme(option.value)"
      >
        <component :is="option.icon" />
        {{ option.label }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

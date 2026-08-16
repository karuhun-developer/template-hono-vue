<script setup lang="ts">
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Skeleton,
} from '@app/ui'
import { onMounted, ref } from 'vue'

import { api } from '@/lib/api'

/**
 * API status card. It exists to prove the typed client really reaches the server — and it
 * earns its place afterwards: when somebody says "the app is slow", the first question is
 * whether the API is answering at all.
 *
 * It also doubles as the smallest possible example of calling `api` from a component.
 */
const apiUrl = import.meta.env.VITE_API_URL

type ProbeState =
  { kind: 'loading' } | { kind: 'up'; detail: string } | { kind: 'down'; detail: string }

const liveness = ref<ProbeState>({ kind: 'loading' })
const readiness = ref<ProbeState>({ kind: 'loading' })

async function checkLiveness(): Promise<void> {
  liveness.value = { kind: 'loading' }
  try {
    const response = await api.health.$get()
    const body = await response.json()
    liveness.value = {
      kind: 'up',
      detail: `${body.app} · ${body.env} · up for ${body.uptimeSeconds}s`,
    }
  } catch (error) {
    liveness.value = {
      kind: 'down',
      detail: error instanceof Error ? error.message : 'The API could not be reached.',
    }
  }
}

async function checkReadiness(): Promise<void> {
  readiness.value = { kind: 'loading' }
  try {
    const response = await api.health.ready.$get()
    const body = await response.json()
    // `response.ok` is deliberately ignored: a 503 here is a valid answer ("alive but not
    // able to serve"), not a failed request.
    //
    // Read out of `checks` rather than naming them, so a check added to the route shows up
    // here without a second edit — and, more to the point, a check that starts failing is
    // never silently left out of the sentence.
    const failed = Object.entries(body.checks)
      .filter(([, ok]) => !ok)
      .map(([name]) => name)

    readiness.value =
      failed.length === 0
        ? { kind: 'up', detail: `${Object.keys(body.checks).join(' · ')} answered` }
        : { kind: 'down', detail: `${failed.join(' · ')} did not answer` }
  } catch (error) {
    readiness.value = {
      kind: 'down',
      detail: error instanceof Error ? error.message : 'The API could not be reached.',
    }
  }
}

function refresh(): void {
  void checkLiveness()
  void checkReadiness()
}

onMounted(refresh)
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>API status</CardTitle>
      <CardDescription>{{ apiUrl }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <div class="space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium">Liveness · /health</span>
          <Badge v-if="liveness.kind === 'up'" variant="success">ok</Badge>
          <Badge v-else-if="liveness.kind === 'down'" variant="destructive">down</Badge>
        </div>
        <Skeleton v-if="liveness.kind === 'loading'" class="h-4 w-52" />
        <p v-else class="text-muted-foreground text-sm">{{ liveness.detail }}</p>
      </div>

      <Separator />

      <div class="space-y-1">
        <div class="flex items-center justify-between gap-2">
          <span class="text-sm font-medium">Readiness · /health/ready</span>
          <Badge v-if="readiness.kind === 'up'" variant="success">ready</Badge>
          <Badge v-else-if="readiness.kind === 'down'" variant="warning">degraded</Badge>
        </div>
        <Skeleton v-if="readiness.kind === 'loading'" class="h-4 w-52" />
        <p v-else class="text-muted-foreground text-sm">{{ readiness.detail }}</p>
      </div>

      <Button variant="outline" class="w-full" @click="refresh">Check again</Button>
    </CardContent>
  </Card>
</template>

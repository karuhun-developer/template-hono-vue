<script setup lang="ts">
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@app/ui'
import { Compass } from '@lucide/vue'
import { useRoute, useRouter } from 'vue-router'

/**
 * A page rather than a redirect home.
 *
 * A redirect makes a typo in the address bar look like the application deciding to go
 * somewhere else on its own, and it hides broken links instead of reporting them.
 */
const route = useRoute()
const router = useRouter()
</script>

<template>
  <div class="bg-muted/40 flex min-h-dvh items-center justify-center px-4 py-10">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <Compass class="text-muted-foreground size-6" />
        <CardTitle>Page not found</CardTitle>
        <CardDescription>
          Nothing lives at <code>{{ route.fullPath }}</code
          >.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button class="w-full" @click="router.replace('/')">Back to the overview</Button>
      </CardContent>
    </Card>
  </div>
</template>

import type { PermissionKey } from '@app/contract'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { hasPermission } from '@/lib/access'
import { api } from '@/lib/api'
import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'

/**
 * The console's session: who is signed in and what they are allowed to do.
 *
 * `GET /auth/me` is the single source of truth. The console stores **nothing** about
 * identity in `localStorage` — the session token itself lives in an `httpOnly` cookie that
 * JavaScript cannot read, and copying permissions into local storage only creates a stale
 * copy that keeps saying "allowed" after access has been revoked.
 */

type Me = Awaited<ReturnType<Awaited<ReturnType<typeof api.auth.me.$get>>['json']>>

export type SessionStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous'

export const useSessionStore = defineStore('session', () => {
  const status = ref<SessionStatus>('idle')
  const me = ref<Me | null>(null)

  const user = computed(() => me.value?.user ?? null)
  // Typed by the API, not by hand: `permissions` here *is* `PermissionKey[]`, because
  // `AppType` carries the return type of `allPermissions()` all the way across.
  const permissions = computed<readonly PermissionKey[]>(() => me.value?.permissions ?? [])
  const isAuthenticated = computed(() => status.value === 'authenticated')

  function can(permission: PermissionKey | undefined): boolean {
    return hasPermission(permissions.value, permission)
  }

  /**
   * Called once at boot, and again whenever the route guard needs certainty.
   *
   * A 401 here is **not** a failure — it is the correct answer to "am I still signed in?".
   * The only thing treated as a failure is a network error, and even that ends as
   * `anonymous` so the console does not hang on an empty screen; the sign-in page will
   * show the message.
   */
  let inflight: Promise<void> | null = null

  async function bootstrap(): Promise<void> {
    // The route guard and the components can both ask for this while booting. Without
    // this holder, the second request would see the `loading` status and conclude "not
    // signed in" — throwing the user at the sign-in page with a perfectly good session.
    inflight ??= fetchMe().finally(() => {
      inflight = null
    })

    return inflight
  }

  async function fetchMe(): Promise<void> {
    status.value = 'loading'

    try {
      const response = await api.auth.me.$get()
      if (!response.ok) {
        me.value = null
        status.value = 'anonymous'
        return
      }

      me.value = await response.json()
      status.value = 'authenticated'
    } catch {
      me.value = null
      status.value = 'anonymous'
    }
  }

  async function login(input: { email: string; password: string }): Promise<ApiFailure | null> {
    try {
      const response = await api.auth.login.$post({ json: input })
      if (!response.ok) return await readApiError(response)

      // The login body is deliberately not used: `/auth/me` is what answers with the
      // permissions, so the shell is never rendered from half the information.
      await bootstrap()
      return null
    } catch (error) {
      return networkFailure(error)
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.auth.logout.$post()
    } finally {
      // Whatever the server answered, the client side has to be clean. A screen still
      // showing the name of somebody who just pressed "Sign out" is a frightening bug.
      me.value = null
      status.value = 'anonymous'
    }
  }

  /** Used by the route guard: make the status certain before deciding anything. */
  async function ensureReady(): Promise<void> {
    if (status.value === 'idle' || status.value === 'loading') await bootstrap()
  }

  return {
    status,
    me,
    user,
    permissions,
    isAuthenticated,
    can,
    bootstrap,
    ensureReady,
    login,
    logout,
  }
})

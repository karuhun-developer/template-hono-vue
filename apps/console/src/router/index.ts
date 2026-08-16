import type { PermissionKey } from '@app/contract'
import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

import { decideNavigation, FORBIDDEN_PATH, LOGIN_PATH } from '@/lib/access'
import { useSessionStore } from '@/stores/session'

declare module 'vue-router' {
  interface RouteMeta {
    /** The default is **signed in required**; only the sign-in, invitation and error pages are public. */
    public?: boolean
    permission?: PermissionKey
    title?: string
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: LOGIN_PATH,
    name: 'login',
    component: () => import('@/pages/LoginPage.vue'),
    meta: { public: true, title: 'Sign in' },
  },
  {
    /**
     * Public on purpose: the people who open it are precisely the ones without an active
     * account. The capability is the token in the URL, not a session.
     */
    path: '/invitation/:token',
    name: 'accept-invitation',
    component: () => import('@/pages/AcceptInvitePage.vue'),
    meta: { public: true, title: 'Accept your invitation' },
  },
  {
    /** Public for the same reason, and it deliberately tells nobody whether an address exists. */
    path: '/forgot-password',
    name: 'forgot-password',
    component: () => import('@/pages/ForgotPasswordPage.vue'),
    meta: { public: true, title: 'Forgot your password' },
  },
  {
    path: '/reset-password/:token',
    name: 'reset-password',
    component: () => import('@/pages/ResetPasswordPage.vue'),
    meta: { public: true, title: 'Set a new password' },
  },
  {
    path: FORBIDDEN_PATH,
    name: 'forbidden',
    component: () => import('@/pages/ForbiddenPage.vue'),
    meta: { public: true, title: 'Access denied' },
  },
  {
    path: '/',
    component: () => import('@/layouts/AppShell.vue'),
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('@/pages/DashboardPage.vue'),
        meta: { title: 'Overview' },
      },
      {
        /**
         * `meta.permission` is the same key the API's `requirePermission()` asks for on the
         * matching endpoint. Keeping them equal is what stops a menu item from leading
         * straight to a page full of 403s — it is not what makes the page safe.
         */
        path: 'users',
        name: 'users',
        component: () => import('@/pages/UsersPage.vue'),
        meta: { title: 'Users', permission: 'user.read' },
      },
      {
        path: 'roles',
        name: 'roles',
        component: () => import('@/pages/RolesPage.vue'),
        meta: { title: 'Roles', permission: 'role.read' },
      },
      {
        path: 'jobs',
        name: 'jobs',
        component: () => import('@/pages/JobsPage.vue'),
        meta: { title: 'Jobs', permission: 'job.read' },
      },
      {
        path: 'audit-log',
        name: 'audit-log',
        component: () => import('@/pages/AuditLogPage.vue'),
        meta: { title: 'Audit log', permission: 'audit.read' },
      },
    ],
  },
  {
    /**
     * A 404 page rather than a redirect home. A redirect makes a typo in the address bar
     * look like the application deciding to go somewhere else, and it hides broken links
     * instead of reporting them.
     */
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/pages/NotFoundPage.vue'),
    meta: { public: true, title: 'Not found' },
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

/**
 * One guard for the whole console.
 *
 * `ensureReady()` holds the first navigation until `GET /auth/me` has answered. The
 * alternative — render first, then bounce to the sign-in page once the answer arrives —
 * makes every page reload flicker: shell, gone, sign-in form. Waiting one request is more
 * honest.
 *
 * The decision itself lives in `lib/access.ts` so it can be tested without a router.
 */
router.beforeEach(async (to) => {
  const session = useSessionStore()
  await session.ensureReady()

  const decision = decideNavigation(
    { authenticated: session.isAuthenticated, permissions: session.permissions },
    { requiresAuth: to.meta.public !== true, permission: to.meta.permission },
    to.fullPath,
  )

  switch (decision.kind) {
    case 'allow':
      return true
    case 'login':
      return { path: LOGIN_PATH, query: { next: decision.next } }
    case 'forbidden':
      return { path: FORBIDDEN_PATH, query: { from: to.fullPath } }
    case 'home':
      return { path: '/' }
  }
})

router.afterEach((to) => {
  document.title = to.meta.title ? `${to.meta.title} · Console` : 'Console'
})

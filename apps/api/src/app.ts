import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { secureHeaders } from 'hono/secure-headers'

import { env } from '#env'
import { errorHandler, notFoundHandler } from '#middleware/error'
import { requestContext, type AppBindings } from '#middleware/request-context'
import { sessionContext } from '#middleware/session'
import { auditRoutes } from '#modules/audit/audit.routes'
import { authRoutes } from '#modules/auth/auth.routes'
import { healthRoutes } from '#modules/health/health.routes'
import { roleRoutes } from '#modules/roles/roles.routes'
import { userRoutes } from '#modules/users/users.routes'

/**
 * Route composition. This file is the **type contract** between the backend and every
 * frontend: `AppType` at the bottom is consumed through `hc<AppType>()`, so renaming a
 * route turns into a TypeScript error in the frontends — no codegen, no types written
 * twice.
 *
 * Which is why routes **must** be chained (`.route(...).route(...)`) rather than mounted
 * through separate `app.route()` statements. The chain is what carries the types; break it
 * and `AppType` silently loses the routes, with no error anywhere until a frontend call
 * stops being type-checked.
 */
const base = new Hono<AppBindings>()

base.use('*', requestContext())
base.use('*', secureHeaders())
base.use(
  '*',
  cors({
    // One parsed list from the environment, so adding a frontend is a `.env` edit rather
    // than a change in here. See docs/guides/add-frontend-app.md.
    origin: [...env.CORS_ORIGINS],
    // The session cookie travels cross-origin in development: the Vue apps are on their
    // own ports, the API is on :7300, and different ports are different origins.
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id'],
    maxAge: 600,
  }),
)

// Mounted globally and deliberately permissive: it reads the cookie if there is one and
// says nothing if there is not. Health checks and invitation links carry no session, and
// both have to keep working.
base.use('*', sessionContext())

base.onError(errorHandler)
base.notFound(notFoundHandler)

export const app = base
  .route('/health', healthRoutes)
  .route('/auth', authRoutes)
  .route('/users', userRoutes)
  .route('/roles', roleRoutes)
  .route('/audit-logs', auditRoutes)

export type AppType = typeof app

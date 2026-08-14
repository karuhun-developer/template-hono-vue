import { eq, sql } from 'drizzle-orm'

import { closeDatabase, db } from '#db/client'
import { roles, userRoles, users } from '#db/schema'
import { env, isProduction } from '#env'
import { logger } from '#lib/logger'
import { hashPassword } from '#lib/password'
import { provisionSystemRoles, syncPermissionCatalog } from '#modules/rbac/rbac.service'

/**
 * The development seed. **Idempotent**: running it twice produces exactly the same state,
 * so there is never a reason to drop the database just to pick up a new sample row.
 *
 * It does two different jobs, and it is worth knowing which is which when you deploy:
 *
 * - `syncPermissionCatalog()` and `provisionSystemRoles()` are **provisioning**. Every
 *   installation needs them, including production, and a first-run bootstrap should call
 *   the same two functions — see `src/modules/rbac/rbac.service.ts`.
 * - The demo accounts below are **sample data**. They exist so a fresh clone can be logged
 *   into, and the whole script refuses to run with `NODE_ENV=production` because of them.
 */

/**
 * The demo administrator.
 *
 * There are two seeded accounts rather than one on purpose. `admin` deliberately holds
 * neither `user.disable` nor `audit.read`, which is what makes the grantable rule visible
 * the first time you sign in as one: those two ticks render disabled, and opening the
 * Owner role gives a locked matrix. See docs/features/rbac.md.
 */
const DEMO_ADMIN = {
  email: 'admin@example.com',
  name: 'Demo Administrator',
  role: 'admin',
} as const

async function seedPermissions(): Promise<void> {
  const result = await syncPermissionCatalog(db)
  logger.info({ total: result.total }, 'permission catalog synchronised')

  if (result.orphaned.length > 0) {
    logger.warn(
      { keys: result.orphaned },
      'the database holds permissions that are no longer in the code catalog — remove them in a migration if that was intended',
    )
  }
}

async function seedRoles(): Promise<void> {
  const { created } = await provisionSystemRoles(db)
  logger.info({ created }, 'system roles provisioned')
}

/**
 * Create an account if it is missing, and give it its role.
 *
 * An account that already exists is **left completely alone** — the password included.
 * Overwriting it would silently undo any password changed while trying out the invitation
 * flow, every single `make seed`.
 */
async function seedUser(
  email: string,
  name: string,
  roleKey: string,
  passwordHash: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1)

  const userId =
    existing?.id ??
    (
      await db
        .insert(users)
        .values({ email, name, passwordHash, status: 'active' })
        .returning({ id: users.id })
    )[0]?.id

  if (!userId) throw new Error(`could not create the seed user ${email}`)

  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.key, roleKey))
    .limit(1)
  if (!role) throw new Error(`the "${roleKey}" role is missing — provisioning must run first`)

  await db.insert(userRoles).values({ userId, roleId: role.id }).onConflictDoNothing()

  logger.info({ email, role: roleKey, created: !existing }, 'seed user ready')
}

async function seedDemoUsers(): Promise<void> {
  const passwordHash = await hashPassword(env.SEED_OWNER_PASSWORD)

  await seedUser(env.SEED_OWNER_EMAIL, env.SEED_OWNER_NAME, 'owner', passwordHash)
  await seedUser(DEMO_ADMIN.email, DEMO_ADMIN.name, DEMO_ADMIN.role, passwordHash)

  logger.info(
    { emails: [env.SEED_OWNER_EMAIL, DEMO_ADMIN.email], password: env.SEED_OWNER_PASSWORD },
    'sign in to the console with either account',
  )
}

if (isProduction) {
  // The seed installs accounts whose password is sitting in an env file. One `make seed`
  // pointed at the wrong DATABASE_URL is all it takes to open a door into real data.
  logger.error('the seed refuses to run with NODE_ENV=production')
  process.exit(1)
}

try {
  await seedPermissions()
  await seedRoles()
  await seedDemoUsers()
  logger.info('seed complete')
} catch (err) {
  logger.error({ err }, 'seed failed')
  process.exitCode = 1
} finally {
  await closeDatabase()
}

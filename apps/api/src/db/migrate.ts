import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { closeDatabase, db } from '#db/client'
import { logger } from '#lib/logger'

/**
 * Run the migrations and exit. Called by `make migrate`, by `pnpm --filter @app/api
 * migrate`, and by a container entrypoint before the server starts.
 *
 * Drizzle records which migrations have run in `drizzle.__drizzle_migrations`, so this is
 * idempotent — safe to run on every deploy.
 */
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

async function main(): Promise<void> {
  logger.info({ migrationsFolder }, 'running migrations')
  await migrate(db, { migrationsFolder })
  logger.info('migrations complete')
}

try {
  await main()
} catch (err) {
  logger.error({ err }, 'migrations failed')
  process.exitCode = 1
} finally {
  await closeDatabase()
}

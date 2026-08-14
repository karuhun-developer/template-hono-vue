import { fileURLToPath } from 'node:url'

import { migrate } from 'drizzle-orm/node-postgres/migrator'

import { closeDatabase, db } from '#db/client'
import { env } from '#env'

/**
 * Vitest `globalSetup`: bring the test database up to the latest schema before a single
 * test runs.
 *
 * If the database is not there, the suite **fails loudly** instead of skipping. A green
 * run that never actually ran is more dangerous than a red one — it is trusted.
 */
export async function setup(): Promise<void> {
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

  try {
    await migrate(db, { migrationsFolder })
  } catch (err) {
    throw new Error(
      `Could not prepare the test database (${env.DATABASE_URL}).\n\n` +
        `Start the stack first:\n` +
        `  make up\n\n` +
        `If the database itself is missing — it is created by\n` +
        `docker/postgres/init/01-databases.sql, which only runs on a fresh volume:\n` +
        `  docker compose exec postgres createdb -U app app_test\n\n` +
        `Original cause: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    )
  } finally {
    await closeDatabase()
  }
}

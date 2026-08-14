import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import pg from 'pg'

import * as schema from '#db/schema'
import { env, isProduction } from '#env'
import { logger } from '#lib/logger'

/**
 * One pool for the whole process.
 *
 * The easily-missed part: `pg` parses `bigint` as a **string** by default, because not
 * every bigint fits in a `number`. That default is right in general and wrong for us —
 * `count(*)` comes back as int8, so without the parser below a total in a paginated
 * response arrives as `"42"` and ends up in JSON that way.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    // Better a loud failure than a number that has silently lost precision.
    throw new Error(`bigint ${value} is outside the safe JavaScript integer range`)
  }
  return parsed
})

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: isProduction ? 20 : 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // Cut off any statement past 30 seconds. There is no legitimate query here that takes
  // that long; what does take that long is a query holding a connection hostage.
  statement_timeout: 30_000,
})

pool.on('error', (err) => {
  logger.error({ err }, 'idle Postgres connection failed')
})

export type Database = NodePgDatabase<typeof schema>

export const db: Database = drizzle(pool, {
  schema,
  logger: env.LOG_LEVEL === 'trace',
})

/** The cheap check behind `/health/ready`. Deliberately not a `SELECT` from any table. */
export async function pingDatabase(): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query('SELECT 1')
    return true
  } finally {
    client.release()
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end()
}

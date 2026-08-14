import { timestamp, uuid } from 'drizzle-orm/pg-core'
import { v7 as uuidv7 } from 'uuid'

/**
 * Column shapes that must be identical everywhere in the schema. This is not about saving
 * keystrokes — it is about making sure no single table quietly ends up on `serial`, or on
 * `timestamp without time zone`.
 */

/**
 * A **UUIDv7** primary key: as unguessable as any UUID, but time-ordered, so inserts land
 * at the right-hand edge of the B-tree instead of scattering across it the way UUIDv4 does
 * in a table that grows quickly. Generated in the application because Postgres 17 has no
 * built-in `uuidv7()`.
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7())

/** A reference to another table that also uses UUIDv7 keys. */
export const idRef = (name: string) => uuid(name)

/** Every instant is stored in UTC with its offset; conversion happens at the edges. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

/** Uniform `created_at` + `updated_at`. Spread it: `...timestamps()`. */
export const timestamps = () => ({
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at').notNull().defaultNow(),
})

/**
 * The schema barrel. `drizzle.config.ts` points at this file, which means **a table that
 * is not exported here will never be migrated** — the most confusing failure mode in
 * Drizzle, and the only antidote is discipline: every new schema file gets added below in
 * the same commit that creates it.
 *
 * It is deliberately a `schema.ts` file rather than a `schema/index.ts`: the `#*` alias in
 * package.json maps one-to-one onto files, with no directory resolution.
 */

export * from './schema/identity'
export * from './schema/rbac'
export * from './schema/audit'
export * from './schema/jobs'
export * from './schema/mail'
export * from './schema/schedules'
export * from './schema/cache'

import { defineConfig } from 'vitest/config'

/**
 * The minimum environment `src/env.ts` needs to boot, so the suite runs in CI with no
 * `.env` at all.
 *
 * It is also written straight into `process.env`, not only handed to `test.env`:
 * `globalSetup` runs in the main Vitest process, outside the reach of `test.env`. Without
 * that line the migration step would quietly connect to whatever `DATABASE_URL` the
 * developer has in `.env` — migrating their working database while the tests themselves
 * ran against an empty `app_test`.
 */
const TEST_ENV = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://app:app@localhost:7332/app_test',
  CORS_ORIGINS: 'http://localhost:7301',
  LOG_LEVEL: 'silent',
  LOG_PRETTY: 'false',
  // Handlers run inline and **rethrow**, so a suite asserting an endpoint's effect fails
  // when the job behind it throws. The database driver is constructed directly by the
  // driver suite, which is the only place a poll loop belongs in a test.
  QUEUE_DRIVER: 'sync',
  // Not because anything defaults to Redis — nothing does — but because the redis driver
  // suite must fail rather than skip when there is no server. `make up-redis` locally,
  // a service container in CI, both on 7379.
  REDIS_URL: 'redis://localhost:7379',
  // The default anyway, and pinned so it stays true whatever a developer's `.env` says:
  // a suite that quietly started talking to a real SMTP server would send real email.
  MAIL_DRIVER: 'log',
  // Every rendered link is built from this, so an assertion about a link is only stable
  // if the origin is. It matches CORS_ORIGINS above, which the cross-field rule requires.
  CONSOLE_URL: 'http://localhost:7301',
} as const

Object.assign(process.env, TEST_ENV)

export default defineConfig({
  // No aliases here: `#…` is resolved by Vite through the `imports` field in package.json,
  // exactly the way Node and TypeScript resolve it.
  test: {
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // The suites talk to a real Postgres. Access control on top of a mocked database only
    // ever proves that the mock allows what the mock allows.
    globalSetup: ['tests/setup/database.ts'],
    // One process, so suites cannot collide on the shared database. They are I/O-bound
    // and short; the isolation is worth more than the parallelism.
    fileParallelism: false,
    env: TEST_ENV,
  },
})

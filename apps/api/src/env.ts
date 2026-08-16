import { join } from 'node:path'

import { z } from 'zod'

/**
 * Load `.env` from the root of the monorepo. Deliberately not dotenv: Node has
 * `process.loadEnvFile` built in. If the file is missing — in CI, or in a container whose
 * environment is injected by the orchestrator — say nothing; the validation below is what
 * gets to complain.
 */
function loadDotEnv(): void {
  const rootEnvPath = join(import.meta.dirname, '..', '..', '..', '.env')
  try {
    process.loadEnvFile(rootEnvPath)
  } catch {
    // No .env file — carry on with the process environment.
  }
}

loadDotEnv()

/**
 * A comma-separated list of browser origins allowed to call this API with credentials.
 *
 * This is the one setting that makes adding a frontend a `.env` edit instead of an API
 * edit — see docs/guides/add-frontend-app.md. Each entry is normalised to a bare origin
 * (`https://admin.example.com`, never a trailing slash and never a path) because that is
 * exactly what a browser puts in the `Origin` header, and CORS matching is a string
 * comparison, not a URL comparison.
 */
const corsOrigins = z
  .string()
  .min(1)
  .transform((raw) =>
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .superRefine((entries, ctx) => {
    if (entries.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'must list at least one origin' })
      return
    }

    for (const entry of entries) {
      if (entry === '*') continue

      let url: URL
      try {
        url = new URL(entry)
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: `"${entry}" is not an absolute URL — write it as http://localhost:7301`,
        })
        continue
      }

      if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
        ctx.addIssue({
          code: 'custom',
          message: `"${entry}" has a path — an origin is scheme + host + port only, so use ${url.origin}`,
        })
      }
    }
  })
  .transform((entries) => entries.map((entry) => (entry === '*' ? entry : new URL(entry).origin)))

/**
 * The environment is validated once at boot and then frozen. If something is missing or
 * malformed the process **dies in its first second** with a message naming the variable —
 * rather than an `undefined` that detonates three hours later in the middle of a request.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_NAME: z.string().min(1).default('App'),

    API_PORT: z.coerce.number().int().min(1).max(65_535).default(7300),
    API_HOST: z.string().min(1).default('0.0.0.0'),
    API_URL: z.url().default('http://localhost:7300'),

    CORS_ORIGINS: corsOrigins,

    DATABASE_URL: z.string().min(1),

    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    LOG_PRETTY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    SESSION_COOKIE_NAME: z.string().min(1).default('app_session'),
    SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

    /**
     * How long a password reset link stays usable. An invitation lives for days because it
     * has to survive a weekend; a reset only has to survive the walk to an inbox, and every
     * extra hour is another hour a link sitting in a mailbox is a live credential.
     *
     * Capped at a day rather than left open: an unbounded reset TTL is a second password.
     */
    PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),

    /**
     * How background work is carried.
     *
     * `database` is the default because it is the only driver whose enqueue can join the
     * transaction that caused it — see `docs/features/queue.md`. `sync` runs the handler
     * inline and is what the test suite uses, so a suite asserts the effect of a job
     * rather than the existence of a row. `redis` is BullMQ, for when the throughput is
     * worth giving that guarantee up.
     */
    QUEUE_DRIVER: z.enum(['sync', 'database', 'redis']).default('database'),
    /** How long the poller waits when it found nothing. It does not wait at all when it did. */
    QUEUE_POLL_MS: z.coerce.number().int().min(50).max(60_000).default(1000),
    /** How many jobs one worker claims at a time. Also the size of one batch. */
    QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
    /** The default for a job whose definition does not set its own. */
    QUEUE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    /**
     * How long a job may sit `running` before it is assumed the worker holding it is dead.
     * A live worker finishes or fails in seconds; anything past this is a crash.
     */
    QUEUE_STALE_AFTER_MINUTES: z.coerce.number().int().min(1).max(1440).default(15),
    /**
     * How long a shutting-down worker waits for the jobs still running before telling them,
     * through `ctx.signal`, that nobody is waiting any more.
     *
     * Deliberately below the shutdown registry's own 10-second per-task timeout: the worker
     * has to be able to report what it gave up on, and a grace period that outlives the
     * registry's patience is a warning nobody ever sees.
     */
    QUEUE_SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).max(60_000).default(8000),

    /**
     * Where Redis is, for whichever subsystem has been pointed at it.
     *
     * Optional, because nothing here needs Redis by default — and required the moment
     * something does, through the cross-field rule below. A subsystem that discovered the
     * setting was missing at its first `push` would report it as a job failing to enqueue,
     * hours after the deploy that caused it.
     */
    REDIS_URL: z.string().min(1).optional(),

    /**
     * Run the worker inside the API process instead of alongside it.
     *
     * Unset, it is `true` in development and `false` everywhere else — see
     * `workerInProcess` below. `make dev` therefore stays one terminal, while production
     * opts into a separate process by default, which is what lets the worker be restarted
     * or scaled without touching the API.
     */
    WORKER_IN_PROCESS: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),

    /**
     * The first account `make seed` creates. Read here rather than hard-coded in the
     * seeder so that a fresh clone can be given a real address without editing source —
     * and so the password of the very first account never has to be committed.
     */
    SEED_OWNER_EMAIL: z.email().default('owner@example.com'),
    SEED_OWNER_NAME: z.string().trim().min(1).max(120).default('Owner'),
    SEED_OWNER_PASSWORD: z.string().min(8).max(512).default('password123'),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV === 'production' && config.CORS_ORIGINS.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ORIGINS'],
        message:
          'cannot be "*" in production — this API sends credentials, and a browser rejects a wildcard origin on a credentialed request anyway. List the real origins.',
      })
    }

    if (config.QUEUE_DRIVER === 'redis' && !config.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message:
          'is required when QUEUE_DRIVER=redis — write it as redis://localhost:7379. Without it nothing would fail until the first enqueue, which is a request, in production, at the worst moment.',
      })
    }
  })

export type Env = Readonly<z.infer<typeof envSchema>>

function loadEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${details}\n\nSee .env.example.`)
  }

  return Object.freeze(parsed.data)
}

export const env = loadEnv(process.env)

export const isProduction = env.NODE_ENV === 'production'
export const isTest = env.NODE_ENV === 'test'

/**
 * Whether `src/index.ts` also starts the queue worker.
 *
 * The default is a function of `NODE_ENV`, which a single Zod field cannot express — a
 * default is computed before the object is assembled, so it cannot read a sibling. Derived
 * here instead, beside `isProduction`, rather than through a schema-level transform that
 * would make the whole shape harder to read for one line of logic.
 */
export const workerInProcess = env.WORKER_IN_PROCESS ?? env.NODE_ENV === 'development'

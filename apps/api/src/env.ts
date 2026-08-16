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
 * Whether this runtime can do arithmetic in the named zone.
 *
 * `Intl.DateTimeFormat` is the only honest test: `Intl.supportedValuesOf('timeZone')` lists
 * what the ICU build shipped with, which on a small Node image is a smaller set than what it
 * will actually accept, and rejecting a zone that works is a worse failure than the one this
 * is guarding against.
 */
function isKnownTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch {
    return false
  }
}

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
     * Whether the worker ticks the schedules.
     *
     * On by default, because a template whose cleanups are configured and not running is a
     * template that teaches nothing. It is a switch rather than a thing you comment out
     * because the reason to turn it off is temporary — a staging replica sharing a
     * production database, an afternoon spent watching one job by hand.
     *
     * `false` in the test suite: a scheduler ticking a real Postgres underneath a suite is a
     * source of rows nobody wrote.
     */
    SCHEDULER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /**
     * The timezone every cron expression is read in.
     *
     * `UTC` by default, and this is the setting to think about before changing: `15 3 * * *`
     * in a zone with daylight saving happens twice on one morning a year and not at all on
     * another. UTC has neither problem, and a cleanup does not care what time it is locally.
     *
     * Validated here rather than at the first tick, because croner checks a zone lazily —
     * an unknown one would otherwise surface at 03:15, inside a worker, as a caught error.
     */
    SCHEDULER_TIMEZONE: z
      .string()
      .min(1)
      .default('UTC')
      .refine(isKnownTimezone, 'is not an IANA timezone this runtime knows — for example UTC'),

    /** How often the schedules are compared against the clock. Not how often anything runs. */
    SCHEDULER_TICK_MS: z.coerce.number().int().min(1000).max(300_000).default(30_000),

    /**
     * How far back a tick will look for an occurrence it has not fired yet.
     *
     * This is the answer to "the worker was down for a week". With an hour's window it fires
     * last night's cleanup once and lets the six before it stay missed, rather than firing
     * seven at a database that is already behind. Widen it if a missed run genuinely has to
     * be caught up; the cost of widening is how much of a backlog one restart can release.
     */
    SCHEDULER_CATCHUP_MINUTES: z.coerce.number().int().min(1).max(1440).default(60),

    /**
     * Where cached values live.
     *
     * `memory` is the default because it is the only one that needs nothing: a fresh clone
     * caches in a `Map` and is correct, as long as there is one process. It stops being
     * correct the moment there are two — an entry invalidated on one replica stays served
     * by the other — which is why `docs/features/cache.md` says so in bold and why nothing
     * in this template caches anything by default.
     *
     * `database` shares the cache across replicas using Postgres, which is already there.
     * `redis` is the fast one, and the cross-field rule below refuses to boot without a URL.
     */
    CACHE_DRIVER: z.enum(['memory', 'database', 'redis']).default('memory'),

    /**
     * In front of every cache key.
     *
     * The point is a shared Redis or a shared database: two installations reading each
     * other's entries is a bug that looks like data corruption, and `clear()` without a
     * namespace to stay inside is one installation emptying another's cache.
     */
    CACHE_PREFIX: z.string().min(1).max(64).default('app:'),

    /**
     * The cap on the `memory` driver, in entries. Ignored by the other two, which are
     * bounded by the store they live in.
     *
     * A `Map` with no ceiling is a memory leak wearing a cache's clothes — slow, invisible,
     * and fatal on the one process that happens to see unusual traffic.
     */
    CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(1_000_000).default(10_000),

    /**
     * Whether a user's permission set is cached between requests.
     *
     * **Off**, and the default is the honest one. `loadAccess()` runs on every authenticated
     * request, so caching it is the single largest saving available here — and it is also the
     * one place where a stale value means somebody keeps an access they have had taken away.
     * The invalidation matrix in `docs/features/cache.md` is exhaustive for changes made
     * *through this API*, and cannot be for changes made outside it: a re-seed, a
     * `topUpWildcardRoles`, an UPDATE run by hand. Turning it on is trading that window for
     * a query, which is a decision an installation makes with its own numbers.
     */
    CACHE_ACCESS_PERMISSIONS: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    /**
     * How long a cached permission set lives.
     *
     * Capped at five minutes deliberately. Every invalidation this codebase performs is
     * best-effort — a deferred task that logs and swallows — so the TTL is the backstop that
     * makes a missed one temporary rather than permanent. An unbounded TTL on a permission
     * set is a revocation that never happens.
     */
    CACHE_ACCESS_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(30),

    /**
     * How email leaves this process.
     *
     * `log` is the default, and it is a real driver rather than a stub: it writes the
     * message to the log **and** to `mail_messages`, so a fresh clone with no SMTP server
     * anywhere can still invite somebody and read the link. Configuring a transport is
     * therefore a thing you do when you are ready, not a thing standing between you and the
     * first run.
     *
     * `smtp` is the one that leaves the process. It needs `SMTP_HOST` and nothing else in the
     * common case, and the cross-field rule below refuses to boot without it.
     */
    MAIL_DRIVER: z.enum(['log', 'smtp']).default('log'),

    /**
     * The envelope sender. Recorded on every row as it read at the time, so a message sent
     * under a domain you have since left still says so.
     */
    MAIL_FROM: z.email().default('no-reply@example.com'),
    MAIL_FROM_NAME: z.string().trim().min(1).max(120).optional(),

    /** How long a sent or failed message is kept. A mail log that grows forever is a table nobody vacuums. */
    MAIL_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

    /**
     * Where the console is, from the outside.
     *
     * Effectively required, and this is the setting people are surprised by: every link in
     * an email is absolute, and the code that builds it runs in a **worker**, where
     * `window.location.origin` — which `InviteTokenDialog.vue` uses today — does not exist.
     * The cross-field rule below keeps it honest.
     */
    CONSOLE_URL: z.url().default('http://localhost:7301'),

    /**
     * Where mail is handed over, when `MAIL_DRIVER=smtp`.
     *
     * Optional here and required by the cross-field rule below, the same shape as `REDIS_URL`:
     * a driver that discovered the host was missing at its first send would report it as a
     * job retrying, hours after the deploy that caused it.
     */
    SMTP_HOST: z.string().min(1).optional(),
    /** 587 is submission-with-STARTTLS, which is what a relay offers unless it says otherwise. */
    SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(587),
    /**
     * Left unset, implicit TLS is inferred from the port — 465 yes, anything else no. Set it
     * only for a relay that put SMTPS somewhere unusual. See `smtp.ts` for why guessing is
     * safe: on 587 nodemailer still upgrades through `STARTTLS`.
     */
    SMTP_SECURE: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) => (value === undefined ? undefined : value === 'true')),
    /**
     * Both optional, and deliberately so: an internal relay that authenticates by IP is
     * offered no credentials at all rather than an empty pair. `smtp.ts` omits the whole
     * `auth` object when the user is unset.
     */
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),

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

    const wantsRedis = [
      config.QUEUE_DRIVER === 'redis' ? 'QUEUE_DRIVER' : null,
      config.CACHE_DRIVER === 'redis' ? 'CACHE_DRIVER' : null,
    ].filter((name) => name !== null)

    if (wantsRedis.length > 0 && !config.REDIS_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['REDIS_URL'],
        message: `is required when ${wantsRedis.join(' or ')} is redis — write it as redis://localhost:7379. Without it nothing would fail until the first enqueue or the first cache read, which is a request, in production, at the worst moment.`,
      })
    }

    if (config.MAIL_DRIVER === 'smtp' && !config.SMTP_HOST) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message:
          'is required when MAIL_DRIVER=smtp — with no host there is nowhere to send. Without this rule the failure would surface as every invitation retrying three times and landing failed, which looks like a broken mail server rather than a missing setting.',
      })
    }

    // The cross-field rule that pays for itself. Every link in an email is built from
    // CONSOLE_URL, so an origin the console's own API will not talk to means an invitation
    // that lands on a page whose first request is blocked by CORS — a failure that looks
    // like a broken invitation and is actually a typo in a different variable.
    if (
      !config.CORS_ORIGINS.includes('*') &&
      !config.CORS_ORIGINS.includes(new URL(config.CONSOLE_URL).origin)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONSOLE_URL'],
        message: `is ${new URL(config.CONSOLE_URL).origin}, which is not in CORS_ORIGINS (${config.CORS_ORIGINS.join(', ')}). Every link in an email points at this origin, so the page it opens would be unable to call this API.`,
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

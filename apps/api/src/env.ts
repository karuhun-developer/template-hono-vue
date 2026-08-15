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

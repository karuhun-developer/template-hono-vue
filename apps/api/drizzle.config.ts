import { defineConfig } from 'drizzle-kit'

// drizzle-kit runs as its own process rather than through src/index.ts, so it loads the
// environment itself. Node has a built-in loader; no dotenv needed.
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)
} catch {
  // No .env file — fall back to whatever the shell exports.
}

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env first.')
}

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: databaseUrl },
  // Migrations are committed SQL, never `push`: the history of the schema has to be
  // readable in code review and replayable, byte for byte, in production.
  strict: true,
  verbose: true,
  casing: 'snake_case',
})

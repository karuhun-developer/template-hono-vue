import { fileURLToPath } from 'node:url'

import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig, loadEnv } from 'vite'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export default defineConfig(({ mode }) => {
  /**
   * One `.env`, at the root of the repo — not one per app.
   *
   * The API port, the console port and `CORS_ORIGINS` have to agree with each other. Once
   * every app keeps its own copy of that agreement, it takes exactly one forgotten edit for
   * a frontend to be pointed at a different API than the one it is allowed to talk to.
   */
  const env = loadEnv(mode, repoRoot, '')
  const port = Number(env.CONSOLE_PORT ?? 7301)

  return {
    envDir: repoRoot,
    plugins: [vue(), tailwindcss()],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    // `strictPort` on purpose: Vite's default is to quietly move to the next free port,
    // and a moved port is no longer in `CORS_ORIGINS`. Failing to start is a much
    // shorter debugging session than a preflight that fails for no visible reason.
    server: { port, strictPort: true },
    preview: { port, strictPort: true },
  }
})

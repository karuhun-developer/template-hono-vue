import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    /**
     * `.ts` only. What is unit-tested here is the pure logic that has been lifted out of
     * the components — the navigation decision, the error reader, the session store. A
     * component test that renders a card to assert the card renders is a test that fails
     * whenever the design changes and never when the behaviour does.
     */
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: {
      // `lib/api.ts` reads this when the module loads. Nothing ever connects to it: every
      // test stubs `fetch`.
      VITE_API_URL: 'http://api.test',
    },
  },
})

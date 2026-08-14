/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the Hono API. Comes from the `.env` at the root of the repo — see `vite.config.ts`. */
  readonly VITE_API_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

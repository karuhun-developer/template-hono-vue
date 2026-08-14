// @ts-check
import js from '@eslint/js'
import ts from 'typescript-eslint'
import vue from 'eslint-plugin-vue'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

export default ts.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/drizzle/**', '**/*.d.ts'],
  },

  js.configs.recommended,
  ...ts.configs.recommendedTypeChecked,
  ...vue.configs['flat/recommended'],

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // Vue SFCs use vue-eslint-parser with @typescript-eslint nested inside it.
  {
    files: ['**/*.vue'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { parser: ts.parser },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      // An optional prop here genuinely means "not supplied": `variant`/`size` are
      // defaulted by cva, and an absent `class` should not become an empty string.
      // Forcing a default value would erase that distinction.
      'vue/require-default-prop': 'off',
    },
  },

  // `.ts` entrypoints in a Vue app that import `.vue` components.
  // ESLint's TypeScript program cannot read types inside an SFC — to it `App.vue`
  // is an error type and every use of it is reported as "unsafe". vue-tsc can read
  // it, and vue-tsc still runs as a gate via `pnpm typecheck`.
  //
  // The glob is `apps/*` on purpose: a new frontend app must not have to be
  // registered here. See docs/guides/add-frontend-app.md.
  {
    files: ['apps/*/src/main.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-argument': 'off',
    },
  },

  // Build configuration runs in Node, not in the browser.
  {
    files: ['apps/*/vite.config.ts', 'apps/*/vitest.config.ts', 'packages/*/vitest.config.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    files: ['**/*.test.ts', '**/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...ts.configs.disableTypeChecked,
  },

  {
    // Command-line scripts. `no-console` exists because a stray log in a request path is a
    // line nobody can query — but here the console *is* the interface, and these run before
    // `pnpm install`, so there is no logger to reach for.
    files: ['scripts/**/*.mjs'],
    rules: {
      'no-console': 'off',
    },
  },

  prettier,
)

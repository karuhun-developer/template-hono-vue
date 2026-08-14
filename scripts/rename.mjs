#!/usr/bin/env node
// Rename this template. Run it once, immediately after cloning, before `pnpm install` —
// the root package name ends up in pnpm-lock.yaml.
//
//   node scripts/rename.mjs --name acme-portal --dry-run
//   node scripts/rename.mjs --name acme-portal
//   node scripts/rename.mjs --name acme-hq --title 'Acme HQ' --author 'Acme Ltd'
//
// Zero dependencies, because this is the one script that has to work before an install.
//
// It is a literal replacement over a **fixed list of paths**. No globbing, nothing
// recursive, nothing that walks src/. A rename script that walks src/ is a rename script
// that renames something inside a string literal at three in the morning. If a new
// identity string appears, add its exact path to EDITS below.
//
// See docs/guides/rename-template.md.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const OLD_SLUG = 'hono-vue-template'
const OLD_TITLE = 'Hono + Vue Template'
// The GitHub repository, and therefore the directory `git clone` creates. Deliberately not
// the same string as the package name.
const OLD_REPO = 'template-hono-vue'

// --- Arguments --------------------------------------------------------------

/**
 * Accepts both `--name value` and `--name=value`. The Makefile passes the second form
 * (`make rename name=acme-portal`), the guide shows the first, and neither is worth being
 * strict about.
 */
function parseArgs(argv) {
  const options = { dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true
      continue
    }
    const match = /^--(name|title|author)(?:=(.*))?$/.exec(arg)
    if (!match) {
      fail(`unknown argument: ${arg}`)
    }
    const value = match[2] ?? argv[++i]
    if (value == null || value.startsWith('--')) {
      fail(`--${match[1]} needs a value`)
    }
    options[match[1]] = value
  }
  return options
}

function fail(message) {
  console.error(`rename: ${message}\n`)
  console.error(
    'usage: node scripts/rename.mjs --name <slug> [--title <Title>] [--author <Name>] [--dry-run]',
  )
  process.exit(1)
}

/** npm-safe: lowercase, letters/digits/hyphens, starting with a letter. */
function assertSlug(slug) {
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    fail(
      `"${slug}" is not a valid name. Use lowercase letters, digits and hyphens, starting with a letter — for example acme-portal.`,
    )
  }
}

/**
 * `acme-portal` -> `Acme Portal`. Right often enough to be the default, wrong for
 * acronyms — which is what `--title` is for.
 */
function titleFromSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ')
}

// --- The edits --------------------------------------------------------------

/**
 * One entry per file. `optional: true` means the file may legitimately be absent (`.env`
 * before `make setup`, `LICENSE` if it was replaced).
 *
 * Each replacement is a regex anchored tightly enough to be idempotent: running the script
 * twice changes nothing the second time, and a file that has already been renamed simply
 * reports no change instead of erroring.
 */
function editsFor({ slug, title, author }) {
  const edits = [
    {
      file: 'package.json',
      replacements: [
        { find: /"name":\s*".*?"/, replace: `"name": "${slug}"`, what: 'package name' },
        {
          find: /"description":\s*".*?"/,
          replace: `"description": "${title}"`,
          what: 'description',
        },
      ],
    },
    {
      file: 'README.md',
      replacements: [
        { find: /^# .*$/m, replace: `# ${title}`, what: 'heading' },
        {
          find: new RegExp(`^cd ${OLD_REPO}$`, 'm'),
          replace: `cd ${slug}`,
          what: 'quick-start path',
        },
      ],
    },
    {
      file: 'CHANGELOG.md',
      replacements: [
        {
          find: /top of this template/,
          replace: `top of ${title}`,
          what: 'the "this template" line',
        },
      ],
    },
    {
      file: 'AGENTS.md',
      replacements: [
        {
          find: new RegExp(escape(OLD_TITLE), 'g'),
          replace: title,
          what: 'heading and project line',
        },
      ],
    },
    {
      file: 'CLAUDE.md',
      replacements: [{ find: /^# .*$/m, replace: `# ${title}`, what: 'heading' }],
    },
    {
      // The compose *project* name. Volumes are namespaced under it, so two
      // template-derived projects both called `app` would share one database.
      file: 'docker-compose.yml',
      replacements: [
        { find: /^name: .+$/m, replace: `name: ${slug}`, what: 'compose project name' },
      ],
    },
    {
      file: '.env.example',
      replacements: [{ find: /^APP_NAME=.*$/m, replace: `APP_NAME=${title}`, what: 'APP_NAME' }],
    },
    {
      file: '.env',
      optional: true,
      replacements: [{ find: /^APP_NAME=.*$/m, replace: `APP_NAME=${title}`, what: 'APP_NAME' }],
    },
  ]

  // The copyright holder is a claim about a person, so it is only touched when one was
  // named. Without --author, LICENSE is left alone and reported as a follow-up.
  if (author) {
    edits.push({
      file: 'LICENSE',
      optional: true,
      replacements: [
        {
          find: /^(Copyright \(c\) \d{4}) .+$/m,
          replace: `$1 ${author}`,
          what: 'copyright holder',
        },
      ],
    })
  }

  return edits
}

function escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// --- Run --------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2))

if (!options.name) {
  fail('--name is required')
}
assertSlug(options.name)

const slug = options.name
const title = options.title ?? titleFromSlug(slug)
const author = options.author ?? null

console.log(`rename: ${OLD_SLUG} -> ${slug}`)
console.log(`rename: ${OLD_TITLE} -> ${title}`)
if (author) console.log(`rename: copyright holder -> ${author}`)
if (options.dryRun) console.log('rename: dry run, nothing will be written')
console.log('')

let changedFiles = 0
let changedStrings = 0

for (const edit of editsFor({ slug, title, author })) {
  const path = join(ROOT, edit.file)

  let original
  try {
    original = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT' && edit.optional) {
      console.log(`  -  ${edit.file} (not present, skipped)`)
      continue
    }
    fail(`could not read ${relative(ROOT, path)}: ${error.message}`)
  }

  let updated = original
  const applied = []
  for (const replacement of edit.replacements) {
    const next = updated.replace(replacement.find, replacement.replace)
    if (next !== updated) applied.push(replacement.what)
    updated = next
  }

  if (updated === original) {
    console.log(`  -  ${edit.file} (already up to date)`)
    continue
  }

  if (!options.dryRun) {
    writeFileSync(path, updated)
  }
  changedFiles += 1
  changedStrings += applied.length
  console.log(`  ${options.dryRun ? '~' : '✓'}  ${edit.file} — ${applied.join(', ')}`)
}

console.log('')
console.log(
  options.dryRun
    ? `rename: ${changedFiles} file(s), ${changedStrings} replacement(s) would change. Re-run without --dry-run.`
    : `rename: ${changedFiles} file(s), ${changedStrings} replacement(s) updated.`,
)

if (changedFiles === 0) {
  console.log('rename: nothing to do — this repository looks renamed already.')
  process.exit(0)
}

if (!options.dryRun) {
  console.log('')
  console.log('Next, by hand:')
  console.log(
    '  - README.md      rewrite the lead, delete “What this template deliberately does not include”',
  )
  console.log('  - CHANGELOG.md   replace the [0.1.0] section with your own first entry')
  if (!author)
    console.log('  - LICENSE        change the copyright holder (or pass --author next time)')
  console.log('  - then: pnpm install && make setup && make up && make migrate && make seed')
}

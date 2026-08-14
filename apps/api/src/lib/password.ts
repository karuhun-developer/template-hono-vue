import { hash, verify } from '@node-rs/argon2'

/**
 * Password hashing.
 *
 * Argon2id, not bcrypt: bcrypt truncates its input at 72 bytes and has no memory
 * parameter, so its resistance to GPU attack cannot be raised as hardware improves. The
 * parameters follow the OWASP recommendation (19 MiB, 2 iterations, parallelism 1) —
 * heavy enough to hurt an attacker, still under 100 ms on a reasonable server.
 *
 * Everything here is `async`. `hashSync` exists and is tempting, but a hash that eats
 * 19 MiB and tens of milliseconds on the event loop will freeze the whole API the moment
 * ten people sign in at once.
 */

/**
 * `Algorithm.Argon2id` = 2. The number is written out because `Algorithm` is an ambient
 * `const enum`, and `verbatimModuleSyntax` forbids reaching for it — its value would have
 * to be inlined at compile time, yet a type-only import must not survive to runtime.
 */
const ARGON2ID = 2

const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  /** KiB. 19456 = 19 MiB. */
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const

/**
 * A decoy hash with the same parameters, used to equalise the response time when an email
 * is not found. Without it, signing in as an address that exists takes ~25 ms longer than
 * one that does not, and that difference is enough to enumerate who has an account.
 *
 * It is a **real hash** of a random string nobody has ever used — not something
 * hand-written. A fabricated hash would fail at the parsing stage and return immediately
 * without burning any time at all, which recreates the very gap it is meant to close.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$sZMlfxVu4yZdMCvQQW3A/Q$IBDOtzy6VoMitj6kMTW+glZZ7e/Zj49bDV48gJKKs+o'

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS)
}

/**
 * Check a password against its hash. A corrupt or unrecognised hash counts as **no
 * match** rather than throwing: one damaged row must not turn the login endpoint into a
 * 500 that confirms the row exists.
 */
export async function verifyPassword(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain, ARGON2_OPTIONS)
  } catch {
    return false
  }
}

/**
 * Burn the time of one real verification, to no useful end.
 *
 * Called on the "no such user" path so that the failing and succeeding paths cost roughly
 * the same.
 */
export async function verifyDummyPassword(plain: string): Promise<false> {
  await verifyPassword(DUMMY_HASH, plain)
  return false
}

/**
 * Was this hash produced with weaker parameters than the ones in force today?
 *
 * Argon2 parameters get raised as hardware improves. An old password cannot be re-hashed
 * without its plaintext, so the only opportunity is **a successful sign-in** — the one
 * moment the plaintext is in hand.
 */
export function needsRehash(hashed: string): boolean {
  const params = parseArgon2Params(hashed)
  if (!params) return true

  return (
    params.algorithm !== 'argon2id' ||
    params.memoryCost < ARGON2_OPTIONS.memoryCost ||
    params.timeCost < ARGON2_OPTIONS.timeCost
  )
}

type Argon2Params = {
  algorithm: string
  memoryCost: number
  timeCost: number
  parallelism: number
}

/** PHC format: `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`. */
export function parseArgon2Params(hashed: string): Argon2Params | null {
  const match = /^\$(argon2[a-z]+)\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hashed)
  if (!match) return null

  const [, algorithm, memory, time, parallel] = match
  if (!algorithm || !memory || !time || !parallel) return null

  return {
    algorithm,
    memoryCost: Number(memory),
    timeCost: Number(time),
    parallelism: Number(parallel),
  }
}

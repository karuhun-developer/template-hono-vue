import type { PermissionKey } from '@app/contract'
import { describe, expect, it } from 'vitest'

import { dialogMode, offeredModes, type UserSummary } from '@/features/users/api'

/**
 * The one branch of `UserFormDialog` worth a test.
 *
 * It decides which endpoint a submit reaches, and getting it wrong sends an invitation to
 * somebody who was meant to be created with a password — a mistake that looks like nothing
 * at all until the account never activates.
 *
 * What this is **not** is a test of authorisation. Nothing here refuses anything;
 * `requirePermission()` in the API does, and `apps/api/tests/users.test.ts` asserts the
 * 403s. These assertions are about what is offered, not about what is allowed.
 */

function holding(...granted: string[]): (permission: PermissionKey) => boolean {
  return (permission) => granted.includes(permission)
}

/** Only the null-ness is read, so the rest of a `UserSummary` is beside the point. */
const EXISTING = { id: 'e7f0…', email: 'ada@example.com' } as UserSummary

describe('offeredModes', () => {
  it('offers only editing for an account that already exists', () => {
    expect(offeredModes(EXISTING, holding('user.invite', 'user.create'))).toEqual(['edit'])
  })

  it('offers both ways of adding one to whoever holds both keys', () => {
    expect(offeredModes(null, holding('user.invite', 'user.create'))).toEqual(['invite', 'create'])
  })

  it('offers one to whoever holds one', () => {
    expect(offeredModes(null, holding('user.invite'))).toEqual(['invite'])
    expect(offeredModes(null, holding('user.create'))).toEqual(['create'])
  })

  it('offers nothing to whoever holds neither, so the footer is Cancel alone', () => {
    expect(offeredModes(null, holding())).toEqual([])
  })
})

/** Which button Enter presses — the others are pressed by being pressed. */
describe('dialogMode', () => {
  it('edits an existing account whatever the caller holds', () => {
    expect(dialogMode(EXISTING, holding())).toBe('edit')
  })

  /** The account whose password nobody else has ever known is the better default. */
  it('opens on invite when both are held', () => {
    expect(dialogMode(null, holding('user.invite', 'user.create'))).toBe('invite')
  })

  it('opens on the only mode on offer', () => {
    expect(dialogMode(null, holding('user.create'))).toBe('create')
  })

  it('falls back to invite rather than to a mode with no route behind it', () => {
    expect(dialogMode(null, holding())).toBe('invite')
  })
})

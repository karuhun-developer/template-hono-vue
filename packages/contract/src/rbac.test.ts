import { describe, expect, it } from 'vitest'

import {
  PERMISSION_GROUPS,
  PERMISSION_KEYS,
  PERMISSIONS,
  resolveRolePermissions,
  SYSTEM_ROLES,
  isPermissionKey,
} from './rbac'

describe('permission catalog', () => {
  it('has no duplicate keys', () => {
    expect(new Set(PERMISSION_KEYS).size).toBe(PERMISSION_KEYS.length)
  })

  it('names every key <domain>.<action>', () => {
    for (const key of PERMISSION_KEYS) {
      expect(key).toMatch(/^[a-z]+(_[a-z]+)*\.[a-z]+(_[a-z]+)*$/)
    }
  })

  it('only uses declared groups', () => {
    for (const permission of PERMISSIONS) {
      expect(PERMISSION_GROUPS).toContain(permission.group)
    }
  })

  it('leaves no group empty', () => {
    for (const group of PERMISSION_GROUPS) {
      expect(PERMISSIONS.some((p) => p.group === group)).toBe(true)
    }
  })

  it('recognises catalog keys and rejects anything else', () => {
    expect(isPermissionKey('user.read')).toBe(true)
    expect(isPermissionKey('user.destroy')).toBe(false)
    expect(isPermissionKey('')).toBe(false)
  })
})

describe('system roles', () => {
  it('has no duplicate keys', () => {
    const keys = SYSTEM_ROLES.map((r) => r.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('only grants permissions that exist in the catalog', () => {
    for (const role of SYSTEM_ROLES) {
      for (const key of resolveRolePermissions(role)) {
        expect(PERMISSION_KEYS).toContain(key)
      }
    }
  })

  it('expands the owner wildcard to the whole catalog', () => {
    const owner = SYSTEM_ROLES.find((r) => r.key === 'owner')!
    expect(resolveRolePermissions(owner)).toEqual(PERMISSION_KEYS)
  })

  it('keeps admin strictly below owner', () => {
    // The docs promise that an admin cannot grant any of these. If someone widens the
    // admin role, that promise breaks silently — so assert it.
    //
    // These keys are also the whole of "owner only" in this template: present in the
    // catalog, absent here. Granting one to `admin` is what would quietly turn every
    // administrator into a superadmin, which is why the list is spelled out rather than
    // derived.
    const OWNER_ONLY = [
      'user.create',
      'user.disable',
      'user.delete',
      'user.reset_password',
      'audit.read',
      'job.read',
      'job.manage',
      'mail.read',
      'schedule.read',
      'schedule.run',
    ]

    const admin = SYSTEM_ROLES.find((r) => r.key === 'admin')!
    const granted: readonly string[] = resolveRolePermissions(admin)

    for (const key of OWNER_ONLY) {
      expect(PERMISSION_KEYS).toContain(key)
      expect(granted).not.toContain(key)
    }

    expect(granted.length).toBeLessThan(PERMISSION_KEYS.length)
  })
})

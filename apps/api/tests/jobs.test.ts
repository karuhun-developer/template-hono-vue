import { desc, eq, like } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase, db } from '#db/client'
import { auditLogs, jobs, type Job, type JobStatus } from '#db/schema'
import type { AuditActor } from '#modules/audit/audit.repo'
import { cancelQueuedJob, listVisibleJobs, retryJob } from '#modules/jobs/jobs.service'
import { createDatabaseJobAdmin, createRedisJobAdmin } from '#queue/queue.admin'

import {
  cleanFixtures,
  createRole,
  createUser,
  emailFor,
  ensureCatalog,
  login,
  request,
} from './support/world'

/**
 * The Jobs endpoints: who may read them, who may change them, and what "changing" means
 * under each driver.
 *
 * Two layers, because the suite runs on `QUEUE_DRIVER=sync` and cannot flip it — `env` is
 * frozen at boot. The **routes** are exercised through `app.request()`, which is where the
 * permission wall and the query validation live; **retry and cancel** are exercised
 * through the service with a database admin passed in, which is the seam that exists for
 * exactly this reason.
 */

const TAG = 'jobsapi'
const MANAGER = emailFor(TAG, 'manager')
const READER = emailFor(TAG, 'reader')
const OUTSIDER = emailFor(TAG, 'outsider')

/** Job names are not tagged by `cleanFixtures`, so this suite owns a prefix of its own. */
const PREFIX = 'jobsapi.'

let managerCookie: string
let readerCookie: string
let outsiderCookie: string
let actor: AuditActor

const admin = createDatabaseJobAdmin()

async function makeJob(
  name: string,
  overrides: Partial<{ status: JobStatus; attempts: number; lastError: string; runAt: Date }> = {},
): Promise<Job> {
  const [row] = await db
    .insert(jobs)
    .values({ name: `${PREFIX}${name}`, payload: { note: name }, ...overrides })
    .returning()

  if (!row) throw new Error(`could not create the ${name} test job`)
  return row
}

async function reload(id: string): Promise<Job> {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id))
  if (!row) throw new Error(`the job ${id} is gone`)
  return row
}

function cleanJobs(): Promise<unknown> {
  return db.delete(jobs).where(like(jobs.name, `${PREFIX}%`))
}

beforeAll(async () => {
  await cleanFixtures(TAG)
  await cleanJobs()
  await ensureCatalog()

  const managerRoleId = await createRole(TAG, 'manager', ['job.read', 'job.manage'])
  const readerRoleId = await createRole(TAG, 'reader', ['job.read'])
  const outsiderRoleId = await createRole(TAG, 'outsider', ['user.read'])

  const managerId = await createUser(MANAGER, { name: 'Manager', roleIds: [managerRoleId] })
  await createUser(READER, { name: 'Reader', roleIds: [readerRoleId] })
  await createUser(OUTSIDER, { name: 'Outsider', roleIds: [outsiderRoleId] })

  managerCookie = await login(app, MANAGER)
  readerCookie = await login(app, READER)
  outsiderCookie = await login(app, OUTSIDER)

  actor = { type: 'user', id: managerId, label: MANAGER }
})

afterEach(cleanJobs)

afterAll(async () => {
  await cleanJobs()
  await cleanFixtures(TAG)
  await closeDatabase()
})

describe('GET /jobs', () => {
  it('answers with the list envelope and says what the rows mean', async () => {
    const res = await request(app, '/jobs', { cookie: readerCookie })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number; coverage: string }

    // The suite runs on the sync driver, which stores nothing. An empty page and an honest
    // `coverage` beat a page that looks broken — this is the value the console renders
    // "Jobs run inline in this configuration" from.
    expect(body).toMatchObject({ items: [], total: 0, coverage: 'none', page: 1 })
  })

  it('rejects a status that is not a status, rather than ignoring it', async () => {
    const res = await request(app, '/jobs?status=nonsense', { cookie: readerCookie })

    expect(res.status).toBe(400)
  })

  it('rejects a sort key that is not in the whitelist', async () => {
    // The whitelist is the only thing between `sort` and an ORDER BY.
    const res = await request(app, '/jobs?sort=payload', { cookie: readerCookie })

    expect(res.status).toBe(400)
  })

  it('is 403 without job.read', async () => {
    const res = await request(app, '/jobs', { cookie: outsiderCookie })

    expect(res.status).toBe(403)
  })
})

describe('POST /jobs/:id/retry and /cancel', () => {
  it('is 403 for a caller who may read jobs but not manage them', async () => {
    const job = await makeJob('failed', { status: 'failed', attempts: 3 })

    const retry = await request(app, `/jobs/${job.id}/retry`, {
      method: 'POST',
      cookie: readerCookie,
    })
    const cancel = await request(app, `/jobs/${job.id}/cancel`, {
      method: 'POST',
      cookie: readerCookie,
    })

    // Reading and changing are separate keys precisely so this pair can differ.
    expect(retry.status).toBe(403)
    expect(cancel.status).toBe(403)
  })

  it('is 403 without either key', async () => {
    const job = await makeJob('failed', { status: 'failed' })

    const res = await request(app, `/jobs/${job.id}/retry`, {
      method: 'POST',
      cookie: outsiderCookie,
    })

    expect(res.status).toBe(403)
  })

  it('rejects an id that is not an id before touching the database', async () => {
    const res = await request(app, '/jobs/not-a-uuid/retry', {
      method: 'POST',
      cookie: managerCookie,
    })

    expect(res.status).toBe(400)
  })

  it('is 404 under the sync driver, which knows about no job at all', async () => {
    const job = await makeJob('failed', { status: 'failed' })

    const res = await request(app, `/jobs/${job.id}/retry`, {
      method: 'POST',
      cookie: managerCookie,
    })

    // The row exists; the configured admin does not read the table. That is the honest
    // answer for a driver that runs handlers inline.
    expect(res.status).toBe(404)
  })
})

describe('the database admin', () => {
  it('pages, filters by status and counts the whole match', async () => {
    await makeJob('a', { status: 'failed' })
    await makeJob('b', { status: 'failed' })
    await makeJob('c', { status: 'succeeded' })

    const page = await listVisibleJobs(
      { status: ['failed'], page: 1, perPage: 1, sort: 'createdAt', order: 'desc' },
      admin,
    )

    expect(page.items).toHaveLength(1)
    // The count is over the filter, not over the page — the pager depends on it.
    expect(page.total).toBe(2)
    expect(page.coverage).toBe('all')
    expect(page.manageable).toBe(true)
  })

  it('filters by name, so one misbehaving job can be looked at on its own', async () => {
    await makeJob('wanted')
    await makeJob('other')

    const page = await listVisibleJobs(
      { name: [`${PREFIX}wanted`], page: 1, perPage: 10, sort: 'createdAt', order: 'desc' },
      admin,
    )

    expect(page.items.map((job) => job.name)).toEqual([`${PREFIX}wanted`])
  })

  it('moves a failed job back to pending with its attempts reset', async () => {
    const job = await makeJob('failed', {
      status: 'failed',
      attempts: 3,
      lastError: 'the handler said no',
      runAt: new Date(Date.now() - 60_000),
    })

    const after = await retryJob(actor, job.id, admin)

    expect(after.status).toBe('pending')
    // Zero, not "one more": the button is pressed after somebody fixed the cause, and a
    // job given one attempt from an exhausted budget would fail again immediately.
    expect(after.attempts).toBe(0)
    expect(after.finishedAt).toBeNull()
    // Kept: it is the reason the job was retried.
    expect(after.lastError).toContain('the handler said no')
    expect(after.runAt.getTime()).toBeGreaterThan(Date.now() - 5000)
  })

  it('records who retried it, in the same transaction as the change', async () => {
    const job = await makeJob('failed', { status: 'failed', attempts: 3 })

    await retryJob(actor, job.id, admin)

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.subjectId, job.id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1)

    expect(entry?.action).toBe('job.retry')
    expect(entry?.actorLabel).toBe(MANAGER)
  })

  it('refuses to retry a job that has not stopped', async () => {
    const running = await makeJob('running', { status: 'running' })

    // Requeueing a claimed row would hand the same payload to a second worker while the
    // first is still inside the handler.
    await expect(retryJob(actor, running.id, admin)).rejects.toMatchObject({ status: 409 })
  })

  it('cancels a job that has not started', async () => {
    const job = await makeJob('pending')

    const after = await cancelQueuedJob(actor, job.id, admin)

    expect(after.status).toBe('cancelled')
    expect(after.finishedAt).not.toBeNull()
    expect((await reload(job.id)).status).toBe('cancelled')
  })

  it('refuses to cancel a job that has already succeeded', async () => {
    const job = await makeJob('done', { status: 'succeeded' })

    await expect(cancelQueuedJob(actor, job.id, admin)).rejects.toMatchObject({ status: 409 })
    expect((await reload(job.id)).status).toBe('succeeded')
  })

  it('is 404 for a job that does not exist', async () => {
    await expect(
      retryJob(actor, '00000000-0000-4000-8000-000000000000', admin),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('the redis admin', () => {
  const redis = createRedisJobAdmin()

  it('lists the mirrored failures, and says that is what they are', async () => {
    await makeJob('mirrored', { status: 'failed', attempts: 2 })

    const page = await listVisibleJobs(
      { page: 1, perPage: 10, sort: 'createdAt', order: 'desc' },
      redis,
    )

    expect(page.items).toHaveLength(1)
    expect(page.coverage).toBe('failures')
    expect(page.manageable).toBe(false)
  })

  /**
   * The row is a copy of something that already died inside BullMQ. Flipping it to
   * `pending` would change nothing in Redis, where the queue actually is, and would leave a
   * row claiming to be queued that no worker will ever look at.
   */
  it('refuses to retry, rather than pretending the copy is the queue', async () => {
    const job = await makeJob('mirrored', { status: 'failed', attempts: 2 })

    await expect(retryJob(actor, job.id, redis)).rejects.toMatchObject({ status: 409 })
    expect((await reload(job.id)).status).toBe('failed')
  })
})

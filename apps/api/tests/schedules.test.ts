import { desc, eq, like, or } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { app } from '#app'
import { closeDatabase, db } from '#db/client'
import { auditLogs, jobs, scheduleRuns } from '#db/schema'
import { SCHEDULES } from '#scheduler/schedules'

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
 * The Scheduled jobs endpoints.
 *
 * The suite runs with `SCHEDULER_ENABLED=false`, which is the point rather than a
 * limitation: nothing ticks underneath these assertions, so every `schedule_runs` row seen
 * here is one this file put there. The tick itself is `tests/scheduler.test.ts`.
 *
 * `POST /:key/run` goes through the **real** scheduler singleton, because the route has no
 * seam and should not grow one for a test — so the schedule it fires is `mail.prune`, whose
 * handler deletes finished mail older than thirty days and therefore cannot touch a fixture
 * any suite created seconds ago. Under `QUEUE_DRIVER=sync` that handler runs inline, which
 * makes the endpoint's real effect part of what is asserted.
 */

const TAG = 'schedapi'
const RUNNER = emailFor(TAG, 'runner')
const READER = emailFor(TAG, 'reader')
const OUTSIDER = emailFor(TAG, 'outsider')

/** A real registry key, so the row joins to something the list endpoint returns. */
const KEY = 'mail.prune'

let runnerCookie: string
let readerCookie: string
let outsiderCookie: string

type RunFixture = { firedFor: Date; jobKey: string }

async function makeRun(
  minutesAgo: number,
  jobStatus?: 'succeeded' | 'failed',
): Promise<RunFixture> {
  const firedFor = new Date(Date.now() - minutesAgo * 60_000)
  const jobKey = `${KEY}:${firedFor.toISOString()}`

  await db.insert(scheduleRuns).values({ scheduleKey: KEY, firedFor, jobKey })

  if (jobStatus) {
    // The join is `jobs.dedupe_key = schedule_runs.job_key` — a plain text correlation,
    // because the queue keeps no row for the scheduler to point a foreign key at.
    await db.insert(jobs).values({
      name: `${TAG}.probe`,
      payload: {},
      status: jobStatus,
      attempts: jobStatus === 'failed' ? 3 : 1,
      lastError: jobStatus === 'failed' ? 'the handler said no' : null,
      dedupeKey: jobKey,
    })
  }

  return { firedFor, jobKey }
}

async function cleanRuns(): Promise<void> {
  await db.delete(scheduleRuns).where(eq(scheduleRuns.scheduleKey, KEY))
  await db.delete(jobs).where(or(like(jobs.name, `${TAG}.%`), like(jobs.dedupeKey, `${KEY}:%`)))
}

beforeAll(async () => {
  await cleanFixtures(TAG)
  await cleanRuns()
  await ensureCatalog()

  const runnerRoleId = await createRole(TAG, 'runner', ['schedule.read', 'schedule.run'])
  const readerRoleId = await createRole(TAG, 'reader', ['schedule.read'])
  const outsiderRoleId = await createRole(TAG, 'outsider', ['user.read'])

  await createUser(RUNNER, { name: 'Runner', roleIds: [runnerRoleId] })
  await createUser(READER, { name: 'Reader', roleIds: [readerRoleId] })
  await createUser(OUTSIDER, { name: 'Outsider', roleIds: [outsiderRoleId] })

  runnerCookie = await login(app, RUNNER)
  readerCookie = await login(app, READER)
  outsiderCookie = await login(app, OUTSIDER)
})

afterEach(cleanRuns)

afterAll(async () => {
  await cleanRuns()
  await cleanFixtures(TAG)
  await closeDatabase()
})

type SummaryBody = {
  items: { key: string; cron: string; job: string; nextRunAt: string | null; lastRun: unknown }[]
  timezone: string
  enabled: boolean
}

describe('GET /schedules', () => {
  it('answers with the whole registry, a live next run, and where it is not running', async () => {
    const res = await request(app, '/schedules', { cookie: readerCookie })

    expect(res.status).toBe(200)
    const body = (await res.json()) as SummaryBody

    // The registry is the list. There is no `schedules` table to fall out of step with it.
    expect(body.items.map((item) => item.key)).toEqual(SCHEDULES.map((s) => s.key))
    expect(body.timezone).toBe('UTC')
    // `SCHEDULER_ENABLED=false` in the test environment, and the endpoint says so rather
    // than showing six schedules with no runs and letting the page look broken.
    expect(body.enabled).toBe(false)

    for (const item of body.items) {
      // Computed on the request. A schedule with no next run at all would be one whose
      // expression can never fire again, which none of these are.
      expect(item.nextRunAt).not.toBeNull()
      expect(new Date(item.nextRunAt!).getTime()).toBeGreaterThan(Date.now())
    }
  })

  it('carries the newest run and the outcome of the job it enqueued', async () => {
    await makeRun(120, 'succeeded')
    await makeRun(60, 'failed')

    const res = await request(app, '/schedules', { cookie: readerCookie })
    const body = (await res.json()) as {
      items: { key: string; lastRun: { manual: boolean; job: { status: string } | null } | null }[]
    }

    const entry = body.items.find((item) => item.key === KEY)
    expect(entry?.lastRun?.manual).toBe(false)
    // The newest of the two, and the outcome comes from `jobs` — one source of truth,
    // rather than a status copied onto `schedule_runs` that could disagree with it.
    expect(entry?.lastRun?.job?.status).toBe('failed')
  })

  it('leaves the job null when nothing joined, rather than inventing an outcome', async () => {
    await makeRun(5)

    const res = await request(app, '/schedules', { cookie: readerCookie })
    const body = (await res.json()) as {
      items: { key: string; lastRun: { job: unknown } | null }[]
    }

    // This is what `QUEUE_DRIVER=redis` looks like on every row: a claimed tick with no
    // queue row to join to.
    expect(body.items.find((item) => item.key === KEY)?.lastRun?.job).toBeNull()
  })

  it('is 403 without schedule.read', async () => {
    const res = await request(app, '/schedules', { cookie: outsiderCookie })

    expect(res.status).toBe(403)
  })
})

describe('GET /schedules/:key/runs', () => {
  it('answers newest first, capped by the limit', async () => {
    await makeRun(180)
    await makeRun(120)
    const newest = await makeRun(60)

    const res = await request(app, `/schedules/${KEY}/runs?limit=2`, { cookie: readerCookie })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { firedFor: string }[] }
    expect(body.items).toHaveLength(2)
    expect(new Date(body.items[0]!.firedFor).getTime()).toBe(newest.firedFor.getTime())
  })

  it('rejects a limit outside the range instead of reading the whole table', async () => {
    const res = await request(app, `/schedules/${KEY}/runs?limit=100000`, { cookie: readerCookie })

    expect(res.status).toBe(400)
  })

  it('is 404 for a key that is not in the registry', async () => {
    // Not an empty list: "no runs yet" is an answer somebody would act on, and this is a
    // different thing entirely.
    const res = await request(app, '/schedules/nope.nope/runs', { cookie: readerCookie })

    expect(res.status).toBe(404)
  })

  it('is 403 without schedule.read', async () => {
    const res = await request(app, `/schedules/${KEY}/runs`, { cookie: outsiderCookie })

    expect(res.status).toBe(403)
  })
})

describe('POST /schedules/:key/run', () => {
  it('records a manual run, enqueues it, and audits who pressed the button', async () => {
    const res = await request(app, `/schedules/${KEY}/run`, {
      method: 'POST',
      cookie: runnerCookie,
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { runId: string; jobKey: string; job: string }
    expect(body.job).toBe(KEY)
    // Prefixed, so a manual fire can never occupy the dedupe key tonight's tick will use.
    expect(body.jobKey).toContain(':manual:')

    const [row] = await db.select().from(scheduleRuns).where(eq(scheduleRuns.id, body.runId))
    expect(row?.manual).toBe(true)
    expect(row?.scheduleKey).toBe(KEY)

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.subjectId, body.runId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1)

    expect(entry?.action).toBe('schedule.run')
    expect(entry?.actorLabel).toBe(RUNNER)
  })

  it('does not take the slot the real tick would claim', async () => {
    await request(app, `/schedules/${KEY}/run`, { method: 'POST', cookie: runnerCookie })
    await request(app, `/schedules/${KEY}/run`, { method: 'POST', cookie: runnerCookie })

    const rows = await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleKey, KEY))

    // Two presses, two rows: the unique tick index is partial on `manual = false`, so it
    // neither suppresses these nor is suppressed by them. A button that silently skipped a
    // night's cleanup would be a strange thing to have added.
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.manual)).toBe(true)
  })

  it('rejects a key too long to be one, before touching the database', async () => {
    const res = await request(app, `/schedules/${'x'.repeat(200)}/run`, {
      method: 'POST',
      cookie: runnerCookie,
    })

    expect(res.status).toBe(400)
  })

  it('is 404 for a key that is not in the registry', async () => {
    const res = await request(app, '/schedules/nope.nope/run', {
      method: 'POST',
      cookie: runnerCookie,
    })

    expect(res.status).toBe(404)
  })

  it('is 403 for a caller who may read schedules but not run them', async () => {
    const res = await request(app, `/schedules/${KEY}/run`, {
      method: 'POST',
      cookie: readerCookie,
    })

    // Reading answers "did last night's cleanup run". Running starts real work against
    // live data at a moment nobody planned for. Two keys, so this pair can differ.
    expect(res.status).toBe(403)
    expect(await db.select().from(scheduleRuns).where(eq(scheduleRuns.scheduleKey, KEY))).toEqual(
      [],
    )
  })

  it('is 403 without either key', async () => {
    const res = await request(app, `/schedules/${KEY}/run`, {
      method: 'POST',
      cookie: outsiderCookie,
    })

    expect(res.status).toBe(403)
  })
})

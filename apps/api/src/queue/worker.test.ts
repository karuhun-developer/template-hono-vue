import { afterEach, describe, expect, it } from 'vitest'

import type { QueueDriver } from '#queue/queue'
import { isWorkerRunning, startWorker, stopWorker } from '#queue/worker'

/**
 * The decisions two entrypoints share.
 *
 * No database: what is being tested is which driver gets started and how often, and a fake
 * driver answers that more directly than a real one ever could.
 */

type FakeDriver = QueueDriver & { starts: number; stops: { graceMs?: number }[] }

function fakeDriver(kind: QueueDriver['kind']): FakeDriver {
  const driver: FakeDriver = {
    kind,
    transactional: kind === 'database',
    starts: 0,
    stops: [],
    push: () => Promise.resolve(),
    start: () => {
      driver.starts += 1
    },
    stop: (options = {}) => {
      driver.stops.push(options)
      return Promise.resolve()
    },
  }
  return driver
}

afterEach(async () => {
  await stopWorker()
})

describe('startWorker', () => {
  it('starts the driver, once', () => {
    const driver = fakeDriver('database')

    expect(startWorker(driver)).toBe(true)
    expect(startWorker(driver)).toBe(false)

    expect(driver.starts).toBe(1)
    expect(isWorkerRunning()).toBe(true)
  })

  /** A worker on the sync driver would poll a table nothing is ever written to. */
  it('refuses the sync driver rather than idling against it', () => {
    const driver = fakeDriver('sync')

    expect(startWorker(driver)).toBe(false)
    expect(driver.starts).toBe(0)
    expect(isWorkerRunning()).toBe(false)
  })
})

describe('stopWorker', () => {
  it('stops the driver with a grace period', async () => {
    const driver = fakeDriver('database')
    startWorker(driver)

    await stopWorker()

    expect(driver.stops).toHaveLength(1)
    expect(driver.stops[0]?.graceMs).toBeGreaterThan(0)
    expect(isWorkerRunning()).toBe(false)
  })

  /** A signal can arrive before anything was ever started; shutdown must not care. */
  it('does nothing when no worker was started', async () => {
    await expect(stopWorker()).resolves.toBeUndefined()
  })

  it('lets a worker be started again afterwards', async () => {
    const driver = fakeDriver('database')

    startWorker(driver)
    await stopWorker()
    expect(startWorker(driver)).toBe(true)

    expect(driver.starts).toBe(2)
  })
})

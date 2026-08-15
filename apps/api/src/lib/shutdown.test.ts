import { describe, expect, it, vi } from 'vitest'

import { createShutdownRegistry, type ShutdownRegistryOptions } from '#lib/shutdown'

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

const registry = (options: ShutdownRegistryOptions = {}) =>
  createShutdownRegistry({ logger: silent, ...options })

describe('createShutdownRegistry', () => {
  it('runs tasks in reverse registration order', async () => {
    const order: string[] = []
    const { onShutdown, runShutdown } = registry()

    onShutdown('database', () => void order.push('database'))
    onShutdown('queue', () => void order.push('queue'))
    onShutdown('http-server', () => void order.push('http-server'))

    await runShutdown('test')

    // Registration order is dependency order, so the last thing registered is the first
    // thing stopped — the pool has to outlive whatever queries through it.
    expect(order).toEqual(['http-server', 'queue', 'database'])
  })

  it('keeps going when a task throws', async () => {
    const after = vi.fn()
    const { onShutdown, runShutdown } = registry()

    onShutdown('database', after)
    onShutdown('broken', () => {
      throw new Error('nope')
    })

    await expect(runShutdown('test')).resolves.toBeUndefined()
    expect(after).toHaveBeenCalledOnce()
  })

  it('stops waiting on a task that hangs, and runs the rest', async () => {
    vi.useFakeTimers()
    try {
      const after = vi.fn()
      const { onShutdown, runShutdown } = registry({ taskTimeoutMs: 50 })

      onShutdown('database', after)
      onShutdown('hung', () => new Promise<void>(() => {}))

      const done = runShutdown('test')
      await vi.advanceTimersByTimeAsync(50)
      await done

      expect(after).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('only runs once, however many times it is called', async () => {
    const task = vi.fn()
    const { onShutdown, runShutdown } = registry()
    onShutdown('once', task)

    await Promise.all([runShutdown('SIGINT'), runShutdown('SIGTERM')])
    await runShutdown('SIGTERM')

    expect(task).toHaveBeenCalledOnce()
  })

  it('exits after the signal handler has drained every task', async () => {
    const exit = vi.fn()
    const task = vi.fn()
    let handler: ((signal: NodeJS.Signals) => void) | undefined

    const { onShutdown, installSignalHandlers } = registry({
      exit,
      onSignal: (received) => {
        handler = received
      },
    })
    onShutdown('task', task)
    installSignalHandlers()

    handler?.('SIGTERM')
    await vi.waitFor(() => expect(exit).toHaveBeenCalled())

    expect(task).toHaveBeenCalledOnce()
  })
})

import { nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  useResourceList,
  type ResourceQuery,
  type ResourceResult,
} from '@/composables/useResourceList'

/**
 * The four things this composable exists to get right, and one it adds.
 *
 * All of them are about *how many requests* and *which answer wins* — none of them are
 * visible in a rendered table, and every one of them is a bug that only appears once the
 * list is long enough to page or the connection slow enough to reorder.
 */

type Row = { id: string }

const SORTABLE = ['name', 'createdAt'] as const

type SortKey = (typeof SORTABLE)[number]

/** A page of rows, so a successful fetch has something to write. */
const page = (ids: string[]): ResourceResult<Row> => ({
  items: ids.map((id) => ({ id })),
  total: ids.length,
})

/**
 * A `fetch` that answers with the same page every time and keeps what it was asked.
 *
 * Most of these tests are about *how many* questions were asked and *what was in* the last
 * one, so the recorded queries are the assertion surface rather than a mock's call list.
 */
function recorder(rows: string[] = ['a']): {
  seen: ResourceQuery<SortKey>[]
  fetch: (query: ResourceQuery<SortKey>) => Promise<ResourceResult<Row>>
} {
  const seen: ResourceQuery<SortKey>[] = []
  return {
    seen,
    fetch: (query) => {
      seen.push(query)
      return Promise.resolve(page(rows))
    },
  }
}

/** Resolves on demand, so a test can decide the order two answers come back in. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Lets every pending promise settle, then flushes the watchers they woke up. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await Promise.resolve()
    await nextTick()
  }
}

describe('useResourceList', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds the search box and asks once for a burst of typing', async () => {
    const { seen, fetch } = recorder()
    const list = useResourceList<Row, SortKey>({ fetch, sortable: SORTABLE })
    await settle()
    expect(seen).toHaveLength(1)

    for (const value of ['a', 'an', 'ann', 'anna']) {
      list.search.value = value
      await nextTick()
      await vi.advanceTimersByTimeAsync(50)
    }

    expect(seen).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(300)
    await settle()

    expect(seen).toHaveLength(2)
    expect(seen.at(-1)?.q).toBe('anna')

    list.stop()
  })

  it('goes back to page one when a filter narrows the list, in a single request', async () => {
    const statuses = ref<string[]>([])
    const { seen, fetch } = recorder()

    const list = useResourceList<Row, SortKey>({
      fetch,
      sortable: SORTABLE,
      filters: { statuses },
    })
    await settle()

    list.page.value = 4
    await settle()
    expect(seen).toHaveLength(2)

    statuses.value = ['active']
    await settle()

    // Page reset *and* filter change, coalesced into one load — a watcher per control
    // would have produced two, the first of them for a page nobody is looking at.
    expect(seen).toHaveLength(3)
    expect(list.page.value).toBe(1)
    expect(seen.at(-1)?.page).toBe(1)

    list.stop()
  })

  it('drops an answer that has been overtaken by a newer one', async () => {
    const first = deferred<ResourceResult<Row>>()
    const second = deferred<ResourceResult<Row>>()
    const answers = [first.promise, second.promise]
    let call = 0

    const list = useResourceList<Row, SortKey>({
      fetch: () => answers[call++] ?? Promise.resolve(page([])),
      sortable: SORTABLE,
    })
    await settle()

    list.page.value = 2
    await settle()

    // The newer question is answered first; the older one arrives late, as a slow
    // connection reordering two requests would produce.
    second.resolve(page(['new']))
    await settle()
    first.resolve(page(['old']))
    await settle()

    expect(list.rows.value).toEqual([{ id: 'new' }])
    expect(list.loading.value).toBe(false)

    list.stop()
  })

  it('reports a failure and stops loading', async () => {
    const failure = { code: 'forbidden' as const, message: 'No.', status: 403 }
    const list = useResourceList<Row, SortKey>({
      fetch: () => Promise.resolve({ failure }),
      sortable: SORTABLE,
    })
    await settle()

    expect(list.failure.value).toEqual(failure)
    expect(list.loading.value).toBe(false)
    expect(list.rows.value).toEqual([])

    list.stop()
  })

  it('falls back to the default rather than sending a sort the API would refuse', async () => {
    const { seen, fetch } = recorder([])
    const list = useResourceList<Row, SortKey>({
      fetch,
      sortable: SORTABLE,
      defaultSort: { key: 'name', order: 'asc' },
    })
    await settle()

    // A stale column preference, or a hand-edited URL. Either way it must not 400 the page.
    list.sort.value = { key: 'somethingElse', order: 'desc' }
    await settle()

    expect(list.sortKey.value).toBe('name')
    expect(seen.at(-1)?.sort).toBe('name')
    expect(seen.at(-1)?.order).toBe('desc')

    list.stop()
  })

  it('clears the search and every filter on reset', async () => {
    const statuses = ref<string[]>(['active'])
    const list = useResourceList<Row, SortKey>({
      fetch: () => Promise.resolve(page([])),
      sortable: SORTABLE,
      filters: { statuses },
    })
    await settle()

    list.search.value = 'ada'
    await vi.advanceTimersByTimeAsync(300)
    await settle()
    expect(list.filtered.value).toBe(true)

    list.reset()
    await settle()

    expect(list.search.value).toBe('')
    expect(list.q.value).toBe('')
    expect(statuses.value).toEqual([])
    expect(list.filtered.value).toBe(false)

    list.stop()
  })

  it('does not load until asked when immediate is off', async () => {
    const { seen, fetch } = recorder([])
    const list = useResourceList<Row, SortKey>({
      fetch,
      sortable: SORTABLE,
      immediate: false,
    })
    await settle()

    expect(seen).toHaveLength(0)
    expect(list.loading.value).toBe(false)

    await list.reload()
    expect(seen).toHaveLength(1)

    list.stop()
  })
})

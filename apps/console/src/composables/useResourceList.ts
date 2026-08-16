import type { DataTableSort } from '@app/ui'
import {
  computed,
  getCurrentInstance,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue'

import { networkFailure, readApiError, type ApiFailure } from '@/lib/api-error'

/**
 * The state behind a server-paged list screen.
 *
 * Every list in this console asks the same question in the same way — a debounced search
 * box, some faceted filters, a sort, a page — and gets back `{ items, total }`. Written out
 * per page that is roughly eighty lines of identical plumbing, and the interesting part is
 * that the plumbing is *subtle*: the debounce, the page reset, and the single coalesced
 * request are each one watcher away from being wrong in a way nobody notices until the list
 * is long enough to page.
 *
 * What it does **not** do is decide anything about the rows. Columns, cells, actions and
 * dialogs stay in the feature's own components; this is the question, not the answer.
 *
 * Cursor-paged lists (the audit log) do not use it. They page by `before=<id>`, which is a
 * different question with different state, and pretending otherwise would mean an options
 * bag with two mutually exclusive halves.
 */

export type ResourcePage<Row> = { items: Row[]; total: number }

export type ResourceResult<Row> = ResourcePage<Row> | { failure: ApiFailure }

export type ResourceQuery<Key extends string = string> = {
  /** The debounced search term. Empty means "not searching", not "search for nothing". */
  q: string
  page: number
  perPage: number
  /** Already checked against `sortable`, so it is always something the API accepts. */
  sort: Key
  order: 'asc' | 'desc'
  /** Aborts when a newer question is asked. Pass it to the client and stop paying for the answer. */
  signal: AbortSignal
}

export type UseResourceListOptions<Row, Key extends string> = {
  fetch: (query: ResourceQuery<Key>) => Promise<ResourceResult<Row>>
  /**
   * The sort keys the API's enum accepts. A `sort` outside this list falls back to the
   * default instead of 400ing the page — a stale `localStorage` column preference or a
   * hand-edited URL should not produce an error screen.
   *
   * Declaring it `as const` in the feature's `api.ts` is what keeps `sort` narrow enough to
   * hand straight to the typed client, with no cast at the call site.
   */
  sortable: readonly Key[]
  defaultSort?: DataTableSort
  /**
   * The faceted filters, by name. The composable watches them (so changing one resets the
   * page and reloads) and clears them in `reset()`; the values themselves are read by
   * `fetch`, which closes over the very same refs.
   */
  filters?: Record<string, Ref<string[]>>
  perPage?: number
  debounceMs?: number
  /** `false` leaves the list empty until something calls `reload()`. */
  immediate?: boolean
}

export type UseResourceList<Row, Key extends string = string> = {
  rows: Ref<Row[]>
  total: Ref<number>
  loading: Ref<boolean>
  failure: Ref<ApiFailure | null>
  /** What is typed. `q` is what has been asked for — see the debounce. */
  search: Ref<string>
  q: Ref<string>
  page: Ref<number>
  perPage: Ref<number>
  sort: Ref<DataTableSort>
  sortKey: ComputedRef<Key>
  /** True when anything is narrowing the list, which is what a Reset button keys off. */
  filtered: ComputedRef<boolean>
  reload: () => Promise<void>
  reset: () => void
  /** Cancels the debounce and any request in flight. Automatic inside a component. */
  stop: () => void
}

export function useResourceList<Row, Key extends string>(
  options: UseResourceListOptions<Row, Key>,
): UseResourceList<Row, Key> {
  const {
    fetch,
    sortable,
    defaultSort = null,
    filters = {},
    perPage: initialPerPage = 10,
    debounceMs = 300,
    immediate = true,
  } = options

  const rows = ref([]) as Ref<Row[]>
  const total = ref(0)
  const loading = ref(immediate)
  const failure = ref<ApiFailure | null>(null)

  const search = ref('')
  const q = ref('')
  const page = ref(1)
  const perPage = ref(initialPerPage)
  const sort = ref<DataTableSort>(defaultSort)

  const filterRefs = Object.values(filters)

  // `DataTableSort.key` is a plain string — the table reports whatever column was clicked,
  // and it has no idea what the API accepts. The `includes` check below is the narrowing;
  // the assertions are how that check is expressed to the type system.
  const fallbackSort = (defaultSort?.key ?? sortable[0] ?? '') as Key
  const sortKey = computed<Key>(() => {
    const key = sort.value?.key
    const accepted = (sortable as readonly string[]).includes(key ?? '')
    return accepted && key !== undefined ? (key as Key) : fallbackSort
  })

  const filtered = computed(
    () => q.value !== '' || filterRefs.some((entries) => entries.value.length > 0),
  )

  /* ------------------------------------------------------------------------- loading */

  /**
   * Two guards, for two different races.
   *
   * The debounce stops a burst of requests being *sent*; it does nothing about the answers
   * once they are in flight. Two requests 400 ms apart can still come back in the wrong
   * order over a bad connection, and the older one would overwrite the newer — the list
   * would show results for "ann" while the box says "anna".
   *
   * So each attempt takes a ticket, and only the newest ticket may write. The
   * `AbortController` is the other half: there is no reason to keep paying for a response
   * that has already been ruled out.
   */
  let ticketCounter = 0
  let inFlight: AbortController | null = null

  async function reload(): Promise<void> {
    const ticket = ++ticketCounter

    inFlight?.abort()
    const controller = new AbortController()
    inFlight = controller

    loading.value = true
    failure.value = null

    try {
      const result = await fetch({
        q: q.value,
        page: page.value,
        perPage: perPage.value,
        sort: sortKey.value,
        order: sort.value?.order ?? 'asc',
        signal: controller.signal,
      })

      if (ticket !== ticketCounter) return

      if ('failure' in result) {
        failure.value = result.failure
        return
      }

      rows.value = result.items
      total.value = result.total
    } catch (error) {
      // An abort is this composable's own doing, not something to show anybody.
      if (ticket !== ticketCounter || controller.signal.aborted) return
      failure.value = networkFailure(error)
    } finally {
      if (ticket === ticketCounter) loading.value = false
    }
  }

  function reset(): void {
    search.value = ''
    q.value = ''
    for (const entries of filterRefs) entries.value = []
  }

  /* ------------------------------------------------------------------------ watching */

  /**
   * Search is held for `debounceMs`. Without it, typing "anna" fires four requests for
   * three answers nobody wanted.
   */
  let debounce: ReturnType<typeof setTimeout> | undefined
  watch(search, (value) => {
    clearTimeout(debounce)
    debounce = setTimeout(() => (q.value = value.trim()), debounceMs)
  })

  /**
   * Narrowing the list puts you back on page one. Page 7 of the old list is almost never a
   * page of the new one, and landing on an empty page reads as "no results" when there are
   * plenty on page 1.
   */
  watch([q, ...filterRefs], () => {
    page.value = 1
  })

  /**
   * One request per change of the question, whatever changed it. Vue coalesces the writes
   * in a tick, so narrowing the filter *and* resetting the page above is still a single
   * load — which is exactly what a watcher per control would not give you.
   */
  watch([q, ...filterRefs, sort, page, perPage], () => void reload())

  function stop(): void {
    clearTimeout(debounce)
    inFlight?.abort()
  }

  /**
   * Inside a component, the first load waits for the mount and the cleanup rides on the
   * unmount. Outside one — which is how this is unit-tested — there is no lifecycle to hang
   * either on, so the load starts straight away and the caller is responsible for `stop()`.
   * Registering the hooks anyway would only produce a Vue warning and no cleanup.
   */
  if (getCurrentInstance()) {
    onMounted(() => {
      if (immediate) void reload()
    })
    onBeforeUnmount(stop)
  } else if (immediate) {
    void reload()
  }

  return {
    rows,
    total,
    loading,
    failure,
    search,
    q,
    page,
    perPage,
    sort,
    sortKey,
    filtered,
    reload,
    reset,
    stop,
  }
}

/**
 * Turns a Hono client response into what `fetch` has to return.
 *
 * Keeps the page type inferred from the route — the caller never names it — while putting
 * the "was it ok, and what does an error body look like" question in one place rather than
 * in every list on the site.
 *
 * The **whole** response type survives rather than being narrowed to `{ items, total }`,
 * because a list endpoint is allowed to answer with more than a page: `GET /jobs` sends
 * `coverage`, `manageable` and `names` alongside its rows, and those are things the page
 * has to render. `useResourceList` reads the two fields it needs and ignores the rest.
 */
export async function listResult<Page extends ResourcePage<unknown>>(
  pending: Promise<{
    ok: boolean
    status: number
    json: () => Promise<Page>
  }>,
): Promise<Page | { failure: ApiFailure }> {
  const response = await pending
  if (!response.ok) return { failure: await readApiError(response) }
  return response.json()
}

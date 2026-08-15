# The data table

Every list in the console — users, roles, the audit trail — is the same component. It renders rows, a toolbar, a sorting header and a pager; it decides nothing.

| Concern             | File                                                               |
| ------------------- | ------------------------------------------------------------------ |
| The table           | `packages/ui/src/components/data-table/DataTable.vue`              |
| Column definitions  | `packages/ui/src/components/data-table/types.ts`                   |
| Sorting header      | `packages/ui/src/components/data-table/DataTableColumnHeader.vue`  |
| Pager (three modes) | `packages/ui/src/components/data-table/DataTablePagination.vue`    |
| Loading rows        | `packages/ui/src/components/data-table/DataTableSkeleton.vue`      |
| Column visibility   | `packages/ui/src/components/data-table/DataTableViewOptions.vue`   |
| Faceted filter      | `packages/ui/src/components/data-table/DataTableFacetedFilter.vue` |
| A page using it     | `apps/console/src/pages/UsersPage.vue`                             |

## The shape of a list page

```vue
<DataTable
  v-model:sort="sort"
  v-model:page="page"
  v-model:per-page="perPage"
  :columns="COLUMNS"
  :rows="users"
  :loading="loading"
  :total="total"
  row-key="id"
  storage-key="users"
  empty="No users match that."
>
  <template #toolbar>…</template>
  <template #cell:status="{ row }"><Badge>{{ row.status }}</Badge></template>
  <template #actions="{ row }">…</template>
</DataTable>
```

```ts
const COLUMNS: DataTableColumn[] = [
  { key: 'name', header: 'Name', sortable: true, hideable: false },
  { key: 'status', header: 'Status', sortable: true, class: 'w-32' },
  { key: 'createdAt', header: 'Added', sortable: true, hidden: true },
]
```

A column is data about a column, not a render function. `key` is three things at once: the field it reads, the slot that draws it (`#cell:status`), and — when `sortable` — the value sent as `?sort=`. Keep it equal to the field, and give a computed column a key nobody else uses.

| Field      | Means                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| `sortable` | Offers Asc/Desc in the header menu. **The API decides what it accepts**    |
| `hidden`   | Rendered, but off until switched on in the View menu                       |
| `hideable` | `false` keeps it out of the View menu — the column that identifies the row |
| `class`    | Applied to the `<th>` **and** every `<td>`, so a width set once holds      |
| `align`    | `'end'` for numbers                                                        |

Without a `#cell:` slot a cell prints the value. Strings, numbers and booleans render; `null` and `''` become `—`; an array or an object also becomes `—`, because only the page knows how a list of roles should look and `[object Object]` in a table is worse than a dash.

## It renders, it does not compute

Sorting, filtering and paging are all server-side, so the component holds none of that state. It reports the sort you asked for and the page you clicked; the page component turns them into query parameters and asks again.

```ts
watch([q, statuses, sort, page, perPage], () => void load())
```

The one thing the table does own is **column visibility**, because that is a preference about this screen on this machine and no API needs to hear about it. With `storage-key` it is remembered in `localStorage` under `data-table:<key>`.

The table also resets `page` to 1 whenever the sort changes. Re-sorting and staying on page 7 shows a page of a list you have not seen the start of — every table wants that, so it happens once here instead of in each page. Resetting the page when a **filter** changes is the page's job, since only it knows what its filters are.

## Three pagers, on purpose

`mode` decides what the footer is allowed to claim.

| Mode       | Needs                   | Shows                                                 | Used by          |
| ---------- | ----------------------- | ----------------------------------------------------- | ---------------- |
| `numbered` | `total`                 | rows-per-page, result count, first/prev/1…n/next/last | Users, Roles     |
| `cursor`   | `has-prev` / `has-next` | rows-per-page, "Showing N", Previous / Next           | Audit log        |
| `none`     | —                       | nothing                                               | a list that fits |

A single pager that counted rows itself would print a page count that changes every time you look at it on any list still being written to. The audit trail is exactly that list — see [`audit-log.md`](audit-log.md) for why it pages by cursor — so its footer offers Previous and Next and admits it does not know how many pages there are.

Walking a keyset **backwards** is the page's job, and it costs one array:

```ts
const trail = ref<(string | null)[]>([null]) // the cursor each page started from
const index = ref(0)
```

## Loading

`:loading` swaps the body for `DataTableSkeleton`, which renders `perPage` rows **inside the real `<thead>`, using the real visible columns**. The table does not move when the data lands, which is the entire point of a skeleton over a spinner. Give it the same `perPage` the request used and the page stops jumping altogether.

## Toolbar and filters

The `#toolbar` slot holds whatever narrows the list. `DataTableFacetedFilter` is the `⊕ Status` pill: a popover of checkboxes whose chosen values are shown **on the trigger**. That is the point of it — a filter you cannot see is how somebody ends up reporting that a row "disappeared" when they narrowed the list four minutes ago.

Its model is a `string[]`, so the page sends the parameter once per ticked box:

```ts
...(statuses.value.length === 0 ? {} : { status: statuses.value }),
```

The API reads a repeated parameter as a set — `repeatable()` in `apps/api/src/lib/query.ts`. A filter that quietly answers only the first tick is worse than one that refuses.

The View button (`DataTableViewOptions`) is rendered by the table itself unless you pass `:view-options="false"`.

## Selection

`selectable` adds the checkbox column, a header checkbox with an indeterminate state, and `Shift`-click for ranges. Changing page or page size clears the selection: a count carried over would refer to rows that are no longer on screen, and a bulk action would then hit the wrong ones.

The `#bulk` slot is the floating bar that appears while something is selected. **Give it something to do or leave selection off** — a checkbox column with no action behind it is decoration that costs a column.

The user list's bulk disable sends one request per account, in order, because the API has no bulk endpoint. Firing them all at once would leave a half-applied change nobody can read afterwards: which of the twelve failed?

## Why this and not TanStack Table

TanStack's value is its row models — client-side sorting, filtering, pagination and grouping. Every list here is paged by the API, so all of those would be switched off, leaving a column-definition API built around `h()` render functions in a codebase where everything else is an SFC template.

The trade is real and worth stating: there is no built-in grouping, no virtualisation, and no column resizing. If a list in your project genuinely needs them, add TanStack **for that page** rather than reworking this one.

## Conventions

- A sortable column's `key` is a key the API's `sort` enum accepts. It is a whitelist there, not a column name — see `SORTABLE` in `apps/api/src/modules/users/users.repo.ts`.
- Say why a list is empty. `empty="No users match that."` beats "No data".
- Colours come from tokens. A status column full of `bg-green-500` is exactly where dark mode breaks — see [`theming.md`](theming.md).
- Give every table a `storage-key` once it has more than four columns.
- `row-key` is a field that identifies the row. It is used for `:key`, for selection, and for nothing else.

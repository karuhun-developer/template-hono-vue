/**
 * A column definition.
 *
 * Deliberately a plain object rather than a builder or a render function: a column is
 * data about a column, and the only thing that varies per page — what a cell looks
 * like — is a slot in the page's own template, where the rest of that page's markup
 * already lives.
 *
 * `key` doubles as the slot name (`#cell:status`) and, when `sortable`, as the value
 * sent to the API as `?sort=`. Keep it equal to the field it shows; a column that has
 * no field of its own (a computed "Last seen", say) still needs a key nobody else uses.
 */
export type DataTableColumn = {
  key: string
  header: string
  /** Offers Asc/Desc in the header menu. The API decides what it actually accepts. */
  sortable?: boolean
  /** Rendered, but off by default. The user can switch it on from the View menu. */
  hidden?: boolean
  /** `false` keeps it out of the View menu entirely — the column that identifies a row. */
  hideable?: boolean
  /** Applied to both the `<th>` and every `<td>`, so a width set once holds. */
  class?: string
  align?: 'start' | 'end'
}

/** `null` means "whatever order the API returns", which is not the same as ascending. */
export type DataTableSort = { key: string; order: 'asc' | 'desc' } | null

/**
 * How the footer pages.
 *
 * Three modes rather than one because the three lists in this template genuinely page
 * differently, and a pager that shows "Page 1 of 12" over a cursor-paged endpoint is
 * inventing a number nobody counted.
 */
export type DataTablePaginationMode = 'numbered' | 'cursor' | 'none'

/** An option in a faceted filter. `count` is shown on the right when the API supplies one. */
export type DataTableFacet = { value: string; label: string; count?: number }

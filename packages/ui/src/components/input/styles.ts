/**
 * The base classes of a text field, extracted out of `Input.vue` so that any specialised
 * input you add later — a currency field, a masked field, a combobox — renders the exact
 * same box. Two fields sitting next to each other in one form must not differ by a single
 * pixel in height, and that is precisely what happens when the classes get copy-pasted.
 *
 * `text-base` rather than `text-sm` on mobile: iOS Safari zooms the page in when you focus
 * an input smaller than 16px, and it never zooms back out.
 */
export const inputBaseClass =
  'border-input file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground flex h-11 w-full min-w-0 rounded-lg border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm'

export const inputStateClass =
  'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 aria-invalid:border-destructive'

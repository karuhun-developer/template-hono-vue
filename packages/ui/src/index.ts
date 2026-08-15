/**
 * Barrel for `@app/ui`.
 *
 * These components are vendored copies of shadcn-vue (the `new-york-v4` style) sitting
 * on top of reka-ui, adjusted for this template: larger touch targets and colours that
 * come exclusively from the tokens in `styles.css`.
 *
 * They are copied rather than re-packaged on purpose. A design system you can edit in
 * place is worth more than one you have to fight: when a component needs one extra
 * variant, you add it here instead of wrapping the library in a component that exists
 * only to override it.
 */
export { cn } from './lib/utils'

export * from './components/avatar'
export * from './components/badge'
export * from './components/button'
export * from './components/card'
export * from './components/checkbox'
export * from './components/collapsible'
export * from './components/dialog'
export * from './components/dropdown-menu'
export * from './components/input'
export * from './components/label'
export * from './components/popover'
export * from './components/select'
export * from './components/separator'
export * from './components/sheet'
export * from './components/sidebar'
export * from './components/skeleton'
export * from './components/table'
export * from './components/textarea'
export * from './components/tooltip'

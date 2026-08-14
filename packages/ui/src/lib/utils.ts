import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge Tailwind classes with conflicts resolved the way you expect: `cn('p-2', 'p-4')`
 * is `p-4`.
 *
 * Without this, a `class` prop passed by a caller cannot be relied on to override a
 * component's defaults — CSS resolves ties by stylesheet order, not by the order the
 * classes appear in the attribute.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

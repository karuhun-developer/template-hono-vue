import { computed, ref, watchEffect, type ComputedRef, type Ref } from 'vue'

/**
 * Light, dark, or whatever the operating system says.
 *
 * The state is module-level rather than per-component: there is one document, so there is
 * one theme, and two components each holding their own copy of it is how a toggle in the
 * header stops agreeing with the one in the account menu.
 *
 * The class this ends up toggling is `.dark` on `<html>`, which is what the `dark:`
 * variant in `packages/ui/src/styles.css` is defined against. Nothing else needs to know.
 */

export type Theme = 'light' | 'dark' | 'system'

/**
 * Read in two places: here, and by the inline script in `index.html` that applies the
 * theme before the first paint. Change it here and change it there — the alternative is a
 * white flash on every reload, which is worse than the duplication.
 */
const STORAGE_KEY = 'theme'

const media =
  typeof window === 'undefined' ? null : window.matchMedia('(prefers-color-scheme: dark)')

const prefersDark = ref(media?.matches ?? false)
media?.addEventListener('change', (event) => (prefersDark.value = event.matches))

const theme = ref<Theme>(stored())

/** What is actually on screen. `system` is a preference, not a colour. */
const resolved = computed<'light' | 'dark'>(() =>
  theme.value === 'system' ? (prefersDark.value ? 'dark' : 'light') : theme.value,
)

// Runs once at import and again on every change, including a change to the OS setting
// while the tab is open — which is the whole point of keeping `system` as an option.
watchEffect(() => {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  root.classList.toggle('dark', resolved.value === 'dark')
  // Tells the browser to draw its own furniture — scrollbars, date pickers, form controls
  // it renders natively — in the matching palette. Without it those stay stubbornly light.
  root.style.colorScheme = resolved.value
})

function stored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value === 'light' || value === 'dark' || value === 'system') return value
  } catch {
    // Safari in private mode throws on read as well as write.
  }

  return 'system'
}

export function useTheme(): {
  theme: Ref<Theme>
  resolved: ComputedRef<'light' | 'dark'>
  setTheme: (value: Theme) => void
} {
  return { theme, resolved, setTheme }
}

export function setTheme(value: Theme): void {
  theme.value = value

  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    // A theme that forgets is not worth an error message.
  }
}

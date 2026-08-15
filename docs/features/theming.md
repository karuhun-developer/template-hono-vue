# Theming and dark mode

One palette — shadcn's **zinc** — defined once and switched by a class on `<html>`. No component knows which theme it is in.

| Concern                | File                                          |
| ---------------------- | --------------------------------------------- |
| Tokens (both palettes) | `packages/ui/src/styles.css`                  |
| The state              | `apps/console/src/composables/useTheme.ts`    |
| The control            | `apps/console/src/components/ThemeToggle.vue` |
| No-flash script        | `apps/console/index.html`                     |

## Three layers

```text
:root { --primary: oklch(0.21 0.006 285.885) }   ← the value, per palette
.dark { --primary: oklch(0.92 0.004 286.32) }

@theme inline { --color-primary: var(--primary) }   ← the bridge to Tailwind

class="bg-primary text-primary-foreground"          ← every component, ever
```

A component names `bg-primary`. It never names a colour. Switching the theme changes what `--primary` resolves to, and everything follows in the same repaint — which is why dark mode here is a class toggle rather than a sweep through the components.

Every colour comes in a pair: `--x` and `--x-foreground`. Use them together (`bg-card text-card-foreground`) and contrast holds in both palettes without anybody checking.

## The one rule

**No raw colours in a component.** No `bg-red-500`, no `text-emerald-600`, no `#18181b` in a template. If a colour has no token, add the token first. (The one hex pair in the repo is `<meta name="theme-color">`, which browser chrome reads before any CSS exists.)

```bash
grep -rn 'bg-\(red\|green\|blue\|slate\|zinc\|gray\)-[0-9]' apps packages   # should print nothing
```

Tailwind's own palette is fixed at one lightness. `bg-green-100` is a light chip on a light background and an eye-watering one on a dark background, and nothing in the build will tell you. The status tokens (`--success`, `--warning`, `--info`) exist precisely so a badge can mean "good" without naming green.

## Adding a token

1. Add `--thing` and `--thing-foreground` to **both** `:root` and `.dark` in `packages/ui/src/styles.css`. A token missing from `.dark` inherits the light value and is invisible there.
2. Add `--color-thing: var(--thing)` in the `@theme inline` block. That is what makes `bg-thing` exist.
3. Use it. Do not use it before step 1 — Tailwind silently drops a class it cannot resolve.

## The brand

There isn't one, on purpose. In zinc the primary is near-black in light mode and near-white in dark, so buttons and the sidebar's active row read as emphasis rather than as a colour, and nothing on screen competes with the data — which is the right default for a template that has no idea what it is going to become.

Giving it a hue is `--primary`, `--ring` and `--sidebar-primary` in **both** blocks, and nothing else. Note that the primary inverts between the two palettes: anything painted `bg-primary` across a large area — a split-screen panel, a hero — will flip from near-black to near-white with it. `bg-muted` is the token for a large surface that should stay quiet in both, which is why `AuthLayout` uses it.

## The state

```ts
const { theme, resolved, setTheme } = useTheme()
```

`theme` is `'light' | 'dark' | 'system'`; `resolved` is what is actually on screen. `system` is a preference, not a colour, and it tracks the OS **while the tab is open** — the `matchMedia` listener is what makes changing the OS setting at sunset change the page you are looking at.

The state is module-level rather than per-component. There is one document, so there is one theme; two components each holding a copy is how a toggle in the header stops agreeing with the one in the account menu.

## The flash

`apps/console/index.html` carries a small inline script that reads `localStorage` and sets the class **before the first paint**.

It has to be inline, and it has to be in the head. Anything in the bundle runs after the document has been painted once, so every reload in dark mode would flash white — briefly, and on every navigation that reloads the page.

> The storage key `'theme'` therefore exists in two places: that script and `useTheme.ts`. Two copies of one string is the price of running before any module does. Change one, change the other.

`<meta name="theme-color">` is declared twice, per `prefers-color-scheme`. Browser chrome cannot read a class, so it follows the OS rather than the in-app override.

## Adding this to another app

`useTheme.ts` is 75 lines with no dependency on the console. Copy the composable, the toggle and the inline script; import `@app/ui/styles.css` as the app already does. Nothing else is involved — see [`../guides/add-frontend-app.md`](../guides/add-frontend-app.md).

## Conventions

- Colours come from tokens, in every app and every package.
- Add a token to both palettes in the same edit, or it will be wrong in one of them.
- Pair a background with its `-foreground`. Do not mix `bg-card` with `text-foreground` and hope.
- Check both palettes before committing a new screen. Popovers, dropdowns and skeletons are where a missed token shows first.
- Opacity over new tokens for one-off tints: `bg-primary/10` beats a `--primary-subtle` nobody else will use.

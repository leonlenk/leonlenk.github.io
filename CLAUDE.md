# leonlenk.github.io

Personal site. **Astro 7** (static output) → GitHub Pages via
`.github/workflows/deploy.yaml` on every push to `main`. Package manager is
**pnpm**. Requires Node ≥22.12.

## Commands

| Command        | Does                                        |
| -------------- | ------------------------------------------- |
| `pnpm dev`     | Dev server at localhost:4321                |
| `pnpm build`   | Static build to `dist/`                     |
| `pnpm preview` | Serve the built `dist/` locally             |
| `pnpm sync`    | Regenerate `.astro/` content types          |
| `pnpm check`   | `astro check` — type errors in `.astro`     |
| `pnpm lint`    | ESLint (flat config, `eslint-plugin-astro`) |
| `pnpm format`  | Prettier over the repo                      |

Before trusting editor diagnostics after an Astro upgrade, run `pnpm sync` —
stale `.astro/types.d.ts` produces a flood of bogus `JSX.IntrinsicElements`
errors.

## Layout

```
src/
  content.config.ts   collection definitions (glob loader + zod schemas)
  content/blog/       markdown posts
  layouts/Base.astro  the single <html> shell — every page renders through it
  pages/              routes
  styles/global.css   reset + @font-face declarations only
public/fonts/         variable fonts (Lora, Open Sans)
```

Pages should not hand-roll `<html>`/`<head>`; pass `title`/`description` to
`Base.astro` and use its `head` slot for anything page-specific.

## Content collections

Use the **modern** API, not the legacy one. Entries are keyed by `post.id`;
`post.slug` and `entry.render()` no longer exist.

```ts
import { getCollection, render } from "astro:content";

const posts = await getCollection("blog");
const { Content } = await render(post);
```

## Dependencies

**Always run dependency changes by Leon before making them.** Upgrading to newer
frameworks or tooling is welcome, but propose it first — list what changes, what
breaks, and the migration cost — and wait for a decision. Never add or bump a
package unannounced.

**Before adding any new package, verify it has at least 1,000 weekly npm
downloads.** This is a supply-chain guard against typosquats and malicious
lookalikes. Check it and report the number as part of the proposal:

```sh
curl -s https://api.npmjs.org/downloads/point/last-week/<package> | jq .downloads
```

Anything under that threshold: don't add it, say so, and suggest a
better-established alternative.

## Conventions

- `astro.config.mjs` sets `build.assets: "assets"` deliberately — GitHub Pages
  and underscore-prefixed directories interact badly. Don't revert it to `_astro`.
- `sass` is installed so `<style lang="scss">` works, and `terser` backs the
  minifier setting in `astro.config.mjs`. Both are load-bearing config, not cruft.
- The lockfile (`pnpm-lock.yaml`) is committed. Keep it that way.

## Version pins — do not bump blindly

- **TypeScript is pinned to 6.x on purpose.** `typescript-eslint` requires
  `<6.1.0` and `@astrojs/check` requires `^5 || ^6`. Upgrading to TypeScript 7
  breaks both. Wait until they widen their peer ranges.
- `eslint-plugin-jsx-a11y` is a forced peer of `eslint-plugin-astro@3` but only
  declares support for ESLint ≤9, so `pnpm install` prints one peer warning
  against ESLint 10. Expected — not something to "fix".
- `@astrojs/markdown-remark` is an explicit dependency because Astro 7 changed
  the default markdown processor; it keeps remark/rehype plugins available.

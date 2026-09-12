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

## The design in one paragraph

The site is themed on shard theory. A dark nebula sits behind everything;
navigation is a Voronoi field of crystal **shards**, one per top-level
section. Colour lives **only in the seams** (glowing gradient edges); shard
interiors are dark glass. Each shard owns one slice of a single
teal→indigo→violet→plum→wine→ember spectrum ("Dusk Prism"). Display face is
Syne (uppercase, tracked), body is Lora. The intro animation (particles →
nucleation → crystallised seams → labels) plays once per session. These
choices were made deliberately with Leon; don't reopen them without asking.

## Layout

```
src/
  data/shards.ts        THE registry: id, label, tagline, deep/edge stops.
                        Also emits the CSS custom properties (shardCss()).
  data/ghosts.ts        decorative "ghost" labels shown on the largest filler shards
  content.config.ts     `posts` (glob, markdown) and `papers` (JSON) collections
  content/posts/<shard>/*.md   posts; frontmatter `shard:` must match the folder
  content/papers.json   research papers (rendered on /research/)
  lib/geometry.ts       pure Voronoi / inset / clip-path helpers (client + build)
  lib/color.ts          hex/hsl helpers, per-post variant colours
  lib/card-shapes.ts    varied convex card/panel silhouettes + safe padding
  lib/posts.ts          slug/href/date helpers shared by the routes
  lib/field-layout.ts   home field layout: sites, filler shards, power cells, tunables
  scripts/nebula.ts     shared nebula bitmap renderer (singleton + subscribe)
  scripts/shard-field.ts  home page: layered painter, intro, cursor light, expand
  scripts/chime.ts      Web Audio crystal chimes: one tone per shard on a rising
                        C-major-ninth arpeggio, in spectrum order (teal low → ember high)
  components/
    Nebula.astro        fixed background canvas, transition:persist
    Chrome.astro        wordmark + GitHub/Scholar/LinkedIn/email glyphs
    ShardField.astro    home page DOM (field canvas, light canvas, one <a> per shard)
    SeamPanel.astro     the dark-glass-with-glowing-seam building block
    ShardCard.astro     a post card (SeamPanel + variant colour)
    PaperCard.astro     a paper entry
  layouts/Base.astro    the single <html> shell; `shard` prop stamps data-shard
  pages/index.astro     home (shard field)
  pages/[shard]/index.astro   shard page: header, papers (research), post grid
  pages/[shard]/[post].astro  reading view
  styles/global.css     reset, @font-face, design tokens, base type
  styles/prose.css      reading typography, .chip
public/fonts/           Syne and Lora variable TTFs (Open Sans was removed)
```

Pages should not hand-roll `<html>`/`<head>`; pass `title`/`description`
(and `shard` where the page belongs to one) to `Base.astro` and use its
`head` slot for anything page-specific.

## Adding things

- **A shard:** add an entry to `src/data/shards.ts` (pick `deep`/`edge`
  stops that sit between its spectral neighbours) and create
  `src/content/posts/<id>/`. Routes, tokens, the home field and the schema
  all derive from the registry. The field places shards left→right by the hue
  of `edge[0]`.
- **A post:** markdown in `src/content/posts/<shard>/`. Required frontmatter:
  `title`, `pubDate`, `shard`. Optional: `description`, `updatedDate`, `tags`,
  `draft`. The URL is `/<shard>/<filename>/`.
- **A paper:** append to `src/content/papers.json` (`type` is journal /
  conference / preprint; `highlight` is the author to bold).

## Content collections

Use the **modern** API, not the legacy one. Entries are keyed by `post.id`
(`writing/koala_poem`); `post.slug` and `entry.render()` no longer exist.

```ts
import { getCollection, render } from "astro:content";

const posts = await getCollection("posts");
const { Content } = await render(post);
```

## Seam technique (why the markup looks the way it does)

`filter: drop-shadow()` is clipped by the same element's `clip-path`, so a
glowing clipped shape needs three layers: an outer element carrying the
drop-shadow glow, an edge layer with the gradient clipped to the polygon, and
a fill layer inset by 1.5px with the same clip-path. `SeamPanel.astro` does
this; reuse it rather than re-deriving it. Don't use `backdrop-filter` inside
a filtered ancestor — it silently breaks.

The canvas equivalent lives in `shard-field.ts` (`paintInterior`, `paintBleed`,
`paintSeam`, assembled by `buildLayers`): refracted nebula copy, dark tint,
specular, inward bleed inside the clip, then the seam stroke with `shadowBlur`
(multiplied by DPR — canvas shadows ignore the CTM). Blur is paid once per
layout into offscreen layers; per-frame paths (intro, expand, cursor light)
never use `shadowBlur`. Idle pages run zero rAF loops — keep it that way.

Unlabeled "filler" shards are visual only: power-diagram cells with small
weights, tuned in `lib/field-layout.ts`. They never appear in `shards.ts`.

## Dependencies

**Always run dependency changes by Leon before making them.** Upgrading to newer
frameworks or tooling is welcome, but propose it first — list what changes, what
breaks, and the migration cost — and wait for a decision. Never add or bump a
package unannounced. The current design is deliberately zero-dependency on the
client (Canvas 2D, hand-rolled Voronoi, Astro's own ClientRouter).

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
- Side builds for local checks go in `dist-<name>/` (`pnpm astro build --outDir dist-check`);
  ESLint, tsc, Prettier and git all ignore `dist-*`. Delete them when done.
- Headless Chromium screenshots of the home page need real time, not
  `--virtual-time-budget` (rAF is starved under virtual time and the CSS
  label transitions never finish). Shard pages are fine either way.
- `astro dev` and `astro preview` run as daemons in Astro 7 and only one
  preview may run at a time: stop them with `pnpm astro dev stop` /
  `pnpm astro preview stop`, not `pkill`.
- Chimes: browsers block audio until the first click or keypress, so hover
  chimes are silent on a fresh load until the visitor interacts once. The
  mute toggle in the top bar persists in `localStorage` (`shards:muted`).

## Version pins — do not bump blindly

- **TypeScript is pinned to 6.x on purpose.** `typescript-eslint` requires
  `<6.1.0` and `@astrojs/check` requires `^5 || ^6`. Upgrading to TypeScript 7
  breaks both. Wait until they widen their peer ranges.
- `eslint-plugin-jsx-a11y` is a forced peer of `eslint-plugin-astro@3` but only
  declares support for ESLint ≤9, so `pnpm install` prints one peer warning
  against ESLint 10. Expected — not something to "fix".
- `@astrojs/markdown-remark` is an explicit dependency because Astro 7 changed
  the default markdown processor; it keeps remark/rehype plugins available.

# leonlenk.github.io

Personal site. **Astro 7** (static output) → GitHub Pages via
`.github/workflows/deploy.yaml` after checks, tests, and a build on `main`.
Pull requests run the same checks without deploying. Package manager is
**pnpm**. Requires Node ≥22.12.

## Commands

| Command             | Does                                        |
| ------------------- | ------------------------------------------- |
| `pnpm dev`          | Dev server at localhost:4321                |
| `pnpm build`        | Static build to `dist/`                     |
| `pnpm preview`      | Serve the built `dist/` locally             |
| `pnpm sync`         | Regenerate `.astro/` content types          |
| `pnpm check`        | `astro check` — type errors in `.astro`     |
| `pnpm test`         | Node regression tests for browser lifecycle |
| `pnpm lint`         | ESLint (flat config, `eslint-plugin-astro`) |
| `pnpm format`       | Prettier over the repo                      |
| `pnpm music:render` | Re-render the background music (see Sound)  |

Before trusting editor diagnostics after an Astro upgrade, run `pnpm sync` —
stale `.astro/types.d.ts` produces a flood of bogus `JSX.IntrinsicElements`
errors.

## The design in one paragraph

The site is themed on shard theory. A dark nebula sits behind everything;
navigation is a Voronoi field of crystal **shards**, one per top-level
section. Colour lives **only in the seams** (glowing gradient edges); shard
interiors are dark glass. Each shard is a gemstone and owns one slice of a
single aquamarine→sapphire→amethyst→rhodolite→rose garnet→citrine spectrum
("Geode"); the unlabeled filler shards are the duller rock around them
(`FILLER_DULL` in `shard-field.ts`). Display face is
Syne (uppercase, tracked), body is Lora. The intro animation (particles →
nucleation → crystallised seams → labels) plays once per session. These
choices were made deliberately with Leon; don't reopen them without asking.

## Layout

```
src/
  data/shards.ts        THE registry: id, label, deep/edge stops, order.
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
  scripts/shard-field.ts  home page: layered painter, prism interiors, intro,
                          cursor light, expand
  scripts/field-ghosts.ts    ghost fitting, typing, rotation and lifecycle
  scripts/field-particles.ts intro particles and glow sprite cache
  scripts/field-growth.ts   seeded crystal growth geometry
  scripts/field-types.ts    shared renderer data contracts
  scripts/chime.ts      struck-glass chimes (one fixed note per shard, G major
                        pentatonic), the sound modes, gesture unlock, returning-
                        visitor autoplay, the pending hint, hidden-tab suspend
  scripts/audio.ts      the one shared AudioContext + master (0.55) → compressor
  scripts/music.ts      background-music player: two <audio> elements ping-pong
                        the pre-rendered intro/loop through Web Audio gains
  scripts/glints.ts     live glints and Hover's dust over the bed, driven by the
                        cue sheet; lazily built cave reverb + echo
  data/music.ts         the track descriptor (intro/loop URLs, cue URL) and cue types
  components/
    Nebula.astro        fixed background canvas, transition:persist
    Chrome.astro        wordmark + GitHub/Scholar/LinkedIn/email glyphs
    ShardField.astro    home page DOM (field canvas, light canvas, one <a> per shard,
                        the epigraph at the foot)
    ShardInterior.astro fixed CSS/SVG crystal faces on section and article pages
    SeamPanel.astro     the dark-glass-with-glowing-seam building block
    ShardCard.astro     a post card (SeamPanel + variant colour)
    PaperCard.astro     a paper entry
  layouts/Base.astro    the single <html> shell; `shard` prop stamps data-shard
  pages/index.astro     home (shard field)
  pages/[shard]/index.astro   shard page: header, papers (research), post grid
  pages/[shard]/[post].astro  reading view
  styles/global.css     reset, @font-face, design tokens, base type
  styles/prose.css      reading typography, .chip
public/fonts/           Syne and Lora variable WOFF2s for browsers; original TTFs
                        retained for social-image generation
public/audio/           rendered music (committed assets): cavern-{intro,loop}.{webm,m4a}
                        and the cavern.json cue sheet
tools/music/            offline render tool (not shipped): cavern-engine.js (the
                        prototype's engine, seeded and audio-clock scheduled),
                        render-page.js (OfflineAudioContext driver), render.mjs
```

Pages should not hand-roll `<html>`/`<head>`; pass `title`/`description`
(and `shard` where the page belongs to one) to `Base.astro` and use its
`head` slot for anything page-specific.

## Adding things

- **A shard:** add an entry to `src/data/shards.ts` (pick `deep`/`edge`
  stops that sit between its spectral neighbours) and create
  `src/content/posts/<id>/`. Routes, tokens, the home field and the schema
  all derive from the registry. The field sweeps the spectrum along the
  viewport's long axis (column by column on landscape, row by row on
  portrait; `spectrumOrder` in `lib/field-layout.ts`). A row snake was tried
  and rejected: it put amber beside indigo and teal. Fillers take the colour
  of the nearest labelled shard.
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
never use `shadowBlur`. Settled pages run no continuous rAF loops. Ghost typing uses bounded timers;
occasional gleams and mineral breathing use CSS animations.

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

## Sound

- **Chimes** are live Web Audio (struck glass, `chime.ts`) and play only on
  click (a shard on the home field, a card on a shard page), never on hover or
  focus. Browsers block audio until the first click or keypress, so the intro's
  cluster chime is silent on a fresh load.
- **Background music** is "Cavern of Light", one track for the whole site,
  **pre-rendered** (live synthesis cost 23–35% of a core; too much for phones).
  It is on by default (a deliberate artistic choice). The top-bar sound button
  cycles chimes + ambient → chimes only → off, persisted in `localStorage`
  (`shards:sound`). Until the music has actually started, `html[data-sound-pending]`
  is set, the button's glyph breathes (CSS only) and its tooltip says "Sound
  begins on your first click"; a click on the button then starts the sound
  rather than stepping the mode.
- **Starting:** the first pointerdown/pointerup/touchstart/touchend/keydown/click
  starts it (play() is called synchronously, for iOS). A visitor whose saved
  mode is ambient gets it on load without a gesture where the browser allows
  (Chrome's engagement rules); play() is only called once the context actually
  runs, otherwise it quietly waits for the gesture. Nothing loads before then.
- **Player** (`music.ts`): two `new Audio()` elements (not in the DOM, so they
  survive ClientRouter swaps) → MediaElementSource → gain → destination. Levels
  only through Web Audio gains (iOS ignores `element.volume`); never decode the
  tracks into AudioBuffers (~140 MB for six minutes of stereo). WebM/Opus where
  `canPlayType` says so, else M4A/AAC. The intro plays once per tab session;
  the loop repeats. Each file runs 3 s past its musical end (the cue's
  `duration`), and the seams are 2 s equal-power crossfades between the two
  elements, one timer per seam. Navigation never restarts or ducks it; a full
  reload resumes the loop at the saved position (sessionStorage `shards:music`)
  plus elapsed time, fading in over 3 s. Hidden tab: fade 1 s, pause both
  elements, drop the glints, suspend the context; no timers run while paused.
- **Glints stay live and random** (`glints.ts`): the prototype's gems and
  Hover's dust, placed by the cue sheet's movement spans. The cave reverb and
  echo exist only while a glint rings (the convolver is the expensive node:
  about +10 points of a core on desktop while ringing, +5 on phones, where the
  cave is one mono convolution and the glass keeps 3 partials). The bed alone
  costs about 2 points over an idle page.
- **Re-rendering:** `pnpm music:render` (needs chromium-browser and ffmpeg)
  renders the bed offline, deterministically (seeded), and writes
  `public/audio/cavern-*` plus `cavern.json`. The rendered files are
  **committed assets**: re-render and commit them together whenever the engine
  or settings change. Options: `--seed`, `--space/--light/--depth/--swell/--air/--pace`,
  `--track <name>` (output basename), `--engine <file>`. The render reports the
  peak; it must stay below −1 dBFS and is never normalised.
- **Per-page tracks** (not done; Leon chose one continuous track): render
  another track with different settings (`--track <name>`), add a descriptor to
  `data/music.ts` and a context → track lookup, and crossfade in the player on
  `astro:after-swap`.
- Harmony: every shard note must fit every chord of the music. Shard notes stay
  in G major pentatonic (D4 E4 G4 A4 B4 D5); the music never uses F#, and C
  only at C4 or below.

## Version pins — do not bump blindly

- **TypeScript is pinned to 6.x on purpose.** `typescript-eslint` requires
  `<6.1.0` and `@astrojs/check` requires `^5 || ^6`. Upgrading to TypeScript 7
  breaks both. Wait until they widen their peer ranges.
- `eslint-plugin-jsx-a11y` is a forced peer of `eslint-plugin-astro@3` but only
  declares support for ESLint ≤9, so `pnpm install` prints one peer warning
  against ESLint 10. Expected — not something to "fix".
- `@astrojs/markdown-remark` is an explicit dependency because Astro 7 changed
  the default markdown processor; it keeps remark/rehype plugins available.

## Sharing and fallback navigation

- `src/pages/rss.xml.ts` generates `/rss.xml` from all published posts, newest
  first. Drafts are excluded. The chrome links to it and Base advertises it.
- `src/pages/social/[...slug].png.ts` generates 1200×630 PNG previews for home,
  sections, and published posts. `src/lib/social-image.ts` uses seeded Voronoi
  geometry, registry palettes, checked-in fonts, and the existing Sharp package.
  No image service or manually maintained preview assets are needed.
- `src/lib/sharing.ts` shares image paths, description defaults, and XML escaping.
  Base emits Open Graph and Twitter metadata for every page.
- Homepage links render as a readable list until `data-field-enhanced` is set
  after successful initialization. A small inline head gate hides the fallback
  and the entire scene during startup to prevent a flash. The renderer clears
  the gate after the first intro frame, or after all settled layers are ready
  on return visits. Initialization failures clear it immediately; a four-second
  timeout reveals the fallback if the module never loads.
  Without JavaScript the fallback is visible immediately. Keep this fail-safe
  when changing startup behavior.

## Font assets

Browser font faces and preloads use the checked-in WOFF2 files. Keep their
TTF originals: `social-image.ts` loads them directly through Sharp/Pango.
To regenerate WOFF2s with FontTools and Brotli available in your tooling environment:

```sh
python -m fontTools.ttLib.woff2 compress public/fonts/Syne/Syne-VariableFont_wght.ttf
python -m fontTools.ttLib.woff2 compress public/fonts/Lora/Lora-VariableFont_wght.ttf
python -m fontTools.ttLib.woff2 compress public/fonts/Lora/Lora-Italic-VariableFont_wght.ttf
```

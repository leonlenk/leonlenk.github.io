# Loading and runtime performance audit — 2026-09-16

## Google comparison

Google's [Core Web Vitals guidance](https://developers.google.com/search/docs/appearance/core-web-vitals)
recommends LCP within 2.5 seconds, INP at most 200 ms, and CLS at most 0.1.
Passing requires all three at the [75th percentile of real visits](https://web.dev/articles/vitals),
segmented by mobile and desktop. Local measurements cannot establish that pass,
and a performance score is not an SEO ranking guarantee.

## Method

Production Astro build, isolated headless Chromium, 390 × 844 viewport at DPR 2,
4× CPU slowdown, 150 ms network latency, 200,000 bytes/s download and 93,750
bytes/s upload. Three navigations per route, HTTP cache disabled and session
storage cleared before each navigation to include the full homepage intro.
Each sample observes 8.5 seconds. Analytics requests are blocked for repeatability.
The browser process is reused, so this is not three fresh browser processes.

The harness reports FCP, LCP, maximum CLS session window, long tasks, renderer
marks, and resource transfer sizes. Resource bytes exclude the HTML document.
Long-task excess is the sum of `max(duration - 50 ms, 0)` in the observation
window: it is a diagnostic, **not Lighthouse TBT or INP**. No Lighthouse score
is fabricated. See `loading-baseline.json` and `loading-optimized.json` for raw
samples. The baseline includes the navigation improvements already present in
the working tree before this audit.

## Measured results

Medians of three samples; times in seconds, transfer in KiB (1,024 bytes).

| Route                        | FCP before → after | LCP before → after | CLS before → after | Subresources before → after |
| ---------------------------- | -----------------: | -----------------: | -----------------: | --------------------------: |
| `/`                          |        1.06 → 1.12 |        3.70 → 3.78 |      0.001 → 0.000 |               266.0 → 152.0 |
| `/art/`                      |        0.57 → 0.58 |        0.57 → 0.58 |      0.000 → 0.000 |                160.4 → 95.2 |
| `/art/learning_how_to_draw/` |        0.59 → 0.61 |        0.59 → 0.61 |      0.252 → 0.000 |               250.3 → 184.8 |

Homepage subresource transfer falls 42.9%, section transfer 40.7%, and article
transfer 26.2%. Article layout shifts are eliminated in these samples. Loading
times are effectively unchanged; homepage LCP remains above the Google target.
One optimized article sample had LCP 1.11 s, illustrating normal run variability.

Median long-task excess over the 8.5-second window also fell:

| Route           | Before | After |
| --------------- | -----: | ----: |
| Home            | 102 ms | 35 ms |
| Art section     |  36 ms | 23 ms |
| Drawing article |  40 ms | 28 ms |

These small samples are hardware-dependent diagnostics, not field responsiveness
percentiles. A separate desktop mute-button interaction under 4× CPU slowdown
recorded maximum Event Timing durations of 72–80 ms across two checks; that action is not an
INP assessment of the site.

## Changes

- Subset all three variable webfonts to Latin, common punctuation, and navigation arrows. Their
  combined size falls from 235,780 to 118,400 bytes (49.8%). Full original fonts
  remain available through non-overlapping Unicode ranges for other scripts.
  Variable weights and shaping features are retained. Licenses remain alongside
  the fonts. `scripts/subset-fonts.py` regenerates the assets using
  `fonttools[woff]==4.65.0` (then format `src/styles/global.css` with Prettier).
- Preload compact regular fonts and the homepage's visible italic quotation.
  Optional font display prevents a late download from moving already rendered
  text. On slow first visits the browser may retain system fallback typography
  until the next navigation; this is an intentional stability tradeoff.
- Reserve the portrait video's exact 474:1024 aspect ratio and use
  `preload="none"`. Playback remains user initiated; opening an article no longer
  needs video metadata. The player has no preview frame until playback.
- Round decorative SVG coordinates to 0.01 viewBox units and numeric appearance
  attributes to sensible precision, reducing HTML without removing artwork.
- Skip distance, exponential, and angular calculations for mineral grains outside
  the pointer light's radius. Clear previously lit grains when they leave range.

## Preserved animation and remaining constraint

The homepage's visibility gate, crystallization, reveal timings, skip behavior,
resolution, and cached navigation remain unchanged. The measured homepage LCP
candidate is `.shard-label`, intentionally revealed partway through the intro.
Consequently reducing downloads does **not** make its LCP meet 2.5 seconds with
these animation timings. Fully settled timing also includes the designed intro,
not just renderer construction. Meeting that homepage target would require an
explicit design decision to reveal navigation text earlier or shorten the intro.

Social-image generation uses Sharp at build time; it is not browser runtime
work. Existing article images already have lazy loading, async decoding, and
intrinsic dimensions. Real-user INP and hosting/network performance still need
production PageSpeed Insights / Search Console data after deployment.

## Reproduction

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 4390
chromium-browser --headless --remote-debugging-port=9443 --user-data-dir=/tmp/site-loading-audit about:blank
node scripts/audit-loading.mjs http://127.0.0.1:4390 http://127.0.0.1:9443 > loading.jsonl
node scripts/check-navigation.mjs http://127.0.0.1:4390 http://127.0.0.1:9443
```

The audit opens and closes its own tab. Run benchmarks alone, without concurrent
builds or other browser audits. Deployment is not part of this local audit.

## Verification

- `pnpm check`: 45 files, no errors, warnings, or hints.
- `pnpm lint`, all three existing tests, and the production build pass.
- Existing browser regressions pass: desktop/mobile pixel-identical cached
  returns, overlapped navigation at 180 ms latency, article and Back navigation,
  resize invalidation, reduced motion, and oversized canvas rebuilds.
- Inspected desktop home/article and mobile home screenshots. No mobile
  horizontal overflow; navigation links remain visible with JavaScript disabled.
- Confirmed no MP4 resource request before playback and no browser exceptions.
- Verified every subset glyph's advance metrics and each variable-weight axis
  against the original fonts.

# Navigation performance audit

Measured locally on 2026-09-16 using the production Astro build and an isolated
headless Chromium browser at 1440 × 900, device scale factor 1.5. Analytics was
blocked for repeatability. These are local measurements, not production Core Web
Vitals or a guarantee of timing on other devices.

## Findings and changes

### Returning to the homepage rebuilt finished artwork

Every client-side return recreated the crystal interiors, refraction copies,
mineral artwork, inward blur, and seam glow. The startup visibility gate waited
for the final deferred layers. Deferring the work did not eliminate its cost.

Three baseline returns produced 76–83 ms main-thread long tasks during mounting.
The finished layers were ready 205–214 ms after clicking Home. Canvas drawing was
the dominant named native operation in the CPU profile.

The renderer now retains the last completed pair of static layers across Astro
navigation. A matching return blits those layers and reveals the finished scene
immediately. Interactive lighting, links, ghost labels, and timers are remounted
normally, so the cache does not retain the previous page's links or listeners.

The cache key includes field dimensions, backing pixel ratio, nebula version,
and section identities. It retains only one scene and caps the estimated RGBA
pixel storage at 32 MiB (about 23 MiB at the measured viewport). Actual browser
memory can be higher because the browser controls canvas/GPU allocation. Larger
scenes use the existing rebuild path. A full reload also rebuilds.

| Repeat | Before: finished scene | After: cached scene drawn |
| ------ | ---------------------: | ------------------------: |
| 1      |                 205 ms |                     58 ms |
| 2      |                 212 ms |                     53 ms |
| 3      |                 214 ms |                     44 ms |

These use the renderer's marks, measured from the click. They measure drawing
completion, not when the operating system presents the pixels. Median time
fell from 212 to 53 ms, about 75%. One optimized return still recorded a 56 ms
long task; this is an improvement, not a claim that all possible jank is gone.

### Opening a shard serialized animation and navigation

The existing 400 ms expansion completed before Astro began fetching/preparing
the destination. Network and destination preparation therefore extended the wait
after the animation.

Navigation now begins when expansion starts. An Astro preparation loader barrier
waits for both destination preparation and animation completion before swapping.
The expansion's duration and appearance remain the same. The barrier is released
on teardown as well as normal completion.

In the same three local samples, preparation previously began 414–419 ms after
the click; now it begins in 8–9 ms. Local destination page-load fell from
455–466 ms to 434–446 ms. Network latency can now overlap the animation instead
of always following it; its benefit depends on the destination and connection.

## Other paths inspected

- `social-image.ts` uses Sharp at build time. It does not run during navigation
  and does not cause browser animation lag.
- The homepage already separates static artwork from pointer lighting and
  coalesces pointer events with animation frames. Removing the visual design or
  imposing an arbitrary low frame-rate cap was unnecessary for this issue.
- Astro's installed ClientRouter already enables hover prefetching. Adding a
  second general prefetch implementation would duplicate existing behavior.
- The drawing article's eight built images already use lazy loading and async
  decoding. Its video requests metadata rather than autoplaying.
- Ghost fitting, SVG mineral animation, crystal card effects, and reading-note
  layout remain possible sources of work on slower devices. The observed
  navigation bottleneck justified addressing repeated canvas construction first.
- Cold homepage construction, initial intro animation, and scenes over the cache
  budget still incur rendering work. Further investigation should profile the
  affected device/viewport before trading visual quality for lower resolution.

## Verification

`pnpm check`, `pnpm lint`, `pnpm test`, and `pnpm build` pass.

`scripts/check-navigation.mjs` exercises the production build using Chromium's
DevTools protocol, with no extra npm dependencies. It opens its own test tab and
closes it afterward. It verifies:

- Pixel-identical static canvas output after desktop and mobile round trips.
- Destination preparation overlaps expansion under 180 ms simulated network
  latency, while the swap still waits for expansion.
- Article navigation and browser Back through the section to the homepage.
- Cache invalidation when the viewport changes while away from home.
- Reduced-motion navigation.
- Oversized scenes rebuild rather than exceeding the retention budget.
- No JavaScript exceptions during these scenarios.

To reproduce, build and serve in one terminal:

```sh
pnpm build
pnpm preview --host 127.0.0.1 --port 4387
```

Launch an isolated browser in another terminal (adjust the binary for your OS):

```sh
chromium --headless --remote-debugging-port=9441 --user-data-dir=/tmp/site-perf about:blank
```

Then run:

```sh
node scripts/check-navigation.mjs http://127.0.0.1:4387 http://127.0.0.1:9441
```

The regression script verifies behavior; it intentionally does not enforce tight
wall-clock performance thresholds that would vary across machines.

// Shared nebula renderer. Draws the sky once into an offscreen canvas and
// hands the bitmap to whoever asks: the background canvas (Nebula.astro)
// and, later, the shard field, which samples it for refraction. Makes no
// DOM assumptions beyond being able to create a <canvas>.
//
// The sky is deterministic — a fixed seed through a small PRNG — so every
// visitor, every reload and every resize sees the same arrangement.

/** Colour constants, mirroring the --nebula-* tokens in global.css. */
export const NEBULA = {
  base: "#030308",
  clouds: ["#100e2a", "#071a24", "#200b24"],
  vignette: "#000000",
} as const;

/** Seed for the shared sky. Any 32-bit integer; changing it changes the sky. */
export const NEBULA_SEED = 0x5ca1ab1e;

const CLOUD_COUNT = 9;
const STAR_COUNT = 140;
const RESIZE_DEBOUNCE_MS = 150;

/**
 * mulberry32: a tiny, fast seeded PRNG. Returns a function yielding uniform
 * numbers in [0, 1). Same seed, same sequence.
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** "#rrggbb" + alpha → "rgba(r,g,b,a)" for canvas fills. */
function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff},${alpha})`;
}

/**
 * Render the nebula into a new offscreen canvas of `w*scale` × `h*scale`
 * pixels. `w` and `h` are the CSS-pixel size the bitmap will be stretched
 * to; `scale` is the backing resolution (fractions are fine — it sits
 * behind blur and glow, so half resolution is invisible and quarters the
 * cost).
 *
 * Layers, bottom to top: base fill; nine large, squashed radial-gradient
 * clouds composited with `screen`; ~140 faint stars; a radial vignette
 * to black at the edges. Cloud fills cover only the gradient's own bounds,
 * not the whole canvas.
 */
export function renderNebula(
  w: number,
  h: number,
  scale: number,
  seed: number = NEBULA_SEED,
): HTMLCanvasElement {
  const W = Math.max(1, Math.ceil(w * scale));
  const H = Math.max(1, Math.ceil(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const rand = mulberry32(seed);

  // Base.
  ctx.fillStyle = NEBULA.base;
  ctx.fillRect(0, 0, W, H);

  // Clouds. Each is a radial gradient squashed into an ellipse and rotated,
  // so the sky reads as drifting bands rather than a row of circles.
  const span = Math.max(W, H);
  ctx.globalCompositeOperation = "screen";
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const tint = NEBULA.clouds[i % NEBULA.clouds.length];
    const cx = (0.08 + rand() * 0.84) * W;
    const cy = (0.08 + rand() * 0.84) * H;
    const r = (0.22 + rand() * 0.33) * span;
    const squash = 0.5 + rand() * 0.45;
    const angle = rand() * Math.PI;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.scale(1, squash);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    gradient.addColorStop(0, rgba(tint, 0.55));
    gradient.addColorStop(0.5, rgba(tint, 0.14));
    gradient.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = gradient;
    ctx.fillRect(-r, -r, r * 2, r * 2);
    ctx.restore();
  }
  ctx.globalCompositeOperation = "source-over";

  // Stars: sub-pixel to ~1px dots at the bitmap's resolution, so they
  // soften into faint points when the bitmap is stretched to the viewport.
  for (let i = 0; i < STAR_COUNT; i++) {
    const x = rand() * W;
    const y = rand() * H;
    const radius = 0.35 + rand() * 0.75;
    const alpha = 0.06 + rand() * 0.25;
    ctx.fillStyle = `rgba(230,227,239,${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Vignette: clear in the middle, falling to near-black at the corners.
  const halfDiagonal = Math.hypot(W, H) / 2;
  const vignette = ctx.createRadialGradient(
    W / 2,
    H / 2,
    halfDiagonal * 0.42,
    W / 2,
    H / 2,
    halfDiagonal,
  );
  vignette.addColorStop(0, rgba(NEBULA.vignette, 0));
  vignette.addColorStop(1, rgba(NEBULA.vignette, 0.88));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, W, H);

  return canvas;
}

// --- Shared instance -------------------------------------------------------

/** The one nebula bitmap every consumer draws from. */
export interface SharedNebula {
  /** The rendered bitmap. Draw it stretched to `w` × `h` CSS pixels. */
  readonly canvas: HTMLCanvasElement;
  /** Viewport width in CSS pixels the bitmap was rendered for. */
  readonly w: number;
  /** Viewport height in CSS pixels the bitmap was rendered for. */
  readonly h: number;
  /** Increments on every re-render; compare to know whether to redraw. */
  readonly version: number;
}

export type NebulaListener = (nebula: SharedNebula) => void;

let shared: SharedNebula | null = null;
let notifiedVersion = 0;
let resizeTimer = 0;
let watching = false;
const listeners = new Set<NebulaListener>();

/**
 * Backing resolution for the shared bitmap: half of the (capped) device
 * pixel ratio. It sits behind blur and glow, so the loss is invisible and
 * the render costs a quarter as much.
 */
export function nebulaScale(): number {
  return Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
}

function viewport(): { w: number; h: number } {
  return { w: window.innerWidth, h: window.innerHeight };
}

function rerender(): SharedNebula {
  const { w, h } = viewport();
  shared = {
    canvas: renderNebula(w, h, nebulaScale()),
    w,
    h,
    version: (shared?.version ?? 0) + 1,
  };
  return shared;
}

function notify(): void {
  if (!shared || shared.version === notifiedVersion) return;
  notifiedVersion = shared.version;
  for (const listener of listeners) listener(shared);
}

/** Install the (single) debounced resize handler. Idempotent. */
function watch(): void {
  if (watching) return;
  watching = true;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const { w, h } = viewport();
      if (!shared || shared.w !== w || shared.h !== h) rerender();
      // Someone may already have re-rendered via getSharedNebula() during
      // the debounce window; `notify` compares versions so they still hear.
      notify();
    }, RESIZE_DEBOUNCE_MS);
  });
}

/**
 * The shared nebula for the current viewport. Rendered on first call and
 * re-rendered (debounced 150 ms) whenever the viewport size changes. Cheap
 * to call every frame — it only renders when the size is stale.
 */
export function getSharedNebula(): SharedNebula {
  watch();
  const { w, h } = viewport();
  if (shared && shared.w === w && shared.h === h) return shared;
  return rerender();
}

/**
 * Be told after the shared nebula has been re-rendered for a new viewport
 * size. Returns an unsubscribe function.
 */
export function subscribeNebula(listener: NebulaListener): () => void {
  watch();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

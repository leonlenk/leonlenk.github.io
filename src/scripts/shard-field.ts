// The home shard field. Tiles the viewport with one crystal per shard plus
// a scatter of small unlabelled filler crystals, paints them on a Canvas 2D
// layer over the persisted nebula, lights the seams near the cursor on a
// second canvas, plays a once-per-session crystallisation intro, and expands
// a clicked shard to fill the viewport before navigating to it.
//
// Rendering is layered so the expensive part — canvas shadow blur for the
// seam glow and inward bleed — is paid once per layout, never per frame:
//
//   interiorLayer  viewport-sized: veil + every cell's dark-glass interior.
//   seamLayer      viewport-sized: every settled seam, glow and hot core.
//
// Layers are built in stages so the first paint never waits on blur: the
// interior layer without its bleed goes up synchronously with cheap stand-in
// seams; the bleed and the real seam layer follow in deferred steps and
// repaint. A bounded, single-entry cache survives client-side round trips.
//
// A settled frame is two blits and never changes on pointer movement. The
// cursor light lives on `.field-light` above it: every seam edge is stored
// with its outward normal and pre-split into short segments whose ends are
// gradient stops. Each frame the edges within reach are stroked once each
// (a wide halo, a soft wash and a bright core) with a linear gradient that
// carries, per stop, distance falloff × a specular term of how squarely the
// edge faces the cursor — edges facing the light catch a glint, edges
// running toward it do not. The subtle per-shard hover tint shares that
// canvas and its dirty rect. Chimes play only on click, never on hover.
// The intro and expand paths never touch shadowBlur: interiors are revealed
// by blitting the pre-rendered layers and seams are drawn with a three-pass
// "fake glow" stroke. Settled frames need no continuous rAF loop; ghost
// typing and occasional gleams own their bounded timers.
//
// Geometry comes from src/lib/field-layout.ts (deterministic for a viewport
// size), colour from src/data/shards.ts, chimes from ./chime. The DOM lives
// in ShardField.astro. Mounts on evaluation and on `astro:page-load`, tears
// down on `astro:before-swap`, so it survives ClientRouter round trips.

import type { Cell, Layer } from "./field-types";
import { createFieldGhosts } from "./field-ghosts";
import { createFieldParticles } from "./field-particles";
import { buildGrowths, T_NUCLEATE, type Growth } from "./field-growth";
import {
  navigate,
  type TransitionBeforePreparationEvent,
} from "astro:transitions/client";
import { midpoint, shards, type Shard } from "../data/shards";
import { hexToRgb, mixHex, rgbToHsl, withAlpha } from "../lib/color";
import { paintCrystalLight } from "../lib/crystal-light";
import { LAYOUT_SEED, WIDE_MIN, layoutField } from "../lib/field-layout";
import {
  bbox,
  centroid,
  containsPoint,
  coverScale,
  hashString,
  mulberry32,
  scalePolygon,
  toClipPathPx,
  type BBox,
  type Poly,
  type Pt,
} from "../lib/geometry";
import { chimeForShard, unlockAudio } from "./chime";
import {
  NEBULA,
  STABLE_HEIGHT_SLACK,
  getSharedNebula,
  stableViewport,
  subscribeNebula,
  viewportUnits,
  type SharedNebula,
} from "./nebula";

/* ---------- constants ---------- */

if (typeof performance !== "undefined") {
  try {
    performance.mark("shardfield:eval");
  } catch {
    /* not supported */
  }
}

const SESSION_KEY = "shardfield:intro-seen";
const INTRO_CLASS = "intro-running";

/** Nebula.astro paints the sky this far past the viewport on every side;
 * the refraction copy inside each cell samples the same framing. */
const NEB_OVERSCAN = 0.02;
/** Magnification of the sky inside a cell, about its centroid. */
const REFRACT = 1.07;
/** Backing-resolution cap. The pre-rendered layers make more pointless. */
const MAX_DPR = 1.5;

/* Fillers (placement lives in field-layout.ts; this is their look). */
/** Seam colour: mix toward the nebula base by this much (0.5 → 50% colour). */
const FILLER_DIM = 0.5;
/** Fillers are the rock around the gems: pull their colour toward a cool
 * slate by this much (0 = a dimmed copy of the nearest shard, 1 = stone). */
const FILLER_DULL = 0.25;
const FILLER_STONE = "#4b4a5e";
/** Second gradient stop is sampled this far along the spectrum from the first. */
const FILLER_SPAN = 0.08;
/** Under the cursor light a filler's seam shows its hidden gem colour: the
 * same palette before the stone and nebula mixing, lifted like a labelled
 * seam. 0 lights the dull rock colour, 1 the full gem colour. */
const FILLER_REVEAL = 1;

/* Seam treatment, chosen with Leon from the prism gradient study
 * (2026-09-25). The six tunables match the study's sliders. */
/** Flow around the shard: 0 = straight-across linear gradient (edge[0] →
 * edge[1]); toward 1 each stop's colour mixes toward a conic gradient about
 * the centroid that goes out and back around the outline. */
const SEAM_FLOW = 0.31;
/** Hue range: how far each seam's palette widens toward its spectral
 * neighbours' edge stops (0 = own two stops only). */
const SEAM_HUE_RANGE = 0.07;
/** Colour bands: how many times the colour cycles around the outline. */
const SEAM_BANDS = 1;
/** Softness: a feathered body of wide, faint strokes under a thinner core. */
const SEAM_SOFTNESS = 0.52;
/** Seam width, CSS px, before softness thins the core. */
const SEAM_WIDTH = 1.3;
/** Glow: scales the outer shadowBlur halo (1 = the original 27px halo). */
const SEAM_GLOW = 0.33;
/** Supporting constants: gradient resolution, where the conic starts, and
 * the feathered body's shape (layers, spread in px at softness 1, alpha). */
const SEAM_GRADIENT_STOPS = 48;
const SEAM_CONIC_START = -Math.PI * 0.75;
const SEAM_FEATHER_LAYERS = 6;
/** Per-frame (intro, expand) seams approximate the feather with fewer. */
const SEAM_FEATHER_LAYERS_FAST = 2;
const SEAM_FEATHER_SPREAD = 9;
const SEAM_FEATHER_ALPHA = 0.12;
const SEAM_HALO_BLUR = 27;
const SEAM_ALPHA = 0.95;
/** Colour width of the core stroke once softness has thinned it. */
const SEAM_CORE_WIDTH = Math.max(0.8, SEAM_WIDTH * (1 - SEAM_SOFTNESS * 0.45));
const SEAM_CORE_ALPHA = SEAM_ALPHA * (1 - SEAM_SOFTNESS * 0.3);
const SEAM_HALO_ALPHA = SEAM_ALPHA * (1 - SEAM_SOFTNESS * 0.35);
/** The white hot line down the middle of the core. */
const SEAM_HOT = `rgba(255,255,255,${(0.28 * (1 - SEAM_SOFTNESS * 0.3)).toFixed(3)})`;

/* Prism interior. One key light from the upper left; every cell is its own
 * stone, tilted a little its own way (seeded, so it holds across reloads
 * and resizes), and reads as the end of a hexagonal crystal seen slightly
 * off-axis: an inner face (the cell shrunk toward its centroid and nudged
 * along the tilt) with one flat side face between each outer edge and its
 * inner edge. Faces are plain fills shaded only by how they meet the light
 * — no strokes between them — so the interior stays quiet. Painted into
 * the interior layer without blur. */
/** Unit vector toward the key light, screen coordinates. */
const KEY_LIGHT: Pt = { x: -0.6, y: -0.8 };
/** Per-cell tilt: the light direction rotated by up to ± this, degrees. */
const TILT_DEG = 8;
/** Per-cell shading amplitude range: a flatter or a steeper stone. */
const TILT_AMP_MIN = 0.75;
const TILT_AMP_MAX = 1.25;
/** Per-cell refraction jitter about REFRACT, so no two panes bend alike. */
const REFRACT_JITTER = 0.03;
/** Body gradient along the tilt: pale toward the light, dark away. */
const SHADE_LIGHT_ALPHA = 0.035;
const SHADE_DARK_ALPHA = 0.18;
/** Exposed stones have broader bevels; sheltered ones have a larger centre. */
const FACE_SCALE = 0.64;
const FACE_SHELTERED_SCALE = 0.76;
/** Inner face offset away from the light, × the cell's far radius, so the
 * side faces toward the light open wider (clamped to stay inside). */
const FACE_SHIFT = 0.075;
/** Cap the asymmetry on large shards while preserving it on small ones. */
const FACE_SHIFT_MAX = 12;
/** Side faces: peak alpha toward the light (white) and away (black). */
const SIDE_LIGHT_ALPHA = 0.04;
const SIDE_DARK_ALPHA = 0.1;
/** Keep grazing faces legible, including on the smallest crystals. */
const SIDE_MIN_ALPHA = 0.012;
/** Inner face: extra tint, and a well of darkness toward its centre. */
const FACE_TINT_ALPHA = 0.08;
const FACE_WELL_ALPHA = 0.12;

/* Light swell. The key light slowly brightens and ebbs, like light in a
 * cave, and the facets' contrast follows; its direction never changes.
 * Once per layout the difference between the settled prism shading and
 * the same shading at SWELL_GAIN is painted into one overlay canvas (lit
 * faces a little brighter, shadowed ones a touch deeper). The compositor
 * animates its opacity through uneven, eased keyframes on a long cycle, so
 * it breathes without a beat. Settled desktop only; with reduced motion, a
 * coarse pointer or a narrow layout it is not built. */
const SWELL_GAIN = 1.45;
/** Backing resolution of the overlay; the deltas are soft enough that a
 * lower resolution than the field's is invisible. */
const SWELL_DPR = 1;
/** Face deltas below this alpha are skipped. */
const SWELL_MIN_ALPHA = 0.002;
/** Seconds per cycle and the overlay's opacity keyframes (offset,
 * opacity): swells of different heights and lengths, never a steady beat. */
const SWELL_PERIOD_S = 83;
const SWELL_KEYS: readonly (readonly [number, number])[] = [
  [0, 0.1],
  [0.09, 0.55],
  [0.16, 0.35],
  [0.3, 1],
  [0.41, 0.2],
  [0.49, 0.3],
  [0.58, 0],
  [0.7, 0.75],
  [0.78, 0.6],
  [0.9, 0.9],
  [1, 0.1],
];

/* Cursor light. The reach (how far along the seams the light is felt) is
 * wider than the ambient bloom, which keeps a fixed pixel size. */
const LIGHT_R_WIDE = 260;
const LIGHT_R_NARROW = 190;
/** Distance falloff exponent (lower = gentler, felt further out) and a gain
 * on the seam response before the alpha clamps. */
const LIGHT_FALLOFF = 1.5;
const LIGHT_GAIN = 1.3;
/** Diffuse bloom under the light so the glass near the cursor lifts.
 * Its fixed pixel radius remains independent of the seam reach. */
const LIGHT_AMBIENT_ALPHA = 0.035;
const LIGHT_AMBIENT_R = 168;
/** Restrained coloured reflections on the bevels, under the seam light. */
const LIGHT_FACET_ALPHA = 0.16;
/** Seams are pre-split into segments no longer than this, CSS px. Each
 * edge is stroked once with a gradient whose stops sit at the segment
 * ends, so the light runs continuously along the seam. */
const SEG_MAX = 10;
/** Each segment dims by up to this much (seeded), a faint facet shimmer so
 * the segments stay just visible without breaking into blobs. */
const SEG_SHIMMER = 0.22;
/** Lit seam colour: the seam gradient lifted toward white; the core pass
 * lifts it further. */
const BRIGHT_LIFT = 0.35;
const LIGHT_CORE_LIFT = 0.65;
/** Three passes per lit edge: a wide halo, a soft wash, a core. */
const LIGHT_HALO_WIDTH = 14;
const LIGHT_HALO_ALPHA = 0.18;
const LIGHT_SOFT_WIDTH = 6.5;
const LIGHT_SOFT_ALPHA = 0.65;
const LIGHT_CORE_WIDTH = 1.6;
const LIGHT_CORE_ALPHA = 1.0;
/** Below this a stop is fully dark, and an edge with no brighter stop is
 * skipped outright. */
const LIGHT_MIN_I = 0.01;

/* Labels keep this far (CSS px) from the epigraph's text box, and this
 * much room from the cell's sides when one is lifted above it. */
const LABEL_QUOTE_MARGIN = 14;
const LABEL_SIDE_ROOM = 10;
/** Touch screens: assume the address bar can cover at least this much of
 * the large viewport when placing labels clear of the epigraph. */
const PHONE_BAR_ALLOWANCE = 90;

/* Per-shard hover, drawn on the light canvas. */
const HOVER_MS = 150;
const HOVER_FILL_ALPHA = 0.06;
const HOVER_STROKE_ALPHA = 0.28;
const HOVER_STROKE_WIDTH = 2;

/* Intro timeline, ms from start. */
const T_SETTLE = 5100;
/** Resolve the whole growth frame into the cached resting composition. */
const SETTLE_FADE_MS = 420;
const SKIP_MS = 250;

const EXPAND_MS = 400;
/** Extra tint laid over the settled interior (TINT) by the end of the
 * expand: 0.68 + 0.32 × 0.82 ≈ 0.94, the reading view's darkness. */
const EXPAND_DARKEN = 0.82;
const RESIZE_DEBOUNCE_MS = 120;
/** If no animation frame arrives within this long, a timer steps the intro
 * instead, so a throttled or starved rAF (occluded window, headless virtual
 * time) cannot stall the timeline. Cleared by every real frame. */
const WATCHDOG_MS = 120;

const TAU = Math.PI * 2;
const VEIL = "rgba(2,2,8,0.7)";
const TINT = "rgba(2,2,8,0.68)";

/* ---------- small maths ---------- */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (t: number, a: number, b: number): number =>
  clamp01((t - a) / (b - a));
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const easeOutCubic = (u: number): number => 1 - (1 - u) ** 3;
const easeInOutCubic = (u: number): number =>
  u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function rectOf(bb: BBox): Rect {
  return { x: bb.x0, y: bb.y0, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0 };
}

function padRect(r: Rect, p: number): Rect {
  return { x: r.x - p, y: r.y - p, w: r.w + 2 * p, h: r.h + 2 * p };
}

function intersectRect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return b;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w);
  const y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Startup marks for the Performance panel: eval → first frame → layers. */
function mark(name: string): void {
  try {
    performance.mark(`shardfield:${name}`);
  } catch {
    /* not supported */
  }
}

type Deferred = { kind: "idle" | "raf"; id: number };

/** Run `fn` off the critical path: an idle callback with a short timeout so
 * it still lands within a few frames, or the next frame where idle
 * callbacks are unavailable. */
function defer(fn: () => void): Deferred {
  if ("requestIdleCallback" in window)
    return {
      kind: "idle",
      id: window.requestIdleCallback(fn, { timeout: 60 }),
    };
  return { kind: "raf", id: requestAnimationFrame(fn) };
}

function cancelDeferred(d: Deferred | null): void {
  if (!d) return;
  if (d.kind === "idle") window.cancelIdleCallback(d.id);
  else cancelAnimationFrame(d.id);
}

/** "rgba(r,g,b," for a hex colour: append an alpha and ")" per use, so a
 * per-frame gradient stop costs one short concatenation. */
function rgbaPrefix(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},`;
}

/* ---------- spectrum ---------- */

/** Hue of a hex colour, with warm hues wrapped past 360 so the spectrum runs
 * teal → indigo → violet → plum → wine → ember. */
function spectrumHue(hex: string): number {
  const [h] = rgbToHsl(hexToRgb(hex));
  return h < 150 ? h + 360 : h;
}

const SPECTRUM: readonly Shard[] = [...shards].sort(
  (a, b) => spectrumHue(a.edge[0]) - spectrumHue(b.edge[0]),
);

/** Colour at `u` ∈ [0, 1] along a list of evenly spaced hex stops. */
function sampleStops(stops: readonly string[], u: number): string {
  const pos = clamp01(u) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  return mixHex(stops[i], stops[i + 1], pos - i);
}

/* ---------- seam gradients ---------- */

const CONIC_SEAMS =
  SEAM_FLOW > 0 &&
  typeof CanvasRenderingContext2D !== "undefined" &&
  "createConicGradient" in CanvasRenderingContext2D.prototype;

/** The colours a seam walks through: its own two stops, widened toward its
 * spectral neighbours' outer stops by SEAM_HUE_RANGE. */
function seamPalette(
  edge: readonly [string, string],
  prev: string,
  next: string,
): string[] {
  const r = SEAM_HUE_RANGE * 0.85;
  return [mixHex(edge[0], prev, r), edge[0], edge[1], mixHex(edge[1], next, r)];
}

/** Evenly spaced gradient colours. Linear: straight across the palette.
 * Conic: each stop mixes the straight-across colour toward one that goes
 * out and back around the outline (so the loop closes) by SEAM_FLOW. */
function seamColours(pal: readonly string[], conic: boolean): string[] {
  const out: string[] = [];
  for (let k = 0; k <= SEAM_GRADIENT_STOPS; k++) {
    const u = k / SEAM_GRADIENT_STOPS;
    const across = sampleStops(pal, u);
    if (!conic) {
      out.push(across);
      continue;
    }
    const tri = 1 - Math.abs(((u * SEAM_BANDS) % 1) * 2 - 1);
    out.push(mixHex(across, sampleStops(pal, tri), SEAM_FLOW));
  }
  return out;
}

/** Linear seam gradient axis: across the bounding box, pulled in a little
 * vertically so tall cells still show both ends. */
function seamAxis(bb: BBox): [number, number, number, number] {
  const dy = (bb.y1 - bb.y0) * 0.15;
  return [bb.x0, bb.y0 + dy, bb.x1, bb.y1 - dy];
}

/** A cell's seam gradient at full alpha: conic about `c`, or linear across
 * `bb` where conic gradients are unsupported. */
function makeSeamGradient(
  g: CanvasRenderingContext2D,
  seam: readonly string[],
  conic: boolean,
  c: Pt,
  bb: BBox,
): CanvasGradient {
  const grad = conic
    ? g.createConicGradient(SEAM_CONIC_START, c.x, c.y)
    : g.createLinearGradient(...seamAxis(bb));
  const n = seam.length - 1;
  for (let k = 0; k <= n; k++) grad.addColorStop(k / n, seam[k]);
  return grad;
}

/** The seam gradient's colour at a point on the outline. */
function seamColourAt(
  cell: Cell,
  x: number,
  y: number,
  seam: readonly string[] = cell.seam,
): string {
  if (cell.seamConic) {
    const a = Math.atan2(y - cell.c.y, x - cell.c.x) - SEAM_CONIC_START;
    return sampleStops(seam, (((a / TAU) % 1) + 1) % 1);
  }
  const [x0, y0, x1, y1] = seamAxis(cell.bb);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const t = ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy || 1);
  return sampleStops(seam, t);
}

/** The [left, right] ends of the horizontal chord of a convex polygon at
 * height `y`, or [0, 0] when the line misses it. */
function chordAt(poly: Poly, y: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((a.y <= y && b.y >= y) || (b.y <= y && a.y >= y)) {
      const x =
        a.y === b.y ? a.x : a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
      lo = Math.min(lo, x);
      hi = Math.max(hi, x);
    }
  }
  return hi > lo ? [lo, hi] : [0, 0];
}

/** Side-face fill alphas of a prism lit from (lx, ly): per outer edge of
 * `poly`, positive for white (toward the light), negative for black. */
function sideShades(
  poly: Poly,
  c: Pt,
  lx: number,
  ly: number,
  amp: number,
  keyExposure: number,
): number[] {
  const out: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const ex = q.x - p.x;
    const ey = q.y - p.y;
    const len = Math.hypot(ex, ey) || 1;
    let onx = ey / len;
    let ony = -ex / len;
    if ((c.x - p.x) * onx + (c.y - p.y) * ony > 0) {
      onx = -onx;
      ony = -ony;
    }
    const f = onx * lx + ony * ly;
    out.push(
      f > 0
        ? lerp(SIDE_MIN_ALPHA, SIDE_LIGHT_ALPHA, Math.min(1, f)) *
            amp *
            keyExposure
        : -lerp(SIDE_MIN_ALPHA, SIDE_DARK_ALPHA, Math.min(1, -f)) * amp,
    );
  }
  return out;
}

/** Feathered body passes, widest first: `count` wide faint strokes (fewer
 * layers carry proportionally more alpha, so the body keeps its weight). */
function featherPasses(count: number): { width: number; alpha: number }[] {
  const out: { width: number; alpha: number }[] = [];
  if (SEAM_SOFTNESS <= 0) return out;
  const scale = SEAM_FEATHER_LAYERS / count;
  for (let j = count; j >= 1; j--) {
    const i = j * scale;
    out.push({
      width: SEAM_WIDTH + (SEAM_SOFTNESS * SEAM_FEATHER_SPREAD * j) / count,
      alpha: (SEAM_SOFTNESS * SEAM_FEATHER_ALPHA * scale) / (0.6 + i * 0.4),
    });
  }
  return out;
}
const FEATHER = featherPasses(SEAM_FEATHER_LAYERS);
const FEATHER_FAST = featherPasses(SEAM_FEATHER_LAYERS_FAST);

/* ---------- types ---------- */

interface Hover {
  cell: Cell;
  alpha: number;
  target: number;
}

type State = "intro" | "settled" | "expanding";

// Keep only the last completed scene, without links or other DOM references.
// Two RGBA layers at 1440 × 900 × 1.5 use about 23 MiB. Large displays
// rebuild instead of retaining an unbounded amount of graphics memory.
const MAX_CACHED_LAYER_BYTES = 32 * 1024 * 1024;
let cachedLayers: {
  key: string;
  interior: Layer;
  seams: Layer;
  minerals: Cell["mineralGlints"][];
} | null = null;

/* ---------- the field ---------- */

function createField(root: HTMLElement): () => void {
  const canvasEl = root.querySelector<HTMLCanvasElement>("canvas.field-canvas");
  const ctxEl =
    canvasEl?.getContext("2d", { alpha: true, willReadFrequently: false }) ??
    null;
  const lightEl = root.querySelector<HTMLCanvasElement>("canvas.field-light");
  const mineralOverlay =
    root.querySelector<SVGSVGElement>("svg.field-minerals");
  const gleamOverlay = root.querySelector<SVGSVGElement>("svg.field-gleam");
  const gleamMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const lightCtx =
    lightEl?.getContext("2d", { alpha: true, willReadFrequently: false }) ??
    null;
  const nav = root.querySelector<HTMLElement>("nav.field-shards");
  const links = new Map<string, HTMLAnchorElement>();
  for (const a of Array.from(
    root.querySelectorAll<HTMLAnchorElement>("a.shard"),
  ))
    if (a.dataset.shard) links.set(a.dataset.shard, a);
  if (!canvasEl || !ctxEl || !nav || links.size === 0) return () => {};
  const canvas = canvasEl;
  const ctx = ctxEl;

  const coarse = matchMedia("(pointer: coarse)").matches;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const labelled = SPECTRUM.filter((s) => links.has(s.id));
  /** The cursor light and hover need a fine pointer and their own canvas. */
  const useLight = !coarse && !!lightEl && !!lightCtx;

  let w = 0;
  let h = 0;
  let dpr = 1;
  /** The field's offset in the viewport: pointer events arrive in client
   * coordinates, everything painted here is in field coordinates. */
  let rootLeft = 0;
  let rootTop = 0;
  let cells: Cell[] = [];
  let nebula: SharedNebula = getSharedNebula();
  let state: State = "settled";
  const ghosts = createFieldGhosts(
    root,
    ctx,
    reduceMotion,
    () => state === "settled",
  );
  let focused: HTMLAnchorElement | null = null;
  let suppressClicksUntil = 0;

  // Pre-rendered layers, built in stages (see buildLayers).
  let interiorLayer: Layer | null = null;
  let seamLayer: Layer | null = null;
  let pendingBuild: Deferred | null = null;
  let firstFrameMarked = false;

  // Cursor light: every seam edge as flat arrays (x,y interleaved) with its
  // stops — the ends of its ≤ SEG_MAX segments — rebuilt per layout. Per
  // frame each edge in reach is stroked once with a gradient over its stops.
  let lightR = LIGHT_R_WIDE;
  let edgeCount = 0;
  let edgeA = new Float32Array(0);
  let edgeB = new Float32Array(0);
  let edgeN = new Float32Array(0);
  /** First stop of each edge, and its segment count (stops = parts + 1). */
  let edgeStop0 = new Int32Array(0);
  let edgeParts = new Int32Array(0);
  /** Per stop: position along its edge, colour prefixes for the two passes. */
  let stopT = new Float32Array(0);
  let stopSoft: string[] = [];
  let stopCore: string[] = [];
  /** Per segment (indexed by its first stop): the seeded shimmer factor. */
  let segShimmer = new Float32Array(0);
  /** Scratch: intensity at each stop of the edge being lit. */
  let stopI = new Float32Array(0);
  /** Where the light is (pointer, or a parked focus), null when off. */
  let lightPoint: Pt | null = null;
  /** What the last light frame painted, cleared before the next. */
  let lightDirty: Rect | null = null;
  let hovers: Hover[] = [];
  let lightRaf = 0;
  let lightLast = 0;
  let lightOn = false;
  let pointerPending = false;
  let pointerX = 0;
  let pointerY = 0;
  // Intro bookkeeping.
  const particles = createFieldParticles(
    ctx,
    coarse,
    () => ({ w, h, dpr, cells }),
    cellAt,
  );
  let cellSprites: (Layer | null)[] = [];
  let introExitLayer: Layer | null = null;
  let settledEntryLayer: Layer | null = null;
  let growths: Growth[] = [];
  let raf = 0;
  let watchdog = 0;
  let clock = 0;
  let lastNow = 0;
  let skipAt = -1;
  let settledDom = false;

  // One occasional surface gleam, including unlabelled crystal fragments.
  let gleamTimer = 0;

  // Light swell overlay (see SWELL_*): created on first use, repainted per
  // layout, animated by the compositor while settled.
  const useSwell = !reduceMotion && !coarse;
  let swellWide = false;
  let swellEl: HTMLCanvasElement | null = null;
  let swellAnim: Animation | null = null;

  /** The settled prism shading scaled by SWELL_GAIN − 1: the body gradient
   * and every side face, same key light, same geometry. */
  function paintSwell(el: HTMLCanvasElement): void {
    const scale = Math.min(dpr, SWELL_DPR);
    el.width = Math.max(1, Math.round(w * scale));
    el.height = Math.max(1, Math.round(h * scale));
    const g = el.getContext("2d", { alpha: true, willReadFrequently: false });
    if (!g) return;
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.clearRect(0, 0, w, h);
    const k = SWELL_GAIN - 1;
    for (const cell of cells) {
      const { inner, face, c, lx, ly, amp } = cell;
      const r = intersectRect(rectOf(cell.bb), viewport());
      if (!r || inner.length < 3) continue;
      let pmax = -Infinity;
      let pmin = Infinity;
      for (const v of inner) {
        const p = (v.x - c.x) * lx + (v.y - c.y) * ly;
        pmax = Math.max(pmax, p);
        pmin = Math.min(pmin, p);
      }
      g.save();
      tracePoly(g, inner);
      g.clip();
      if (pmax > pmin) {
        const body = g.createLinearGradient(
          c.x + lx * pmax,
          c.y + ly * pmax,
          c.x + lx * pmin,
          c.y + ly * pmin,
        );
        body.addColorStop(
          0,
          `rgba(255,255,255,${(k * SHADE_LIGHT_ALPHA * amp * cell.keyExposure).toFixed(4)})`,
        );
        body.addColorStop(0.45, "rgba(0,0,0,0)");
        body.addColorStop(
          1,
          `rgba(0,0,0,${(k * SHADE_DARK_ALPHA * amp).toFixed(4)})`,
        );
        g.fillStyle = body;
        g.fillRect(r.x, r.y, r.w, r.h);
      }
      if (face) {
        const n = inner.length;
        for (let i = 0; i < n; i++) {
          const d = k * cell.faceShade[i];
          if (Math.abs(d) < SWELL_MIN_ALPHA) continue;
          const j = (i + 1) % n;
          g.beginPath();
          g.moveTo(inner[i].x, inner[i].y);
          g.lineTo(inner[j].x, inner[j].y);
          g.lineTo(face[j].x, face[j].y);
          g.lineTo(face[i].x, face[i].y);
          g.closePath();
          g.fillStyle =
            d > 0
              ? `rgba(255,255,255,${d.toFixed(4)})`
              : `rgba(0,0,0,${(-d).toFixed(4)})`;
          g.fill();
        }
      }
      g.restore();
    }
  }

  /** Paint the swell overlay for the current layout and set it breathing.
   * Only opacity animates, so the compositor does the work and settled
   * frames stay free of script. */
  function startSwell(): void {
    if (!useSwell || !swellWide || state !== "settled") {
      stopSwell();
      return;
    }
    if (!swellEl) {
      swellEl = document.createElement("canvas");
      swellEl.className = "field-swell";
      swellEl.setAttribute("aria-hidden", "true");
      swellEl.style.cssText =
        "position:absolute;inset:0;width:100%;height:var(--field-h,100%);pointer-events:none;opacity:0";
      canvas.after(swellEl);
    }
    paintSwell(swellEl);
    if (swellAnim) return;
    swellAnim = swellEl.animate(
      SWELL_KEYS.map(([offset, opacity]) => ({
        offset,
        opacity,
        easing: "ease-in-out",
      })),
      { duration: SWELL_PERIOD_S * 1000, iterations: Infinity },
    );
    if (document.hidden) swellAnim.pause();
  }

  function stopSwell(remove = false): void {
    swellAnim?.cancel();
    swellAnim = null;
    if (remove) {
      swellEl?.remove();
      swellEl = null;
    }
  }

  let lastGleamCell = -1;
  const gleamRandom = mulberry32(hashString(`gleam:${Date.now()}`));

  function stopGleam(): void {
    window.clearTimeout(gleamTimer);
    gleamTimer = 0;
    gleamOverlay?.replaceChildren();
  }

  function canGleam(): boolean {
    return (
      !!gleamOverlay &&
      state === "settled" &&
      !document.hidden &&
      !gleamMotion.matches
    );
  }

  function scheduleGleam(): void {
    stopGleam();
    if (!canGleam()) return;
    gleamTimer = window.setTimeout(playGleam, 9000 + gleamRandom() * 7000);
  }

  function playGleam(): void {
    gleamTimer = 0;
    if (!canGleam() || !gleamOverlay) return;
    const choices = cells
      .map((cell, index) => ({ cell, index }))
      .filter(
        ({ cell, index }) =>
          index !== lastGleamCell &&
          cell.inner.length >= 3 &&
          !!intersectRect(rectOf(cell.bb), viewport()),
      );
    const choice = choices[Math.floor(gleamRandom() * choices.length)];
    if (!choice) {
      scheduleGleam();
      return;
    }
    lastGleamCell = choice.index;
    const { cell } = choice;
    const duration = 2500 + gleamRandom() * 1000;
    const ns = "http://www.w3.org/2000/svg";
    const el = <K extends keyof SVGElementTagNameMap>(
      tag: K,
      attrs: Record<string, string> = {},
    ): SVGElementTagNameMap[K] => {
      const node = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs))
        node.setAttribute(key, value);
      return node;
    };
    const edge = el("polygon", {
      class: "gleam-edge",
      points: cell.inner.map((p) => `${p.x},${p.y}`).join(" "),
      fill: "none",
      stroke: mixHex(cell.mid, "#ffffff", 0.3),
      "stroke-width": "1.5",
      "stroke-linejoin": "round",
      style: `--gleam-duration:${duration.toFixed(0)}ms`,
    });
    gleamOverlay.setAttribute("viewBox", `0 0 ${w} ${h}`);
    gleamOverlay.replaceChildren(edge);
    // Only the perimeter brightens; CSS handles the quiet rise and fall.
    gleamTimer = window.setTimeout(scheduleGleam, duration + 80);
  }

  /* ----- layers ----- */

  function targetDpr(): number {
    return Math.min(window.devicePixelRatio || 1, MAX_DPR);
  }

  function viewport(): Rect {
    return { x: 0, y: 0, w, h };
  }

  /** Grow a rectangle to the device-pixel grid. */
  function snapRect(r: Rect): Rect {
    const x0 = Math.floor(r.x * dpr) / dpr;
    const y0 = Math.floor(r.y * dpr) / dpr;
    const x1 = Math.ceil((r.x + r.w) * dpr) / dpr;
    const y1 = Math.ceil((r.y + r.h) * dpr) / dpr;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  function makeLayer(r: Rect): Layer | null {
    const s = snapRect(r);
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(s.w * dpr));
    c.height = Math.max(1, Math.round(s.h * dpr));
    const g = c.getContext("2d", { alpha: true, willReadFrequently: false });
    if (!g) return null;
    g.setTransform(dpr, 0, 0, dpr, -s.x * dpr, -s.y * dpr);
    return { canvas: c, g, x: s.x, y: s.y, w: s.w, h: s.h };
  }

  /** Blit a whole layer onto the field canvas. */
  function blit(layer: Layer | null, alpha = 1): void {
    if (!layer || alpha <= 0) return;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.drawImage(layer.canvas, layer.x, layer.y, layer.w, layer.h);
    ctx.globalAlpha = 1;
  }

  /* ----- painting primitives (into any viewport-space context) ----- */

  function tracePoly(g: CanvasRenderingContext2D, poly: Poly): void {
    g.beginPath();
    g.moveTo(poly[0].x, poly[0].y);
    for (let i = 1; i < poly.length; i++) g.lineTo(poly[i].x, poly[i].y);
    g.closePath();
  }

  /** The cell's seam gradient for `poly`/`bb`: the cached one for its own
   * outline, or for a scaled copy when conic (the centre does not move). */
  function seamStroke(cell: Cell, poly: Poly, bb: BBox): CanvasGradient {
    return cell.seamConic || poly === cell.inner
      ? cell.seamStroke
      : makeSeamGradient(ctx, cell.seam, false, cell.c, bb);
  }

  /** Viewport point → nebula bitmap coordinates, through the cell's
   * refraction (a magnification about its centroid) and the sky's overscan
   * framing. */
  function nebulaPoint(cell: Cell, x: number, y: number): Pt {
    const c = cell.c;
    const qx = c.x + (x - c.x) / cell.refract;
    const qy = c.y + (y - c.y) / cell.refract;
    const neb = nebula.canvas;
    return {
      x: ((qx + w * NEB_OVERSCAN) / (w * (1 + 2 * NEB_OVERSCAN))) * neb.width,
      y: ((qy + h * NEB_OVERSCAN) / (h * (1 + 2 * NEB_OVERSCAN))) * neb.height,
    };
  }

  /** The refracted sky, blitting only the bitmap region under `r`. */
  function paintRefraction(
    g: CanvasRenderingContext2D,
    cell: Cell,
    r: Rect,
  ): void {
    const a = nebulaPoint(cell, r.x, r.y);
    const b = nebulaPoint(cell, r.x + r.w, r.y + r.h);
    g.drawImage(
      nebula.canvas,
      a.x,
      a.y,
      b.x - a.x,
      b.y - a.y,
      r.x,
      r.y,
      r.w,
      r.h,
    );
  }

  /** The prism: a mild gradient along the cell's own light direction so the
   * stone reads as tilted, then one flat side face per outer edge (the
   * quad between it and its inner edge, pale toward the light, dark away)
   * and the inner face, a touch deeper with a well of darkness at its
   * centre. Nothing is stroked. Expects the context clipped to `inner`. */
  function paintPrism(g: CanvasRenderingContext2D, cell: Cell, r: Rect): void {
    const { c, lx, ly, amp, inner: poly, face } = cell;
    let pmax = -Infinity;
    let pmin = Infinity;
    for (const v of poly) {
      const p = (v.x - c.x) * lx + (v.y - c.y) * ly;
      if (p > pmax) pmax = p;
      if (p < pmin) pmin = p;
    }
    if (!(pmax > pmin)) return;

    const body = g.createLinearGradient(
      c.x + lx * pmax,
      c.y + ly * pmax,
      c.x + lx * pmin,
      c.y + ly * pmin,
    );
    body.addColorStop(
      0,
      `rgba(255,255,255,${SHADE_LIGHT_ALPHA * amp * cell.keyExposure})`,
    );
    body.addColorStop(0.45, "rgba(0,0,0,0)");
    body.addColorStop(1, `rgba(0,0,0,${SHADE_DARK_ALPHA * amp})`);
    g.fillStyle = body;
    g.fillRect(r.x, r.y, r.w, r.h);

    if (!face) return;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const a = cell.faceShade[i];
      const j = (i + 1) % n;
      g.beginPath();
      g.moveTo(poly[i].x, poly[i].y);
      g.lineTo(poly[j].x, poly[j].y);
      g.lineTo(face[j].x, face[j].y);
      g.lineTo(face[i].x, face[i].y);
      g.closePath();
      g.fillStyle =
        a > 0
          ? `rgba(255,255,255,${a.toFixed(3)})`
          : `rgba(0,0,0,${(-a).toFixed(3)})`;
      g.fill();
    }
    const fc = centroid(face);
    let fr = 1;
    for (const v of face) fr = Math.max(fr, Math.hypot(v.x - fc.x, v.y - fc.y));
    tracePoly(g, face);
    g.fillStyle = `rgba(2,2,8,${FACE_TINT_ALPHA})`;
    g.fill();
    const well = g.createRadialGradient(fc.x, fc.y, 0, fc.x, fc.y, fr);
    well.addColorStop(0, `rgba(0,0,0,${FACE_WELL_ALPHA})`);
    well.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = well;
    g.fill();
  }

  /** Dark glass: refraction, tint and the prism. No blur, so it is cheap
   * enough for the first paint; the bleed is added by paintBleed later. */
  function paintInterior(g: CanvasRenderingContext2D, cell: Cell): void {
    const r = intersectRect(rectOf(cell.bb), viewport());
    if (!r) return;
    g.save();
    tracePoly(g, cell.inner);
    g.clip();
    paintRefraction(g, cell, r);
    g.fillStyle = TINT;
    g.fillRect(r.x, r.y, r.w, r.h);
    // The whole face owns a seeded mineral distribution, not a repeated motif.
    if (cell.shard) {
      const seed = hashString(`mineral:${cell.shard.id}`);
      const minerals = paintCrystalLight(g, cell.inner, seed, cell.mid, 0.35);
      cell.mineralGlints = minerals.flecks.map((fleck, i) => {
        const c = centroid(fleck.poly);
        const first = fleck.poly[0];
        const last = fleck.poly[2];
        return {
          poly: fleck.poly,
          x: c.x,
          y: c.y,
          radius: Math.max(
            ...fleck.poly.map((p) => Math.hypot(p.x - c.x, p.y - c.y)),
          ),
          axis: Math.atan2(last.y - first.y, last.x - first.x) + i * 0.73,
          gain: 0.4 + fleck.opacity * 0.6,
        };
      });
    }
    paintPrism(g, cell, r);
    g.restore();
  }

  /** Build a sparse overlay from the actual grain polygons after painting.
   * Only opacity animates in CSS; gradients and geometry remain static. */
  function buildMineralOverlay(): void {
    if (!mineralOverlay) return;
    const ns = "http://www.w3.org/2000/svg";
    const element = <K extends keyof SVGElementTagNameMap>(
      name: K,
      attributes: Record<string, string> = {},
    ): SVGElementTagNameMap[K] => {
      const node = document.createElementNS(ns, name);
      for (const [key, value] of Object.entries(attributes))
        node.setAttribute(key, value);
      return node;
    };
    const points = (poly: Poly): string =>
      poly.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
    const defs = element("defs");
    const fragment = document.createDocumentFragment();
    fragment.append(defs);
    mineralOverlay.setAttribute("viewBox", `0 0 ${w} ${h}`);
    for (const cell of cells) {
      if (!cell.shard || !cell.mineralGlints?.length) continue;
      const id = `field-mineral-${cell.shard.id}`;
      const rng = mulberry32(hashString(`idle-mineral:${cell.shard.id}`));
      const clip = element("clipPath", { id: `${id}-clip` });
      clip.append(element("polygon", { points: points(cell.inner) }));
      const gradient = element("radialGradient", { id: `${id}-glow` });
      gradient.append(
        element("stop", {
          offset: "0",
          "stop-color": cell.edge[0],
          "stop-opacity": "0.65",
        }),
        element("stop", {
          offset: "0.3",
          "stop-color": cell.mid,
          "stop-opacity": "0.29",
        }),
        element("stop", {
          offset: "1",
          "stop-color": cell.mid,
          "stop-opacity": "0",
        }),
      );
      defs.append(clip, gradient);
      const surface = element("g", { "clip-path": `url(#${id}-clip)` });
      // The larger inclusions carry the glow; fine mineral dust stays still.
      const grains = [...cell.mineralGlints]
        .filter((grain) => grain.radius >= 0.5)
        .sort((a, b) => b.radius - a.radius)
        .slice(0, 8);
      for (const grain of grains) {
        const period = 7 + rng() * 6;
        const group = element("g", {
          class: "mineral-breath",
          style: `--mineral-period:${period.toFixed(2)}s;--mineral-delay:${(-rng() * period).toFixed(2)}s`,
        });
        group.append(
          element("circle", {
            cx: grain.x.toFixed(2),
            cy: grain.y.toFixed(2),
            r: (grain.radius * 4).toFixed(2),
            fill: `url(#${id}-glow)`,
          }),
          element("polygon", {
            points: points(grain.poly),
            fill: mixHex(cell.edge[0], "#ffffff", 0.58),
            "fill-opacity": Math.min(1, 1.15 * grain.gain).toFixed(3),
          }),
        );
        surface.append(group);
      }
      fragment.append(surface);
    }
    mineralOverlay.replaceChildren(fragment);
  }

  /** The blurred inward bleed, clipped to the cell so only the inner half
   * of the stroke survives. Blur is fine here — deferred layer work. */
  function paintBleed(g: CanvasRenderingContext2D, cell: Cell): void {
    g.save();
    tracePoly(g, cell.inner);
    g.clip();
    g.shadowColor = withAlpha(cell.mid, 0.5);
    g.shadowBlur = 51 * dpr;
    g.lineWidth = 3;
    g.strokeStyle = cell.seamStroke;
    g.globalAlpha = 0.27;
    g.stroke();
    g.restore();
  }

  /** The settled seam: a thin stroke carrying the (blurred) outer halo, the
   * feathered body of wide faint strokes, the core, and the white hot line.
   * All of it lands in the offscreen seam layer, once per layout. */
  function paintSeam(g: CanvasRenderingContext2D, cell: Cell): void {
    g.save();
    g.lineJoin = "round";
    tracePoly(g, cell.inner);
    g.strokeStyle = cell.seamStroke;
    if (SEAM_GLOW > 0) {
      g.shadowColor = withAlpha(cell.mid, SEAM_ALPHA * Math.min(1, SEAM_GLOW));
      g.shadowBlur = SEAM_HALO_BLUR * SEAM_GLOW * dpr;
    }
    g.lineWidth = SEAM_WIDTH;
    g.globalAlpha = SEAM_HALO_ALPHA;
    g.stroke();
    g.shadowBlur = 0;
    g.shadowColor = "transparent";
    for (const pass of FEATHER) {
      g.lineWidth = pass.width;
      g.globalAlpha = pass.alpha;
      g.stroke();
    }
    g.lineWidth = SEAM_CORE_WIDTH;
    g.globalAlpha = SEAM_CORE_ALPHA;
    g.stroke();
    g.globalAlpha = 1;
    g.lineWidth = 0.7;
    g.strokeStyle = SEAM_HOT;
    g.stroke();
    g.restore();
  }

  /** Per-frame seam without blur: a flat halo standing in for the shadow
   * (scaled by SEAM_GLOW), a cheaper feathered body, then the core. `k`
   * scales the widths (2 → 1 as the seam snaps hard), `boost` widens and
   * brightens the outer passes for the expand animation. */
  function paintFakeSeam(
    g: CanvasRenderingContext2D,
    cell: Cell,
    poly: Poly,
    bb: BBox,
    alpha: number,
    k: number,
    core: number,
    boost: number,
  ): void {
    if (alpha <= 0) return;
    g.save();
    g.lineJoin = "round";
    tracePoly(g, poly);
    g.strokeStyle = withAlpha(
      cell.mid,
      Math.min(1, 0.12 * SEAM_GLOW * alpha * (1 + boost)),
    );
    g.lineWidth = 10 * k * (1 + boost);
    g.stroke();
    g.strokeStyle = withAlpha(
      cell.mid,
      Math.min(1, 0.3 * SEAM_GLOW * alpha * (1 + 0.5 * boost)),
    );
    g.lineWidth = 4 * k * (1 + 0.5 * boost);
    g.stroke();
    const a = Math.min(1, alpha);
    g.strokeStyle = seamStroke(cell, poly, bb);
    for (const pass of FEATHER_FAST) {
      g.lineWidth = pass.width * k;
      g.globalAlpha = a * pass.alpha;
      g.stroke();
    }
    g.globalAlpha = a * SEAM_CORE_ALPHA;
    g.lineWidth = SEAM_CORE_WIDTH * k;
    g.stroke();
    if (core > 0) {
      g.globalAlpha = Math.min(1, core);
      g.strokeStyle = SEAM_HOT;
      g.lineWidth = 0.7;
      g.stroke();
    }
    g.restore();
  }

  /** Stage 1, synchronous: the interior layer without its bleed. Stages 2a
   * and 2b (the blur work) are deferred, one idle slot each, and repaint
   * when they land. */
  function buildLayers(): void {
    cancelDeferred(pendingBuild);
    pendingBuild = null;
    if (cachedLayers?.key === layerKey()) {
      interiorLayer = cachedLayers.interior;
      seamLayer = cachedLayers.seams;
      cells.forEach((cell, i) => {
        cell.mineralGlints = cachedLayers!.minerals[i];
      });
      buildMineralOverlay();
      if (state === "intro") buildCellSprites();
      mark("layers-cached");
      return;
    }
    cachedLayers = null;
    interiorLayer = makeLayer(viewport());
    if (interiorLayer) {
      const g = interiorLayer.g;
      g.fillStyle = VEIL;
      g.fillRect(0, 0, w, h);
      for (const cell of cells) paintInterior(g, cell);
    }
    buildMineralOverlay();
    seamLayer = null;
    pendingBuild = defer(buildBleed);
  }

  /** Stage 2a: the blurred bleed into the interior layer. */
  function buildBleed(): void {
    pendingBuild = null;
    if (interiorLayer)
      for (const cell of cells) paintBleed(interiorLayer.g, cell);
    pendingBuild = defer(buildSeams);
  }

  /** Stage 2b: the real seam layer, and the intro's reveal sprites if the
   * intro is running. */
  function buildSeams(): void {
    pendingBuild = null;
    seamLayer = makeLayer(viewport());
    if (seamLayer) for (const cell of cells) paintSeam(seamLayer.g, cell);
    if (
      interiorLayer &&
      seamLayer &&
      interiorLayer.canvas.width * interiorLayer.canvas.height * 8 <=
        MAX_CACHED_LAYER_BYTES
    ) {
      cachedLayers = {
        key: layerKey(),
        interior: interiorLayer,
        seams: seamLayer,
        minerals: cells.map((cell) => cell.mineralGlints),
      };
    }
    if (state === "intro") buildCellSprites();
    else if (state === "settled") {
      drawSettled();
      // Return visits need the completed layers, not the provisional fill.
      revealField();
    }
    mark("layers-ready");
  }

  function layerKey(): string {
    return `${w}:${h}:${dpr}:${nebula.version}:${labelled.map((s) => s.id).join(",")}`;
  }

  /* ----- layout ----- */

  function readRootOffset(): void {
    const rect = root.getBoundingClientRect();
    rootLeft = rect.left;
    rootTop = rect.top;
  }

  function layout(): void {
    w = root.clientWidth;
    h = root.clientHeight;
    readRootOffset();
    dpr = targetDpr();
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Every layer is sized to the layout, not to the live box, so a skipped
    // height-only resize never stretches them.
    canvas.style.removeProperty("height");
    root.style.setProperty("--field-h", `${h}px`);
    if (lightEl && lightCtx) {
      lightEl.width = canvas.width;
      lightEl.height = canvas.height;
      lightCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lightDirty = null;
      hovers = [];
      lightPoint = null;
    }

    const widths = labelWidths();
    const field = layoutField(w, h, labelled.length, {}, widths);
    const quote = epigraphBox();
    lightR = field.wide ? LIGHT_R_WIDE : LIGHT_R_NARROW;
    swellWide = field.wide;
    const stops = labelled.flatMap((s) => [s.edge[0], s.edge[1]]);
    const dim = (hex: string): string =>
      mixHex(
        mixHex(hex, FILLER_STONE, FILLER_DULL * 0.8),
        NEBULA.base,
        FILLER_DIM,
      );
    // Fillers take their colour from nearby shards because the spectrum
    // isn't a simple function of x (see spectrumOrder).
    const anchors = field.cells
      .filter((fc) => fc.labelled >= 0)
      .map((fc) => ({ i: fc.labelled, c: centroid(fc.inner) }));
    const spectralU = (p: Pt): number => {
      const n = labelled.length;
      const near = anchors
        .map((a) => ({ i: a.i, d: Math.hypot(a.c.x - p.x, a.c.y - p.y) }))
        .sort((a, b) => a.d - b.d);
      if (!near.length) return p.x / w;
      const [a, b] = near;
      const ua = (a.i + 0.5) / n;
      // Between two spectral neighbours, blend toward the midpoint at the
      // boundary; beside a non-neighbour, keep the nearest shard's hue.
      if (!b || Math.abs(a.i - b.i) !== 1) return ua;
      const ub = (b.i + 0.5) / n;
      return ua + (ub - ua) * (a.d / (a.d + b.d || 1));
    };

    cells = field.cells.map((fc, index) => {
      const inner = fc.inner;
      const c = centroid(inner);
      let far = 0;
      for (const p of inner)
        far = Math.max(far, Math.hypot(p.x - c.x, p.y - c.y));
      const shard = fc.labelled >= 0 ? labelled[fc.labelled] : null;
      const link = shard ? (links.get(shard.id) ?? null) : null;
      // The stone: its tilt, steepness, refraction and prism, all seeded so
      // the same stone looks the same on every visit and after a resize.
      const rng = mulberry32(
        hashString(shard ? shard.id : `filler:${index}`) ^ LAYOUT_SEED,
      );
      const tilt = ((rng() * 2 - 1) * TILT_DEG * Math.PI) / 180;
      const cs = Math.cos(tilt);
      const sn = Math.sin(tilt);
      const amp = lerp(TILT_AMP_MIN, TILT_AMP_MAX, rng());
      const refract = REFRACT * (1 + (rng() * 2 - 1) * REFRACT_JITTER);
      // Stable, selective shelter suggests overlapping depths without
      // adding cast-shadow shapes to the otherwise minimal field.
      const shelterRng = mulberry32(
        hashString(`shelter:${shard ? shard.id : `filler:${index}`}`),
      );
      const shelter = Math.max(0, (shelterRng() - 0.45) / 0.55);
      const keyExposure = 1 - shelter * 0.35;
      const faceScale = lerp(FACE_SCALE, FACE_SHELTERED_SCALE, shelter);
      const lx = KEY_LIGHT.x * cs - KEY_LIGHT.y * sn;
      const ly = KEY_LIGHT.x * sn + KEY_LIGHT.y * cs;
      // Sheltered stones have proportionally narrower bevels, still offset
      // away from the same key light as their more exposed neighbours.
      let face: Poly | null = null;
      const faceShade: number[] = [];
      if (inner.length >= 3) {
        const base = scalePolygon(inner, faceScale, c);
        const room = scalePolygon(inner, 0.94, c);
        let shift =
          Math.min(far * FACE_SHIFT, FACE_SHIFT_MAX) *
          ((1 - faceScale) / (1 - FACE_SCALE));
        face = base;
        for (let k = 0; k < 6; k++) {
          const moved = base.map((p) => ({
            x: p.x - lx * shift,
            y: p.y - ly * shift,
          }));
          if (moved.every((p) => containsPoint(room, p))) {
            face = moved;
            break;
          }
          shift *= 0.5;
        }
        faceShade.push(...sideShades(inner, c, lx, ly, amp, keyExposure));
      }
      const u = shard ? 0 : spectralU(c);
      const edge: readonly [string, string] = shard
        ? shard.edge
        : [
            dim(sampleStops(stops, u - FILLER_SPAN / 2)),
            dim(sampleStops(stops, u + FILLER_SPAN / 2)),
          ];
      // Spectral neighbours' outer stops, for the seam's widened palette.
      // A filler looks one shard's width further along the spectrum.
      const reach = FILLER_SPAN / 2 + 2 / Math.max(1, stops.length - 1);
      const prev = shard
        ? labelled[Math.max(0, fc.labelled - 1)].edge[0]
        : dim(sampleStops(stops, u - reach));
      const next = shard
        ? labelled[Math.min(labelled.length - 1, fc.labelled + 1)].edge[1]
        : dim(sampleStops(stops, u + reach));
      const seam = seamColours(seamPalette(edge, prev, next), CONIC_SEAMS);
      // The filler's hidden gem: the same palette without the dulling,
      // blended by FILLER_REVEAL, for the cursor light only.
      let litSeam: readonly string[] | undefined;
      if (!shard) {
        const gem = seamColours(
          seamPalette(
            [
              sampleStops(stops, u - FILLER_SPAN / 2),
              sampleStops(stops, u + FILLER_SPAN / 2),
            ],
            sampleStops(stops, u - reach),
            sampleStops(stops, u + reach),
          ),
          CONIC_SEAMS,
        );
        litSeam = gem.map((c, k) => mixHex(seam[k], c, FILLER_REVEAL));
      }
      const bb = bbox(inner);
      if (link) {
        const at = labelAnchor(inner, c, widths[fc.labelled], quote);
        link.style.clipPath = toClipPathPx(inner);
        link.style.setProperty("--cx", `${at.x.toFixed(1)}px`);
        link.style.setProperty("--cy", `${at.y.toFixed(1)}px`);
      }
      const mid = midpoint(edge[0], edge[1]);
      return {
        shard,
        link,
        edge,
        mid,
        seam,
        seamConic: CONIC_SEAMS,
        seamStroke: makeSeamGradient(ctx, seam, CONIC_SEAMS, c, bb),
        litSeam,
        lifted: mixHex(mid, "#ffffff", BRIGHT_LIFT),
        poly: fc.poly,
        inner,
        c,
        bb,
        far,
        lx,
        ly,
        amp,
        keyExposure,
        refract,
        face,
        faceShade,
      };
    });
    if (useLight) buildSeamEdges();
    ghosts.place(
      field,
      w,
      h,
      quote && {
        x0: quote.x + LABEL_QUOTE_MARGIN,
        y0: quote.y + LABEL_QUOTE_MARGIN,
        x1: quote.x + quote.w - LABEL_QUOTE_MARGIN,
        y1: quote.y + quote.h - LABEL_QUOTE_MARGIN,
      },
    );
  }

  /** The epigraph's box in field coordinates, grown by LABEL_QUOTE_MARGIN,
   * or null when hidden or outside the field. One layout read per layout.
   * The quote rides the visible bottom, so on phones it is placed where it
   * sits with the address bar showing (the small viewport): the highest it
   * ever gets, and the same whichever state the bar is in right now. */
  function epigraphBox(): Rect | null {
    const el = root.querySelector<HTMLElement>(".field-epigraph");
    if (!el) return null;
    const q = el.getBoundingClientRect();
    if (q.width === 0 || q.height === 0) return null;
    // Its distance from the visible bottom is fixed; put that bottom at the
    // small viewport, and on touch screens at least an address bar's height
    // above the large one, in case the units under-report the bar.
    let lift = 0;
    if (stableViewport()) {
      const { svh, lvh } = viewportUnits();
      const low = coarse ? Math.min(svh, lvh - PHONE_BAR_ALLOWANCE) : svh;
      lift = Math.max(0, window.innerHeight - low);
    }
    const y0 = q.top - lift - rootTop - LABEL_QUOTE_MARGIN;
    const y1 = q.bottom - lift - rootTop + LABEL_QUOTE_MARGIN;
    if (y0 >= h || y1 <= 0) return null;
    return {
      x: q.left - rootLeft - LABEL_QUOTE_MARGIN,
      y: y0,
      w: q.width + 2 * LABEL_QUOTE_MARGIN,
      h: y1 - y0,
    };
  }

  /** Where a label sits: the centroid, unless its box would touch the
   * epigraph; then the lowest row above the quote where the cell is still
   * wide enough for it. */
  function labelAnchor(
    poly: Poly,
    c: Pt,
    width: number | undefined,
    quote: Rect | null,
  ): Pt {
    if (!quote || width === undefined) return c;
    const half = labelHeight() / 2;
    const hits = (x: number, y: number): boolean =>
      x + width / 2 > quote.x &&
      x - width / 2 < quote.x + quote.w &&
      y + half > quote.y &&
      y - half < quote.y + quote.h;
    if (!hits(c.x, c.y)) return c;
    const top = Math.min(...poly.map((p) => p.y)) + half;
    for (let y = Math.min(c.y, quote.y - half); y >= top; y -= 4) {
      const [lo, hi] = chordAt(poly, y);
      const room = hi - lo - width - LABEL_SIDE_ROOM * 2;
      if (room < 0) continue;
      const x = Math.min(
        Math.max(c.x, lo + LABEL_SIDE_ROOM + width / 2),
        hi - LABEL_SIDE_ROOM - width / 2,
      );
      if (!hits(x, y)) return { x, y };
    }
    return c;
  }

  /** Estimated rendered width of each shard label (site order = spectrum
   * order), so the layout can ease its stretch until every label fits:
   * uppercase display face at clamp(13px, 1.25vw + 6px, 20px) with 0.14em
   * tracking, about 0.82em per character. */
  function labelWidths(): number[] {
    const size = Math.min(20, Math.max(13, 0.0125 * w + 6));
    return labelled.map((s) => s.label.length * 0.82 * size);
  }

  /** The label line box, from the same font-size clamp. */
  function labelHeight(): number {
    return Math.min(20, Math.max(13, 0.0125 * w + 6)) * 1.2;
  }

  /** Every seam edge with its outward normal, split into ≤ SEG_MAX segments
   * whose ends are the gradient stops; each stop carries its colour along
   * the seam gradient, lifted toward white, and each segment its shimmer. */
  function buildSeamEdges(): void {
    const ax: number[] = [];
    const bx: number[] = [];
    const nx: number[] = [];
    const stop0: number[] = [];
    const parts: number[] = [];
    const ts: number[] = [];
    const soft: string[] = [];
    const core: string[] = [];
    const shimmer: number[] = [];
    const rng = mulberry32(hashString("shard-field:shimmer"));
    for (const cell of cells) {
      const poly = cell.inner;
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const p = poly[i];
        const q = poly[(i + 1) % n];
        const ex = q.x - p.x;
        const ey = q.y - p.y;
        const len = Math.hypot(ex, ey);
        if (len < 1) continue;
        let onx = ey / len;
        let ony = -ex / len;
        if ((cell.c.x - p.x) * onx + (cell.c.y - p.y) * ony > 0) {
          onx = -onx;
          ony = -ony;
        }
        const count = Math.max(1, Math.ceil(len / SEG_MAX));
        ax.push(p.x, p.y);
        bx.push(q.x, q.y);
        nx.push(onx, ony);
        stop0.push(ts.length);
        parts.push(count);
        for (let k = 0; k <= count; k++) {
          const t = k / count;
          const sx = p.x + ex * t;
          const sy = p.y + ey * t;
          ts.push(t);
          const lifted = mixHex(
            seamColourAt(cell, sx, sy, cell.litSeam),
            "#ffffff",
            BRIGHT_LIFT,
          );
          soft.push(rgbaPrefix(lifted));
          core.push(rgbaPrefix(mixHex(lifted, "#ffffff", LIGHT_CORE_LIFT)));
          shimmer.push(1 - SEG_SHIMMER * rng());
        }
      }
    }
    edgeCount = parts.length;
    edgeA = Float32Array.from(ax);
    edgeB = Float32Array.from(bx);
    edgeN = Float32Array.from(nx);
    edgeStop0 = Int32Array.from(stop0);
    edgeParts = Int32Array.from(parts);
    stopT = Float32Array.from(ts);
    stopSoft = soft;
    stopCore = core;
    segShimmer = Float32Array.from(shimmer);
    stopI = new Float32Array(ts.length);
  }

  function cellAt(x: number, y: number): number {
    const p = { x, y };
    for (let i = 0; i < cells.length; i++)
      if (containsPoint(cells[i].poly, p)) return i;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < cells.length; i++) {
      const d = Math.hypot(cells[i].c.x - x, cells[i].c.y - y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  function cellOf(link: HTMLAnchorElement | null): Cell | undefined {
    return link ? cells.find((c) => c.link === link) : undefined;
  }

  /* ----- settled frame ----- */

  /** Until the real seam layer lands, cheap fake-glow seams stand in. */
  function drawSettled(alpha = 1): void {
    ctx.clearRect(0, 0, w, h);
    blit(interiorLayer, alpha);
    if (seamLayer) blit(seamLayer, alpha);
    else
      for (const cell of cells)
        paintFakeSeam(ctx, cell, cell.inner, cell.bb, alpha, 1, alpha, 0);
  }

  /* ----- cursor light and hover (the light canvas) ----- */

  /** Light at (x, y): a diffuse ambient bloom, then every seam edge within R.
   * The intensity — distance falloff × a specular term of how squarely the
   * edge faces the cursor — is sampled at each stop and carried in a
   * gradient along the edge, so it runs continuously; each segment's
   * shimmer factor puts a faint step at the stops. Three strokes per lit
   * edge: a wide halo, a soft wash and a bright core. Round caps only ever
   * land at polygon vertices, where the seam turns anyway. */
  function drawLightAt(x: number, y: number): void {
    const g = lightCtx;
    if (!g) return;
    const R = lightR;
    const ar = LIGHT_AMBIENT_R;
    const ambient = g.createRadialGradient(x, y, 0, x, y, ar);
    ambient.addColorStop(0, `rgba(255,255,255,${LIGHT_AMBIENT_ALPHA})`);
    // A broad, low-contrast centre fades into a long transparent tail;
    // the separate edge strokes below retain their full illumination.
    ambient.addColorStop(0.2, `rgba(255,255,255,${LIGHT_AMBIENT_ALPHA * 0.8})`);
    ambient.addColorStop(
      0.45,
      `rgba(255,255,255,${LIGHT_AMBIENT_ALPHA * 0.35})`,
    );
    ambient.addColorStop(
      0.7,
      `rgba(255,255,255,${LIGHT_AMBIENT_ALPHA * 0.08})`,
    );
    ambient.addColorStop(
      0.9,
      `rgba(255,255,255,${LIGHT_AMBIENT_ALPHA * 0.008})`,
    );
    ambient.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = ambient;
    g.fillRect(x - ar, y - ar, 2 * ar, 2 * ar);

    const R2 = R * R;
    g.lineCap = "round";
    for (let e = 0; e < edgeCount; e++) {
      const ax = edgeA[2 * e];
      const ay = edgeA[2 * e + 1];
      const ex = edgeB[2 * e] - ax;
      const ey = edgeB[2 * e + 1] - ay;
      // Reject edges whose nearest point is out of reach.
      const u = clamp01(((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey));
      const qx = x - (ax + ex * u);
      const qy = y - (ay + ey * u);
      if (qx * qx + qy * qy > R2) continue;
      const nx = edgeN[2 * e];
      const ny = edgeN[2 * e + 1];
      const s0 = edgeStop0[e];
      const parts = edgeParts[e];
      let any = false;
      for (let k = 0; k <= parts; k++) {
        const t = stopT[s0 + k];
        const lx = x - (ax + ex * t);
        const ly = y - (ay + ey * t);
        const d = Math.sqrt(lx * lx + ly * ly);
        let intensity = 0;
        if (d < R && d > 0) {
          const f = (1 - d / R) ** LIGHT_FALLOFF;
          const c = Math.abs((nx * lx + ny * ly) / d);
          const c2 = c * c;
          intensity = Math.min(
            1,
            LIGHT_GAIN * f * (0.4 * c + 0.7 * c2 * c2 * c2),
          );
          if (intensity < LIGHT_MIN_I) intensity = 0;
          else any = true;
        }
        stopI[s0 + k] = intensity;
      }
      if (!any) continue;
      const bx = ax + ex;
      const by = ay + ey;
      const soft = g.createLinearGradient(ax, ay, bx, by);
      const core = g.createLinearGradient(ax, ay, bx, by);
      for (let k = 0; k <= parts; k++) {
        const s = s0 + k;
        const t = stopT[s];
        const intensity = stopI[s];
        // Two stops per interior point: the end of the previous segment,
        // then the start of the next, so each segment keeps its own shimmer.
        if (k > 0) {
          const a = (intensity * segShimmer[s - 1]).toFixed(3);
          soft.addColorStop(t, `${stopSoft[s]}${a})`);
          core.addColorStop(t, `${stopCore[s]}${a})`);
        }
        if (k < parts) {
          const a = (intensity * segShimmer[s]).toFixed(3);
          soft.addColorStop(t, `${stopSoft[s]}${a})`);
          core.addColorStop(t, `${stopCore[s]}${a})`);
        }
      }
      g.beginPath();
      g.moveTo(ax, ay);
      g.lineTo(bx, by);
      g.strokeStyle = soft;
      g.lineWidth = LIGHT_HALO_WIDTH;
      g.globalAlpha = LIGHT_HALO_ALPHA;
      g.stroke();
      g.lineWidth = LIGHT_SOFT_WIDTH;
      g.globalAlpha = LIGHT_SOFT_ALPHA;
      g.stroke();
      g.strokeStyle = core;
      g.lineWidth = LIGHT_CORE_WIDTH;
      g.globalAlpha = LIGHT_CORE_ALPHA;
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  /** The same raised pointer light illuminates every bevel. Colour follows
   * the stone's palette; orientation controls how much each plane catches.
   * Radial fills end inside lightR so the existing dirty rectangle clears
   * the reflection completely when the pointer moves or leaves. */
  function drawFacetLight(x: number, y: number): void {
    const g = lightCtx;
    if (!g) return;
    const reach = lightR;
    const height = reach * 0.45;
    g.save();
    for (const cell of cells) {
      const { inner, face, c, bb } = cell;
      if (
        !face ||
        x + reach < bb.x0 ||
        x - reach > bb.x1 ||
        y + reach < bb.y0 ||
        y - reach > bb.y1
      )
        continue;
      for (let i = 0; i < inner.length; i++) {
        const j = (i + 1) % inner.length;
        const p = inner[i];
        const q = inner[j];
        const mx = (p.x + q.x + face[i].x + face[j].x) / 4;
        const my = (p.y + q.y + face[i].y + face[j].y) / 4;
        const length = Math.hypot(q.x - p.x, q.y - p.y) || 1;
        let nx = (q.y - p.y) / length;
        let ny = -(q.x - p.x) / length;
        if ((c.x - p.x) * nx + (c.y - p.y) * ny > 0) {
          nx = -nx;
          ny = -ny;
        }
        const dx = x - mx;
        const dy = y - my;
        const facing = Math.max(
          0,
          (nx * dx + ny * dy + height) /
            (Math.SQRT2 * Math.hypot(dx, dy, height)),
        );
        const alpha = LIGHT_FACET_ALPHA * facing * cell.amp;
        if (alpha < 0.003) continue;
        const colour = mixHex(cell.mid, cell.lifted, facing * 0.5);
        const glow = g.createRadialGradient(x, y, 0, x, y, reach);
        glow.addColorStop(0, withAlpha(colour, alpha));
        glow.addColorStop(0.4, withAlpha(colour, alpha * 0.5));
        glow.addColorStop(1, withAlpha(colour, 0));
        tracePoly(g, [p, q, face[j], face[i]]);
        g.fillStyle = glow;
        g.fill();
      }
    }
    g.restore();
  }

  /** Mineral faces briefly catch the moving light at their own angle.
   * No clock or extra animation loop: still light produces a still reflection. */
  function drawMineralGlints(x: number, y: number): void {
    if (!lightCtx || reduceMotion) return;
    const g = lightCtx;
    const reach = Math.min(lightR, 160);
    g.save();
    for (const cell of cells) {
      if (!cell.mineralGlints?.length) continue;
      g.save();
      tracePoly(g, cell.inner);
      g.clip();
      for (const grain of cell.mineralGlints) {
        const dx = x - grain.x;
        const dy = y - grain.y;
        const distance = Math.hypot(dx, dy);
        if (distance >= reach) continue;
        const reflection = Math.pow(
          Math.abs(Math.cos(Math.atan2(dy, dx) - grain.axis)),
          18,
        );
        const contact = Math.max(0, 1 - distance / 28) ** 1.2;
        const intensity =
          Math.max(contact, reflection * (1 - distance / reach) ** 1.3) *
          grain.gain;
        if (intensity < 0.04) continue;
        const r = Math.min(13, 3 + grain.radius * 2.5);
        const halo = g.createRadialGradient(
          grain.x,
          grain.y,
          0,
          grain.x,
          grain.y,
          r,
        );
        halo.addColorStop(0, withAlpha(cell.lifted, intensity * 0.45));
        halo.addColorStop(1, withAlpha(cell.lifted, 0));
        g.fillStyle = halo;
        g.fillRect(grain.x - r, grain.y - r, r * 2, r * 2);
        tracePoly(g, grain.poly);
        g.fillStyle = `rgba(255,250,255,${intensity * 0.9})`;
        g.fill();
      }
      g.restore();
    }
    g.restore();
  }

  /** One frame of the light canvas: clear what the last frame painted, then
   * the hover tints and the light, tracking the new dirty rect. */
  function renderLight(): void {
    const g = lightCtx;
    if (!g) return;
    if (lightDirty)
      g.clearRect(lightDirty.x, lightDirty.y, lightDirty.w, lightDirty.h);
    let dirty: Rect | null = null;
    for (const hv of hovers) {
      if (hv.alpha <= 0) continue;
      const cell = hv.cell;
      g.save();
      tracePoly(g, cell.inner);
      g.globalAlpha = HOVER_FILL_ALPHA * hv.alpha;
      g.fillStyle = cell.mid;
      g.fill();
      g.globalAlpha = HOVER_STROKE_ALPHA * hv.alpha;
      g.lineJoin = "round";
      g.lineWidth = HOVER_STROKE_WIDTH;
      g.strokeStyle = cell.lifted;
      g.stroke();
      g.restore();
      dirty = unionRect(
        dirty,
        padRect(rectOf(cell.bb), HOVER_STROKE_WIDTH + 2),
      );
    }
    if (lightPoint) {
      drawFacetLight(lightPoint.x, lightPoint.y);
      drawLightAt(lightPoint.x, lightPoint.y);
      drawMineralGlints(lightPoint.x, lightPoint.y);
      // A stop just inside R ramps to the next stop up to SEG_MAX past it,
      // and the halo stroke reaches half its width beyond that.
      const pad = lightR + SEG_MAX + LIGHT_HALO_WIDTH + 2;
      dirty = unionRect(dirty, {
        x: lightPoint.x - pad,
        y: lightPoint.y - pad,
        w: 2 * pad,
        h: 2 * pad,
      });
    }
    lightDirty = dirty ? snapRect(dirty) : null;
    ghosts.boost(lightPoint, lightR);
  }

  function clearLight(): void {
    cancelAnimationFrame(lightRaf);
    lightRaf = 0;
    pointerPending = false;
    lightPoint = null;
    hovers = [];
    if (lightCtx && lightDirty)
      lightCtx.clearRect(
        lightDirty.x,
        lightDirty.y,
        lightDirty.w,
        lightDirty.h,
      );
    lightDirty = null;
    ghosts.boost(lightPoint, lightR);
  }

  function scheduleLight(): void {
    if (lightRaf) return;
    lightLast = performance.now();
    lightRaf = requestAnimationFrame(lightFrame);
  }

  /** Coalesces pointer moves to one draw per frame and steps the hover
   * tweens; keeps itself alive only while a tween is running. */
  function lightFrame(now: number): void {
    lightRaf = 0;
    const dt = Math.max(0, now - lightLast);
    lightLast = now;
    let active = false;
    for (const hv of hovers) {
      if (hv.alpha === hv.target) continue;
      const step = dt / HOVER_MS;
      hv.alpha =
        hv.target > hv.alpha
          ? Math.min(hv.target, hv.alpha + step)
          : Math.max(hv.target, hv.alpha - step);
      if (hv.alpha !== hv.target) active = true;
    }
    let moved = false;
    if (pointerPending) {
      pointerPending = false;
      lightPoint = { x: pointerX, y: pointerY };
      moved = true;
    }
    renderLight();
    if (moved) showLight();
    hovers = hovers.filter((hv) => hv.alpha > 0 || hv.target > 0);
    if (active) lightRaf = requestAnimationFrame(lightFrame);
  }

  function onPointerMove(e: PointerEvent): void {
    if (state !== "settled") return;
    pointerX = e.clientX - rootLeft;
    pointerY = e.clientY - rootTop;
    pointerPending = true;
    scheduleLight();
  }

  /* The light canvas fades rather than cuts: CSS transitions its opacity
   * (ShardField.astro). Hiding keeps the last frame in place under the
   * fade and drops it once the transition ends; showing draws the new
   * position first, then raises the opacity, so a re-entry elsewhere
   * never flashes the old spot. No timers: transitionend does the rest. */
  let lightShown = false;

  function showLight(): void {
    if (lightShown || !lightEl) return;
    lightShown = true;
    lightEl.style.opacity = "1";
  }

  function fadeLight(): void {
    pointerPending = false;
    if (!lightShown || !lightEl) return;
    lightShown = false;
    lightEl.style.opacity = "0";
    if (reduceMotion) dropLight();
  }

  /** The fade has finished: forget the light and clear its pixels. */
  function dropLight(): void {
    if (lightShown) return;
    lightPoint = null;
    if (state === "settled") renderLight();
    else clearLight();
  }

  function onLightFaded(e: TransitionEvent): void {
    if (e.propertyName === "opacity") dropLight();
  }

  function onPointerLeaveField(): void {
    fadeLight();
  }

  function setHover(cell: Cell, on: boolean): void {
    if (!useLight || !cell.link || state !== "settled") return;
    let hv = hovers.find((h) => h.cell === cell);
    if (!hv) {
      if (!on) return;
      hv = { cell, alpha: 0, target: 0 };
      hovers.push(hv);
    }
    hv.target = on ? 1 : 0;
    if (reduceMotion) {
      hv.alpha = hv.target;
      renderLight();
      hovers = hovers.filter((h) => h.alpha > 0 || h.target > 0);
      return;
    }
    scheduleLight();
  }

  /** Keyboard focus parks the light on the focused cell so it stays visible. */
  function parkLightOnFocus(): void {
    if (!useLight || state !== "settled") return;
    const cell = cellOf(focused);
    if (!cell) return;
    lightPoint = { x: cell.c.x, y: cell.c.y };
    renderLight();
    showLight();
  }

  function enableLight(): void {
    if (!useLight || lightOn) return;
    lightOn = true;
    readRootOffset();
    lightShown = false;
    if (lightEl) lightEl.style.opacity = "0";
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerleave", onPointerLeaveField);
    lightEl?.addEventListener("transitionend", onLightFaded);
    window.addEventListener("blur", fadeLight);
  }

  function disableLight(): void {
    if (!lightOn) return;
    lightOn = false;
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", onPointerLeaveField);
    lightEl?.removeEventListener("transitionend", onLightFaded);
    window.removeEventListener("blur", fadeLight);
    lightShown = false;
    clearLight();
  }

  /* ----- intro ----- */

  /** One cell's finished dark-glass interior: a bbox copy of the interior
   * layer masked to the cell polygon, so nothing is repainted. */
  function cellSprite(cell: Cell): Layer | null {
    const src = interiorLayer;
    const r = src && intersectRect(rectOf(cell.bb), viewport());
    const layer = r ? makeLayer(r) : null;
    if (!layer || !src) return null;
    const g = layer.g;
    g.drawImage(
      src.canvas,
      (layer.x - src.x) * dpr,
      (layer.y - src.y) * dpr,
      layer.w * dpr,
      layer.h * dpr,
      layer.x,
      layer.y,
      layer.w,
      layer.h,
    );
    g.globalCompositeOperation = "destination-in";
    tracePoly(g, cell.inner);
    g.fillStyle = "#000";
    g.fill();
    g.globalCompositeOperation = "source-over";
    return layer;
  }

  /** Cache the finished interiors and distinct, stable growth habits. */
  function buildCellSprites(): void {
    cellSprites = cells.map(cellSprite);
    growths = buildGrowths(cells);
  }

  function introFrame(t: number, dt: number): void {
    ctx.clearRect(0, 0, w, h);
    // Darken the gaps gradually while individual facets take shape.
    ctx.globalAlpha = ramp(t, T_NUCLEATE, 1800);
    ctx.fillStyle = VEIL;
    ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;

    cells.forEach((cell, i) => {
      const sprite = cellSprites[i];
      const growth = growths[i];
      if (!sprite || !growth) return;
      const u = ramp(t, growth.start, growth.start + growth.duration);
      if (u <= 0) return;
      if (u >= 1) {
        blit(sprite);
      } else {
        const rx = growth.radius * growth.stretch * u ** growth.rateX;
        const ry = growth.radius * u ** growth.rateY;
        for (let j = 0; j < 6; j++) {
          const angle = (j * TAU) / 6;
          const x = Math.cos(angle) * rx;
          const y = Math.sin(angle) * ry;
          growth.face[j].x = growth.seed.x + x * growth.cs - y * growth.sn;
          growth.face[j].y = growth.seed.y + x * growth.sn + y * growth.cs;
        }
        ctx.save();
        tracePoly(ctx, cell.inner);
        ctx.clip();
        ctx.save();
        tracePoly(ctx, growth.face);
        ctx.clip();
        blit(sprite, ramp(u, 0, 0.08));
        ctx.restore();
        // Two leading facets catch light. Wide translucent strokes provide
        // a small halo without filters, gradients, or polygon intersections.
        ctx.beginPath();
        ctx.moveTo(growth.face[5].x, growth.face[5].y);
        ctx.lineTo(growth.face[0].x, growth.face[0].y);
        ctx.lineTo(growth.face[1].x, growth.face[1].y);
        const glint = Math.sin(Math.PI * u);
        ctx.strokeStyle = cell.mid;
        ctx.globalAlpha = glint * 0.045;
        ctx.lineWidth = 5;
        ctx.stroke();
        ctx.strokeStyle = cell.edge[0];
        ctx.globalAlpha = glint * 0.32;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
      // Labels emerge in place as their own face finishes forming.
      if (cell.link) {
        const label = ramp(
          t,
          growth.start + growth.duration * 0.88,
          growth.start + growth.duration + 240,
        );
        cell.link.style.setProperty("--growth-label", label.toFixed(3));
      }
      // Each boundary resolves on its own clock after the crystal spreads.
      const seam = ramp(
        t,
        growth.start + growth.duration * 0.78,
        growth.start + growth.duration + 180,
      );
      if (seam > 0)
        paintFakeSeam(ctx, cell, cell.inner, cell.bb, seam, 1, seam, 0);
    });
    particles.update(t, dt);
    particles.draw(t, 1, T_SETTLE);
  }

  function captureIntroHandoff(): void {
    introExitLayer = makeLayer(viewport());
    introExitLayer?.g.drawImage(canvas, 0, 0, w, h);
    // An early skip can arrive before deferred layer preparation. Finish
    // that work once so the fade always targets the actual resting frame.
    if (!seamLayer) {
      cancelDeferred(pendingBuild);
      buildLayers();
      if (!seamLayer) {
        cancelDeferred(pendingBuild);
        buildBleed();
        cancelDeferred(pendingBuild);
        buildSeams();
      }
    }
    drawSettled();
    settledEntryLayer = makeLayer(viewport());
    settledEntryLayer?.g.drawImage(canvas, 0, 0, w, h);
  }

  function drawIntroHandoff(u: number): void {
    if (!introExitLayer || !settledEntryLayer) {
      drawSettled();
      return;
    }
    ctx.clearRect(0, 0, w, h);
    blit(introExitLayer, 1 - u);
    ctx.save();
    // Add premultiplied pixels, rather than source-over blending two
    // translucent canvases (which would produce a dark pulse midway).
    ctx.globalCompositeOperation = "lighter";
    blit(settledEntryLayer, u);
    ctx.restore();
  }

  function revealField(): void {
    if (root.isConnected) delete document.documentElement.dataset.fieldPending;
  }

  function schedule(): void {
    if (document.hidden) return;
    raf = requestAnimationFrame(frame);
    watchdog = window.setTimeout(frame, WATCHDOG_MS);
  }

  function unschedule(): void {
    cancelAnimationFrame(raf);
    window.clearTimeout(watchdog);
    raf = 0;
    watchdog = 0;
  }

  /** One intro step. The clock accumulates elapsed time between steps (and
   * pauses with the tab), so it never jumps after a hidden stretch. */
  function frame(): void {
    unschedule();
    const now = performance.now();
    const dt = Math.max(0, now - lastNow);
    lastNow = now;
    clock += dt;
    if (!firstFrameMarked) {
      firstFrameMarked = true;
      mark("first-frame");
    }

    if (skipAt >= 0) {
      const u = ramp(clock, skipAt, skipAt + SKIP_MS);
      drawIntroHandoff(easeOutCubic(u));
      if (u >= 1) {
        finishIntro();
        return;
      }
    } else {
      if (clock < T_SETTLE) introFrame(clock, dt);
      if (!settledDom && clock >= T_SETTLE) {
        introFrame(T_SETTLE, dt);
        captureIntroHandoff();
        settledDom = true;
        settle();
      }
      if (clock >= T_SETTLE)
        drawIntroHandoff(
          easeOutCubic(ramp(clock, T_SETTLE, T_SETTLE + SETTLE_FADE_MS)),
        );
      if (clock >= T_SETTLE + SETTLE_FADE_MS) {
        finishIntro();
        return;
      }
    }
    // Reveal only after drawing the first animation frame. The head gate
    // also holds back chrome, the quotation, and the nebula until now.
    revealField();
    schedule();
  }

  function settle(): void {
    root.dataset.state = "settled";
    document.documentElement.classList.remove(INTRO_CLASS);
  }

  function finishIntro(): void {
    unschedule();
    particles.clear();
    cellSprites = [];
    introExitLayer = null;
    settledEntryLayer = null;
    growths = [];
    root.removeAttribute("data-intro-animation");
    state = "settled";
    settle();
    document.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("pointerdown", onPointerDown);
    drawSettled();
    revealField();
    enableLight();
    parkLightOnFocus();
    scheduleGleam();
    startSwell();
  }

  function skip(): void {
    if (state !== "intro" || skipAt >= 0) return;
    skipAt = clock;
    captureIntroHandoff();
    suppressClicksUntil = performance.now() + SKIP_MS + 400;
    settledDom = true;
    settle();
  }

  function onPointerDown(): void {
    unlockAudio();
    skip();
  }

  function onKeyDown(e: KeyboardEvent): void {
    unlockAudio();
    if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
      if (state === "intro") e.preventDefault();
      skip();
    }
  }

  function onVisibility(): void {
    scheduleGleam();
    if (swellAnim) {
      if (document.hidden) swellAnim.pause();
      else swellAnim.play();
    }
    ghosts.pause();
    if (state !== "intro") return;
    if (document.hidden) unschedule();
    else if (!raf) {
      lastNow = performance.now();
      schedule();
    }
  }

  function shouldPlayIntro(): boolean {
    if (reduceMotion) return false;
    try {
      return sessionStorage.getItem(SESSION_KEY) === null;
    } catch {
      return false;
    }
  }

  function startIntro(): void {
    stopGleam();
    state = "intro";
    root.dataset.state = "intro";
    root.setAttribute("data-intro-animation", "");
    for (const link of links.values())
      link.style.setProperty("--growth-label", "0");
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      // Storage unavailable: the intro still plays this once.
    }
    document.documentElement.classList.add(INTRO_CLASS);
    root.classList.add("is-live");
    particles.spawn();
    // Build the cached layers off the critical path before growth begins.
    cancelDeferred(pendingBuild);
    pendingBuild = defer(buildLayers);
    clock = 0;
    lastNow = performance.now();
    document.addEventListener("keydown", onKeyDown);
    root.addEventListener("pointerdown", onPointerDown);
    schedule();
  }

  let liveTimer = 0;
  function settleImmediately(): void {
    state = "settled";
    settle();
    buildLayers();
    drawSettled();
    if (seamLayer) revealField();
    if (!firstFrameMarked) {
      firstFrameMarked = true;
      mark("first-frame");
    }
    enableLight();
    scheduleGleam();
    startSwell();
    // Labels are already visible; enable their transitions one frame later so
    // nothing animates on a return visit.
    liveTimer = requestAnimationFrame(() => {
      liveTimer = requestAnimationFrame(() => root.classList.add("is-live"));
    });
  }

  /* ----- expand → navigate ----- */

  function go(href: string): void {
    try {
      void navigate(href).catch(() => {
        location.href = href;
      });
    } catch {
      location.href = href;
    }
  }

  /** The chosen cell's finished interior, cut from the interior layer at
   * click time; the expand scales this one bitmap about the centroid, so
   * the prism zooms with the stone and no frame repaints it. */
  let expandSprite: Layer | null = null;
  let finishExpansion: (() => void) | null = null;
  let expansionReady: Promise<void> | null = null;

  // Fetch and prepare the destination while the crystal grows. The swap
  // still waits for the final frame, preserving the existing transition.
  function prepareNavigation(event: TransitionBeforePreparationEvent): void {
    if (!expansionReady) return;
    const ready = expansionReady;
    const load = event.loader;
    event.loader = async () => {
      await Promise.all([load(), ready]);
    };
  }

  /** One expand frame: veil, the rest of the field fading for 300 ms, the
   * cell sprite scaled about its centroid, one clipped fill darkening the
   * stone toward the reading view, and the seam (no blur). */
  function drawExpandFrame(
    cell: Cell,
    u: number,
    ms: number,
    scale: number,
  ): void {
    const e = easeInOutCubic(u);
    const s = lerp(1, scale, e);
    const others = 1 - ramp(ms, 0, 300);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = VEIL;
    ctx.fillRect(0, 0, w, h);
    if (others > 0) {
      blit(interiorLayer, others);
      blit(seamLayer, others);
    }
    const { c } = cell;
    const poly = scalePolygon(cell.inner, s, c);
    const bb = bbox(poly);
    const sp = expandSprite;
    if (sp)
      ctx.drawImage(
        sp.canvas,
        c.x + (sp.x - c.x) * s,
        c.y + (sp.y - c.y) * s,
        sp.w * s,
        sp.h * s,
      );
    const r = e > 0 ? intersectRect(rectOf(bb), viewport()) : null;
    if (r) {
      ctx.save();
      tracePoly(ctx, poly);
      ctx.clip();
      ctx.fillStyle = `rgba(${Math.round(lerp(2, 5, e))},${Math.round(lerp(2, 5, e))},${Math.round(lerp(8, 16, e))},${(EXPAND_DARKEN * e).toFixed(3)})`;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }
    paintFakeSeam(ctx, cell, poly, bb, 1, 1.4, 1, e);
  }

  function expand(cell: Cell): void {
    if (!cell.link || !cell.shard) return;
    stopGleam();
    const href = cell.link.href;
    chimeForShard(cell.shard.id, { velocity: 0.9, length: 1.4 });
    ghosts.clearTimers();
    stopSwell();
    state = "expanding";
    root.dataset.state = "expanding";
    cell.link.classList.add("is-active");
    // The light fades with the rest of the field; hovers stop here.
    cancelAnimationFrame(lightRaf);
    lightRaf = 0;
    hovers = [];
    fadeLight();
    if (reduceMotion) {
      go(href);
      return;
    }
    expandSprite = cellSprite(cell);
    // Keep the resting geometry, but enlarge the drawing surface to include
    // the mobile quote area before calculating the viewport-covering scale.
    h = Math.max(h, window.innerHeight - rootTop);
    canvas.style.height = `${h}px`;
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawExpandFrame(cell, 0, 0, 1);
    const scale =
      coverScale(cell.inner, cell.c, { x0: 0, y0: 0, x1: w, y1: h }) * 1.03;
    const t0 = performance.now();
    const step = (now: number): void => {
      const ms = now - t0;
      const u = clamp01(ms / EXPAND_MS);
      drawExpandFrame(cell, u, ms, scale);
      if (u < 1) raf = requestAnimationFrame(step);
      else {
        raf = 0;
        expandSprite = null;
        finishExpansion?.();
        finishExpansion = null;
        expansionReady = null;
      }
    };
    raf = requestAnimationFrame(step);
    expansionReady = new Promise<void>((resolve) => {
      finishExpansion = resolve;
    });
    go(href);
  }

  /* ----- events ----- */

  function onGesture(): void {
    unlockAudio();
  }

  function onClick(e: MouseEvent): void {
    if (!root.hasAttribute("data-field-enhanced")) return;
    const target = e.target as Element | null;
    const link = target?.closest?.("a.shard") as HTMLAnchorElement | null;
    if (!link) return;
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    if (state !== "settled" || performance.now() < suppressClicksUntil) return;
    const cell = cellOf(link);
    if (cell) expand(cell);
  }

  /** Hover: the subtle tint only. Chimes play on click (see expand), never
   * on hover or focus — a pointer sweeping the field stays silent. */
  function onPointerEnter(e: Event): void {
    if (state !== "settled" || coarse) return;
    const cell = cellOf(e.currentTarget as HTMLAnchorElement);
    if (!cell?.shard) return;
    setHover(cell, true);
  }

  function onPointerLeave(e: Event): void {
    const cell = cellOf(e.currentTarget as HTMLAnchorElement);
    if (cell) setHover(cell, false);
  }

  function onFocusIn(e: FocusEvent): void {
    const link = (e.target as Element | null)?.closest?.("a.shard");
    focused =
      link instanceof HTMLAnchorElement && link.matches(":focus-visible")
        ? link
        : null;
    if (!focused || state !== "settled") return;
    parkLightOnFocus();
  }

  function onFocusOut(): void {
    if (!focused) return;
    focused = null;
    if (useLight && state === "settled") fadeLight();
  }

  /** Full rebuild: geometry, DOM positions, layers; then whatever the current
   * state needs on top. */
  function relayout(): void {
    if (state === "expanding") return;
    stopGleam();
    layout();
    cellSprites = [];
    buildLayers();
    if (state === "intro") {
      particles.remap();
    } else if (state === "settled") {
      drawSettled();
      parkLightOnFocus();
      scheduleGleam();
      startSwell();
    }
  }

  let resizeTimer = 0;
  function onResize(): void {
    const nw = root.clientWidth;
    const nh = root.clientHeight;
    if (nw === w && nh === h && targetDpr() === dpr) return;
    // Phones: a height-only change within the slack is the address bar (or
    // emulation of it). The field keeps its geometry and the bar overlaps
    // its foot; only rotation, split view or a real resize re-lays out.
    if (
      (coarse || w < WIDE_MIN) &&
      nw === w &&
      targetDpr() === dpr &&
      Math.abs(nh - h) <= STABLE_HEIGHT_SLACK * h
    )
      return;
    nebula = getSharedNebula();
    relayout();
  }

  const observer = new ResizeObserver(() => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(onResize, RESIZE_DEBOUNCE_MS);
  });

  const unsubscribe = subscribeNebula((next) => {
    if (next === nebula) return;
    nebula = next;
    relayout();
  });

  /* ----- mount ----- */

  layout();
  root.addEventListener("click", onClick);
  root.addEventListener("pointerdown", onGesture);
  root.addEventListener("keydown", onGesture);
  root.addEventListener("touchstart", onGesture, { passive: true });
  nav.addEventListener("focusin", onFocusIn);
  nav.addEventListener("focusout", onFocusOut);
  for (const link of links.values()) {
    link.addEventListener("pointerenter", onPointerEnter);
    link.addEventListener("pointerleave", onPointerLeave);
  }
  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("astro:before-preparation", prepareNavigation);
  observer.observe(root);
  gleamMotion.addEventListener("change", scheduleGleam);

  if (shouldPlayIntro()) startIntro();
  else settleImmediately();

  root.setAttribute("data-field-enhanced", "");

  return () => {
    root.removeAttribute("data-field-enhanced");
    stopGleam();
    gleamMotion.removeEventListener("change", scheduleGleam);
    unschedule();
    finishExpansion?.();
    finishExpansion = null;
    expansionReady = null;
    cancelDeferred(pendingBuild);
    pendingBuild = null;
    disableLight();
    clearLight();
    stopSwell(true);
    cancelAnimationFrame(liveTimer);
    window.clearTimeout(resizeTimer);
    observer.disconnect();
    ghosts.destroy();
    mineralOverlay?.replaceChildren();
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("astro:before-preparation", prepareNavigation);
    document.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("click", onClick);
    root.removeEventListener("pointerdown", onGesture);
    root.removeEventListener("keydown", onGesture);
    root.removeEventListener("touchstart", onGesture);
    nav.removeEventListener("focusin", onFocusIn);
    nav.removeEventListener("focusout", onFocusOut);
    for (const link of links.values()) {
      link.removeEventListener("pointerenter", onPointerEnter);
      link.removeEventListener("pointerleave", onPointerLeave);
    }
    particles.clear();
    cellSprites = [];
    expandSprite = null;
    interiorLayer = null;
    seamLayer = null;
  };
}

/* ---------- lifecycle ---------- */

let destroy: (() => void) | null = null;

function mount(): void {
  const root = document.querySelector<HTMLElement>("main.field");
  if (!root || root.dataset.fieldReady === "1") return;
  root.dataset.fieldReady = "1";
  destroy?.();
  try {
    destroy = createField(root);
  } catch (error) {
    root.removeAttribute("data-field-enhanced");
    document.documentElement.classList.remove(INTRO_CLASS);
    console.error("Shard field initialization failed", error);
  } finally {
    // Success is revealed by the renderer, after an actual frame is ready.
    // Unsupported or failed initialization reveals the fallback immediately.
    if (!root.hasAttribute("data-field-enhanced"))
      delete document.documentElement.dataset.fieldPending;
  }
}

function unmount(): void {
  destroy?.();
  destroy = null;
}

document.addEventListener("astro:page-load", mount);
document.addEventListener("astro:before-swap", unmount);
mount();

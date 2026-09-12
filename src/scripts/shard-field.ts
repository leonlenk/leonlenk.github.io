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
// repaint. Nothing is cached across reloads.
//
// A settled frame is two blits and never changes on pointer movement. The
// cursor light lives on `.field-light` above it: every seam is pre-split into
// short segments with an outward normal, and each frame the segments within
// reach are lit by a specular term of how squarely they face the cursor —
// edges facing the light catch a glint, edges running toward it do not
// (a wide halo, a soft wash and a bright core per segment).
// The subtle per-shard hover tint shares that canvas and its dirty rect.
// The intro and expand paths never touch shadowBlur: interiors are revealed
// by blitting the pre-rendered layers and seams are drawn with a three-pass
// "fake glow" stroke. Idle is zero rAF and zero timers.
//
// Geometry comes from src/lib/field-layout.ts (deterministic for a viewport
// size), colour from src/data/shards.ts, chimes from ./chime. The DOM lives
// in ShardField.astro. Mounts on evaluation and on `astro:page-load`, tears
// down on `astro:before-swap`, so it survives ClientRouter round trips.

import { navigate } from "astro:transitions/client";
import { midpoint, shards, type Shard } from "../data/shards";
import { hexToRgb, mixHex, rgbToHsl, withAlpha } from "../lib/color";
import { ghostPhrases, ghostWords } from "../data/ghosts";
import {
  LAYOUT_SEED,
  assignGhosts,
  layoutField,
  type FieldLayout,
} from "../lib/field-layout";
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
import { chimeCluster, chimeForShard, unlockAudio } from "./chime";
import {
  NEBULA,
  getSharedNebula,
  subscribeNebula,
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
const FLICKER_SEED = hashString("shard-field:flicker");

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
/** Second gradient stop is sampled this far along the spectrum from the first. */
const FILLER_SPAN = 0.08;
/** Particle density of a filler relative to a labelled cell. */
const FILLER_DENSITY = 0.6;

/* Cursor light. */
const LIGHT_R_WIDE = 300;
const LIGHT_R_NARROW = 210;
/** Faint disc under the light so the glass near the cursor lifts. */
const LIGHT_AMBIENT_ALPHA = 0.07;
const LIGHT_AMBIENT_R = 0.8;
/** Seams are pre-split into segments no longer than this, CSS px. */
const SEG_MAX = 24;
/** Lit segment colour: the seam gradient lifted toward white; the core pass
 * lifts it further. */
const BRIGHT_LIFT = 0.35;
const LIGHT_CORE_LIFT = 0.65;
/** Three passes per lit segment: a very wide halo, a soft wash, a core. */
const LIGHT_HALO_WIDTH = 22;
const LIGHT_HALO_ALPHA = 0.18;
const LIGHT_SOFT_WIDTH = 10;
const LIGHT_SOFT_ALPHA = 0.65;
const LIGHT_CORE_WIDTH = 1.9;
const LIGHT_CORE_ALPHA = 1.0;
/** Ghost text near the light brightens up to this multiple of its alpha. */
const GHOST_BOOST = 2.4;
/** Ghosts change daily but hold still for a visit: the seed is the day
 * number at module evaluation, which survives client-side navigations. */
const GHOST_SEED = Math.floor(Date.now() / 864e5);

/* Per-shard hover, drawn on the light canvas. */
const HOVER_MS = 150;
const HOVER_FILL_ALPHA = 0.06;
const HOVER_STROKE_ALPHA = 0.28;
const HOVER_STROKE_WIDTH = 2;

/* Intro timeline, ms from start. */
const T_NUCLEATE = 1300;
const T_CRYSTALLISE = 2700;
const T_CORE = 3100;
const T_SETTLE = 3400;
/** Cross-fade from the fake-glow seams to the pre-rendered seam layer. */
const SEAM_FADE_MS = 150;
const NUCLEUS_MS = 500;
const FLICKER_MS = 220;
const SKIP_MS = 250;

const EXPAND_MS = 520;
const RESIZE_DEBOUNCE_MS = 120;
/** If no animation frame arrives within this long, a timer steps the intro
 * instead, so a throttled or starved rAF (occluded window, headless virtual
 * time) cannot stall the timeline. Cleared by every real frame. */
const WATCHDOG_MS = 120;

const SPRITE_RADII = [8, 12, 16] as const;
const TONES = 3;

const TAU = Math.PI * 2;
const VEIL = "rgba(2,2,8,0.55)";
const TINT = "rgba(2,2,8,0.42)";

/* ---------- small maths ---------- */

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (t: number, a: number, b: number): number =>
  clamp01((t - a) / (b - a));
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
const easeOutCubic = (u: number): number => 1 - (1 - u) ** 3;
const easeInQuad = (u: number): number => u * u;
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

/** "rgb(r,g,b)" for a hex colour, so per-frame alpha can go via globalAlpha. */
function rgbString(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgb(${r},${g},${b})`;
}

/** Deterministic ±0.3 alpha jitter, keyed on frame time so it replays alike. */
function flicker(t: number, i: number): number {
  const r = mulberry32(FLICKER_SEED + i * 7919 + Math.floor(t / 16))();
  return (r * 2 - 1) * 0.3;
}

/** Closest point on the boundary of `poly` to `p`. */
function nearestOnBoundary(poly: Poly, p: Pt): Pt {
  let best = poly[0];
  let bestD = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby || 1;
    const u = clamp01(((p.x - a.x) * abx + (p.y - a.y) * aby) / len2);
    const qx = a.x + abx * u;
    const qy = a.y + aby * u;
    const d = (p.x - qx) ** 2 + (p.y - qy) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { x: qx, y: qy };
    }
  }
  return best;
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

/* ---------- types ---------- */

/** An offscreen bitmap covering a viewport-space rectangle, snapped to the
 * device-pixel grid so every blit is a 1:1 copy. Its context is set up so
 * drawing in viewport coordinates lands in the right place. */
interface Layer {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell {
  /** null for a filler. */
  shard: Shard | null;
  /** null for a filler. */
  link: HTMLAnchorElement | null;
  edge: readonly [string, string];
  mid: string;
  /** `mid` lifted toward white: the hover stroke. */
  lifted: string;
  /** Full power cell (tiles the viewport with its neighbours). */
  poly: Poly;
  /** Cell inset by half the gap: the visible crystal. */
  inner: Poly;
  c: Pt;
  bb: BBox;
  /** Distance from the centroid to the farthest vertex of `inner`. */
  far: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  cell: number;
  tone: number;
  size: number;
  /** Target on the cell's inner boundary. */
  tx: number;
  ty: number;
  /** Position when travel began. */
  sx: number;
  sy: number;
  start: number;
  dur: number;
  phase: number;
  alpha: number;
  moving: boolean;
  arrived: boolean;
}

interface Hover {
  cell: Cell;
  alpha: number;
  target: number;
}

type State = "intro" | "settled" | "expanding";

/* ---------- the field ---------- */

function createField(root: HTMLElement): () => void {
  const canvasEl = root.querySelector<HTMLCanvasElement>("canvas.field-canvas");
  const ctxEl =
    canvasEl?.getContext("2d", { alpha: true, willReadFrequently: false }) ??
    null;
  const lightEl = root.querySelector<HTMLCanvasElement>("canvas.field-light");
  const lightCtx =
    lightEl?.getContext("2d", { alpha: true, willReadFrequently: false }) ??
    null;
  const nav = root.querySelector<HTMLElement>("nav.field-shards");
  const ghostHost = root.querySelector<HTMLElement>(".field-ghosts");
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
  let cells: Cell[] = [];
  let nebula: SharedNebula = getSharedNebula();
  let state: State = "settled";
  let focused: HTMLAnchorElement | null = null;
  let suppressClicksUntil = 0;

  // Pre-rendered layers, built in stages (see buildLayers).
  let interiorLayer: Layer | null = null;
  let seamLayer: Layer | null = null;
  let pendingBuild: Deferred | null = null;
  let firstFrameMarked = false;

  // Cursor light: seam segments as flat arrays (x,y interleaved), rebuilt per
  // layout; scratch arrays for the segments lit this frame.
  let lightR = LIGHT_R_WIDE;
  let segCount = 0;
  let segA = new Float32Array(0);
  let segB = new Float32Array(0);
  let segM = new Float32Array(0);
  let segN = new Float32Array(0);
  let segSoft: string[] = [];
  let segCore: string[] = [];
  let litIndex = new Int32Array(0);
  let litI = new Float32Array(0);
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
  /** Placed ghost labels with cached centroids for the light's boost. */
  let ghosts: { el: HTMLElement; x: number; y: number; boost: number }[] = [];

  // Intro bookkeeping.
  let particles: Particle[] = [];
  let sprites = new Map<string, HTMLCanvasElement[]>();
  let spriteDpr = 0;
  let cellSprites: (Layer | null)[] = [];
  let raf = 0;
  let watchdog = 0;
  let clock = 0;
  let lastNow = 0;
  let skipAt = -1;
  let settledDom = false;
  let clusterPlayed = false;

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

  function edgeGradient(
    g: CanvasRenderingContext2D,
    edge: readonly [string, string],
    bb: BBox,
    alpha: number,
  ): CanvasGradient {
    const dy = (bb.y1 - bb.y0) * 0.15;
    const grad = g.createLinearGradient(bb.x0, bb.y0 + dy, bb.x1, bb.y1 - dy);
    grad.addColorStop(0, withAlpha(edge[0], alpha));
    grad.addColorStop(1, withAlpha(edge[1], alpha));
    return grad;
  }

  /** Viewport point → nebula bitmap coordinates, through the refraction
   * (a REFRACT× magnification about `c`) and the sky's overscan framing. */
  function nebulaPoint(c: Pt, x: number, y: number): Pt {
    const qx = c.x + (x - c.x) / REFRACT;
    const qy = c.y + (y - c.y) / REFRACT;
    const neb = nebula.canvas;
    return {
      x: ((qx + w * NEB_OVERSCAN) / (w * (1 + 2 * NEB_OVERSCAN))) * neb.width,
      y: ((qy + h * NEB_OVERSCAN) / (h * (1 + 2 * NEB_OVERSCAN))) * neb.height,
    };
  }

  /** The refracted sky, blitting only the bitmap region under `r`. */
  function paintRefraction(g: CanvasRenderingContext2D, c: Pt, r: Rect): void {
    const a = nebulaPoint(c, r.x, r.y);
    const b = nebulaPoint(c, r.x + r.w, r.y + r.h);
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

  function paintSpecular(g: CanvasRenderingContext2D, bb: BBox, r: Rect): void {
    const spec = g.createLinearGradient(bb.x0, bb.y0, bb.x1, bb.y1);
    spec.addColorStop(0, "rgba(255,255,255,0.083)");
    spec.addColorStop(0.5, "rgba(255,255,255,0)");
    spec.addColorStop(1, "rgba(0,0,0,0.18)");
    g.fillStyle = spec;
    g.fillRect(r.x, r.y, r.w, r.h);
  }

  /** Dark glass: refraction, tint and specular. No blur, so it is cheap
   * enough for the first paint; the bleed is added by paintBleed later. */
  function paintInterior(g: CanvasRenderingContext2D, cell: Cell): void {
    const r = intersectRect(rectOf(cell.bb), viewport());
    if (!r) return;
    g.save();
    tracePoly(g, cell.inner);
    g.clip();
    paintRefraction(g, cell.c, r);
    g.fillStyle = TINT;
    g.fillRect(r.x, r.y, r.w, r.h);
    paintSpecular(g, cell.bb, r);
    g.restore();
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
    g.strokeStyle = edgeGradient(g, cell.edge, cell.bb, 0.27);
    g.stroke();
    g.restore();
  }

  /** The seam with its real (blurred) glow and the white hot core. */
  function paintSeam(g: CanvasRenderingContext2D, cell: Cell): void {
    g.save();
    g.lineJoin = "round";
    tracePoly(g, cell.inner);
    g.shadowColor = withAlpha(cell.mid, 0.95);
    g.shadowBlur = 27 * dpr;
    g.lineWidth = 1.5;
    g.strokeStyle = edgeGradient(g, cell.edge, cell.bb, 0.95);
    g.stroke();
    g.shadowBlur = 0;
    g.shadowColor = "transparent";
    g.lineWidth = 0.7;
    g.strokeStyle = "rgba(255,255,255,0.28)";
    g.stroke();
    g.restore();
  }

  /** Per-frame seam without blur: three stroked passes (wide/mid/core). `k`
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
      Math.min(1, 0.12 * alpha * (1 + boost)),
    );
    g.lineWidth = 10 * k * (1 + boost);
    g.stroke();
    g.strokeStyle = withAlpha(
      cell.mid,
      Math.min(1, 0.3 * alpha * (1 + 0.5 * boost)),
    );
    g.lineWidth = 4 * k * (1 + 0.5 * boost);
    g.stroke();
    g.globalAlpha = Math.min(1, alpha);
    g.strokeStyle = edgeGradient(g, cell.edge, bb, 0.95);
    g.lineWidth = 1.5 * k;
    g.stroke();
    if (core > 0) {
      g.globalAlpha = Math.min(1, core);
      g.strokeStyle = "rgba(255,255,255,0.28)";
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
    interiorLayer = makeLayer(viewport());
    if (interiorLayer) {
      const g = interiorLayer.g;
      g.fillStyle = VEIL;
      g.fillRect(0, 0, w, h);
      for (const cell of cells) paintInterior(g, cell);
    }
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
    if (state === "intro") buildCellSprites();
    else if (state === "settled") drawSettled();
    mark("layers-ready");
  }

  /* ----- layout ----- */

  function layout(): void {
    w = root.clientWidth;
    h = root.clientHeight;
    dpr = targetDpr();
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (lightEl && lightCtx) {
      lightEl.width = canvas.width;
      lightEl.height = canvas.height;
      lightCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      lightDirty = null;
      hovers = [];
      lightPoint = null;
    }

    const field = layoutField(w, h, labelled.length, {}, labelWidths());
    lightR = field.wide ? LIGHT_R_WIDE : LIGHT_R_NARROW;
    const stops = labelled.flatMap((s) => [s.edge[0], s.edge[1]]);
    const dim = (hex: string): string => mixHex(hex, NEBULA.base, FILLER_DIM);

    cells = field.cells.map((fc) => {
      const inner = fc.inner;
      const c = centroid(inner);
      let far = 0;
      for (const p of inner)
        far = Math.max(far, Math.hypot(p.x - c.x, p.y - c.y));
      const shard = fc.labelled >= 0 ? labelled[fc.labelled] : null;
      const link = shard ? (links.get(shard.id) ?? null) : null;
      const u = c.x / w;
      const edge: readonly [string, string] = shard
        ? shard.edge
        : [
            dim(sampleStops(stops, u)),
            dim(sampleStops(stops, u + FILLER_SPAN)),
          ];
      if (link) {
        link.style.clipPath = toClipPathPx(inner);
        link.style.setProperty("--cx", `${c.x.toFixed(1)}px`);
        link.style.setProperty("--cy", `${c.y.toFixed(1)}px`);
      }
      const mid = midpoint(edge[0], edge[1]);
      return {
        shard,
        link,
        edge,
        mid,
        lifted: mixHex(mid, "#ffffff", BRIGHT_LIFT),
        poly: fc.poly,
        inner,
        c,
        bb: bbox(inner),
        far,
      };
    });
    if (useLight) buildSegments();
    placeGhosts(field);
  }

  /** Estimated rendered width of each shard label (site order = spectrum
   * order), so the layout can ease its stretch until every label fits:
   * uppercase display face at clamp(13px, 1.25vw + 6px, 20px) with 0.14em
   * tracking, about 0.82em per character. */
  function labelWidths(): number[] {
    const size = Math.min(20, Math.max(13, 0.0125 * w + 6));
    return labelled.map((s) => s.label.length * 0.82 * size);
  }

  /** Create the ghost labels for this layout (see src/data/ghosts.ts). */
  function placeGhosts(field: FieldLayout): void {
    ghosts = [];
    if (!ghostHost) return;
    ghostHost.replaceChildren();
    for (const ghost of assignGhosts(
      field,
      w,
      GHOST_SEED,
      ghostWords,
      ghostPhrases,
    )) {
      const cell = cells[ghost.cell];
      if (!cell) continue;
      const el = document.createElement("span");
      el.className = `ghost ghost-${ghost.kind}`;
      el.textContent = ghost.text;
      el.style.setProperty("--cx", `${cell.c.x.toFixed(1)}px`);
      el.style.setProperty("--cy", `${cell.c.y.toFixed(1)}px`);
      if (ghost.kind === "phrase")
        el.style.setProperty("--ghost-max", `${ghost.maxWidth.toFixed(0)}px`);
      ghostHost.appendChild(el);
      ghosts.push({ el, x: cell.c.x, y: cell.c.y, boost: 1 });
    }
  }

  /** Ghosts near the light brighten with the same falloff; a handful of
   * style writes, no layout reads. */
  function updateGhostBoost(): void {
    if (reduceMotion) return;
    const R = lightR;
    for (const gh of ghosts) {
      let boost = 1;
      if (lightPoint) {
        const d = Math.hypot(lightPoint.x - gh.x, lightPoint.y - gh.y);
        if (d < R) boost = 1 + (GHOST_BOOST - 1) * (1 - d / R) ** 2;
      }
      if (Math.abs(boost - gh.boost) < 0.01) continue;
      gh.boost = boost;
      if (boost === 1) gh.el.style.removeProperty("--ghost-boost");
      else gh.el.style.setProperty("--ghost-boost", boost.toFixed(3));
    }
  }

  /** Split every seam into short segments with an outward normal and its
   * colour along the seam gradient, lifted toward white. */
  function buildSegments(): void {
    const ax: number[] = [];
    const bx: number[] = [];
    const mx: number[] = [];
    const nx: number[] = [];
    const soft: string[] = [];
    const core: string[] = [];
    for (const cell of cells) {
      const poly = cell.inner;
      const n = poly.length;
      const bb = cell.bb;
      const g0x = bb.x0;
      const g0y = bb.y0 + (bb.y1 - bb.y0) * 0.15;
      const gdx = bb.x1 - g0x;
      const gdy = bb.y1 - (bb.y1 - bb.y0) * 0.15 - g0y;
      const glen2 = gdx * gdx + gdy * gdy || 1;
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
        const parts = Math.max(1, Math.ceil(len / SEG_MAX));
        for (let k = 0; k < parts; k++) {
          const t0 = k / parts;
          const t1 = (k + 1) / parts;
          const tm = (t0 + t1) / 2;
          const smx = p.x + ex * tm;
          const smy = p.y + ey * tm;
          ax.push(p.x + ex * t0, p.y + ey * t0);
          bx.push(p.x + ex * t1, p.y + ey * t1);
          mx.push(smx, smy);
          nx.push(onx, ony);
          const gt = clamp01(((smx - g0x) * gdx + (smy - g0y) * gdy) / glen2);
          const lifted = mixHex(
            mixHex(cell.edge[0], cell.edge[1], gt),
            "#ffffff",
            BRIGHT_LIFT,
          );
          soft.push(rgbString(lifted));
          core.push(rgbString(mixHex(lifted, "#ffffff", LIGHT_CORE_LIFT)));
        }
      }
    }
    segCount = soft.length;
    segA = Float32Array.from(ax);
    segB = Float32Array.from(bx);
    segM = Float32Array.from(mx);
    segN = Float32Array.from(nx);
    segSoft = soft;
    segCore = core;
    litIndex = new Int32Array(segCount);
    litI = new Float32Array(segCount);
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

  /** Light at (x, y): a faint ambient disc, then every seam segment within
   * R lit by distance falloff × a specular term of how squarely it faces
   * the cursor — a soft pass in the seam colour and a brighter core. */
  function drawLightAt(x: number, y: number): void {
    const g = lightCtx;
    if (!g) return;
    const R = lightR;
    const ambient = g.createRadialGradient(x, y, 0, x, y, R * LIGHT_AMBIENT_R);
    ambient.addColorStop(0, `rgba(255,255,255,${LIGHT_AMBIENT_ALPHA})`);
    ambient.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = ambient;
    g.fillRect(x - R, y - R, 2 * R, 2 * R);

    let lit = 0;
    const R2 = R * R;
    for (let i = 0; i < segCount; i++) {
      const lx = x - segM[2 * i];
      const ly = y - segM[2 * i + 1];
      const d2 = lx * lx + ly * ly;
      if (d2 > R2 || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const f = (1 - d / R) ** 2;
      const c = Math.abs((segN[2 * i] * lx + segN[2 * i + 1] * ly) / d);
      const c2 = c * c;
      const intensity = f * (0.4 * c + 0.7 * c2 * c2 * c2);
      if (intensity < 0.01) continue;
      litIndex[lit] = i;
      litI[lit] = intensity;
      lit++;
    }
    if (!lit) return;
    g.lineCap = "round";
    g.lineWidth = LIGHT_HALO_WIDTH;
    for (let k = 0; k < lit; k++) {
      const i = litIndex[k];
      g.globalAlpha = Math.min(1, LIGHT_HALO_ALPHA * litI[k]);
      g.strokeStyle = segSoft[i];
      g.beginPath();
      g.moveTo(segA[2 * i], segA[2 * i + 1]);
      g.lineTo(segB[2 * i], segB[2 * i + 1]);
      g.stroke();
    }
    g.lineWidth = LIGHT_SOFT_WIDTH;
    for (let k = 0; k < lit; k++) {
      const i = litIndex[k];
      g.globalAlpha = Math.min(1, LIGHT_SOFT_ALPHA * litI[k]);
      g.strokeStyle = segSoft[i];
      g.beginPath();
      g.moveTo(segA[2 * i], segA[2 * i + 1]);
      g.lineTo(segB[2 * i], segB[2 * i + 1]);
      g.stroke();
    }
    g.lineWidth = LIGHT_CORE_WIDTH;
    for (let k = 0; k < lit; k++) {
      const i = litIndex[k];
      g.globalAlpha = Math.min(1, LIGHT_CORE_ALPHA * litI[k]);
      g.strokeStyle = segCore[i];
      g.beginPath();
      g.moveTo(segA[2 * i], segA[2 * i + 1]);
      g.lineTo(segB[2 * i], segB[2 * i + 1]);
      g.stroke();
    }
    g.globalAlpha = 1;
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
      drawLightAt(lightPoint.x, lightPoint.y);
      const pad = lightR + LIGHT_HALO_WIDTH + 2;
      dirty = unionRect(dirty, {
        x: lightPoint.x - pad,
        y: lightPoint.y - pad,
        w: 2 * pad,
        h: 2 * pad,
      });
    }
    lightDirty = dirty ? snapRect(dirty) : null;
    updateGhostBoost();
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
    updateGhostBoost();
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
    if (pointerPending) {
      pointerPending = false;
      lightPoint = { x: pointerX, y: pointerY };
    }
    renderLight();
    hovers = hovers.filter((hv) => hv.alpha > 0 || hv.target > 0);
    if (active) lightRaf = requestAnimationFrame(lightFrame);
  }

  function onPointerMove(e: PointerEvent): void {
    if (state !== "settled") return;
    pointerX = e.clientX;
    pointerY = e.clientY;
    pointerPending = true;
    scheduleLight();
  }

  function onPointerLeaveField(): void {
    pointerPending = false;
    lightPoint = null;
    if (state === "settled") renderLight();
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
  }

  function enableLight(): void {
    if (!useLight || lightOn) return;
    lightOn = true;
    root.addEventListener("pointermove", onPointerMove);
    root.addEventListener("pointerleave", onPointerLeaveField);
  }

  function disableLight(): void {
    if (!lightOn) return;
    lightOn = false;
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerleave", onPointerLeaveField);
    clearLight();
  }

  /* ----- particles ----- */

  function spriteKey(cell: Cell): string {
    return cell.shard ? cell.shard.id : `filler:${cell.edge[0]}${cell.edge[1]}`;
  }

  /** Glow sprites: per cell colour, three tones along its edge gradient,
   * three radii. Built per colour on first use for the current dpr; only
   * the intro needs them. */
  function spritesFor(cell: Cell): HTMLCanvasElement[] {
    if (spriteDpr !== dpr) {
      spriteDpr = dpr;
      sprites = new Map();
    }
    const key = spriteKey(cell);
    const found = sprites.get(key);
    if (found) return found;
    const list: HTMLCanvasElement[] = [];
    for (let tone = 0; tone < TONES; tone++) {
      const hex = mixHex(cell.edge[0], cell.edge[1], tone / (TONES - 1));
      for (const r of SPRITE_RADII) {
        const sprite = document.createElement("canvas");
        const px = Math.ceil(r * 2 * dpr);
        sprite.width = px;
        sprite.height = px;
        const g = sprite.getContext("2d");
        if (g) {
          g.scale(px / (r * 2), px / (r * 2));
          const grad = g.createRadialGradient(r, r, 0, r, r, r);
          grad.addColorStop(0, withAlpha(mixHex(hex, "#ffffff", 0.7), 1));
          grad.addColorStop(0.18, withAlpha(hex, 0.85));
          grad.addColorStop(0.5, withAlpha(hex, 0.22));
          grad.addColorStop(1, withAlpha(hex, 0));
          g.fillStyle = grad;
          g.fillRect(0, 0, r * 2, r * 2);
        }
        list.push(sprite);
      }
    }
    sprites.set(key, list);
    return list;
  }

  function spawnParticles(): void {
    const n = !coarse && Math.min(w, h) >= 700 ? 520 : 220;
    const rng = mulberry32(LAYOUT_SEED ^ 0x9e3779b9);
    particles = [];
    for (let i = 0; i < n; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const cell = cellAt(x, y);
      const sizeRoll = rng();
      const keep = rng();
      if (!cells[cell].shard && keep > FILLER_DENSITY) continue;
      particles.push({
        x,
        y,
        vx: (rng() * 2 - 1) * 10,
        vy: (rng() * 2 - 1) * 10,
        cell,
        tone: Math.min(TONES - 1, Math.floor(rng() * TONES)),
        size: sizeRoll < 0.6 ? 0 : sizeRoll < 0.9 ? 1 : 2,
        tx: 0,
        ty: 0,
        sx: 0,
        sy: 0,
        start: 0,
        dur: 600 + rng() * 700,
        phase: rng() * TAU,
        alpha: 0.45 + rng() * 0.55,
        moving: false,
        arrived: false,
      });
    }
    retarget();
  }

  /** Point each particle at the nearest spot on its cell's inner boundary and
   * stagger its departure by distance from the nucleus, so the crystal grows
   * outward. Particles already in flight keep their schedule. */
  function retarget(): void {
    for (const p of particles) {
      const cell = cells[p.cell];
      const q = nearestOnBoundary(cell.inner, p);
      p.tx = q.x;
      p.ty = q.y;
      if (p.moving) continue;
      const d =
        Math.hypot(p.x - cell.c.x, p.y - cell.c.y) / Math.max(1, cell.far);
      p.start = T_NUCLEATE + clamp01(d) * (T_CRYSTALLISE - T_NUCLEATE - p.dur);
    }
  }

  function updateParticles(t: number, dt: number): void {
    const s = dt / 1000;
    const kx = 0.006;
    const ky = 0.0075;
    const A = 2200;
    for (const p of particles) {
      if (p.arrived) continue;
      if (t >= p.start && t >= T_NUCLEATE) {
        if (!p.moving) {
          p.moving = true;
          p.sx = p.x;
          p.sy = p.y;
        }
        const u = clamp01((t - p.start) / p.dur);
        const e = easeInQuad(u);
        p.x = p.sx + (p.tx - p.sx) * e;
        p.y = p.sy + (p.ty - p.sy) * e;
        if (u >= 1) p.arrived = true;
      } else {
        // Curl of a drifting stream function: divergence-free, so the cloud
        // swirls instead of bunching.
        const ax = p.x * kx + t * 0.0005;
        const ay = p.y * ky - t * 0.0004;
        const fx = A * ky * Math.sin(ax) * Math.cos(ay);
        const fy = -A * kx * Math.cos(ax) * Math.sin(ay);
        p.x += (p.vx + fx) * s;
        p.y += (p.vy + fy) * s;
      }
    }
  }

  function drawParticles(t: number, mul: number): void {
    if (mul <= 0 || particles.length === 0) return;
    const fadeIn = ramp(t, 0, 400);
    const stuck = 1 - ramp(t, T_CRYSTALLISE, T_CRYSTALLISE + 400);
    if (fadeIn <= 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      const list = spritesFor(cells[p.cell]);
      if (p.arrived) {
        if (stuck <= 0) continue;
        // Stuck to the seam: smaller and brighter (drawn twice, additively).
        const sprite = list[p.tone * SPRITE_RADII.length];
        ctx.globalAlpha = Math.min(1, stuck * mul);
        ctx.drawImage(sprite, p.x - 5, p.y - 5, 10, 10);
        ctx.drawImage(sprite, p.x - 3, p.y - 3, 6, 6);
      } else {
        const twinkle = 0.85 + 0.15 * Math.sin(t * 0.004 + p.phase);
        const r = SPRITE_RADII[p.size];
        ctx.globalAlpha = Math.min(1, fadeIn * p.alpha * twinkle * mul);
        ctx.drawImage(
          list[p.tone * SPRITE_RADII.length + p.size],
          p.x - r,
          p.y - r,
          r * 2,
          r * 2,
        );
      }
    }
    ctx.restore();
  }

  /* ----- intro ----- */

  /** One dark-glass interior per cell for the radial reveal: a bbox copy
   * of the interior layer masked to the cell polygon, so nothing is
   * repainted. Dropped as soon as the intro ends. */
  function buildCellSprites(): void {
    const src = interiorLayer;
    cellSprites = cells.map((cell) => {
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
    });
  }

  function introFrame(t: number, dt: number): void {
    ctx.clearRect(0, 0, w, h);
    const nucU = ramp(t, T_NUCLEATE, T_CRYSTALLISE);
    const crysU = ramp(t, T_CRYSTALLISE, T_SETTLE);
    const fadeU = ramp(t, T_SETTLE, T_SETTLE + SEAM_FADE_MS);

    if (nucU >= 1) {
      blit(interiorLayer);
    } else if (nucU > 0) {
      const a = easeOutCubic(nucU);
      ctx.globalAlpha = a;
      ctx.fillStyle = VEIL;
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
      cells.forEach((cell, i) => {
        const sprite = cellSprites[i];
        if (!sprite) return;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cell.c.x, cell.c.y, cell.far * easeOutCubic(nucU), 0, TAU);
        ctx.clip();
        blit(sprite, a);
        ctx.restore();
      });
    }

    const bloomU = ramp(t, T_NUCLEATE, T_NUCLEATE + NUCLEUS_MS);
    if (bloomU > 0 && bloomU < 1) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const r = 70 * easeOutCubic(bloomU);
      const a = 0.9 * (1 - bloomU);
      for (const cell of cells) {
        const g = ctx.createRadialGradient(
          cell.c.x,
          cell.c.y,
          0,
          cell.c.x,
          cell.c.y,
          r,
        );
        g.addColorStop(0, withAlpha(cell.mid, a));
        g.addColorStop(0.4, withAlpha(cell.mid, a * 0.45));
        g.addColorStop(1, withAlpha(cell.mid, 0));
        ctx.fillStyle = g;
        ctx.fillRect(cell.c.x - r, cell.c.y - r, r * 2, r * 2);
      }
      ctx.restore();
    }

    updateParticles(t, dt);
    drawParticles(t, 1);

    if (crysU > 0) {
      const k = lerp(2, 1, easeOutCubic(crysU));
      const core = ramp(t, T_CORE, T_CORE + 200);
      const fake = 1 - fadeU;
      cells.forEach((cell, i) => {
        let alpha = ramp(t, T_CRYSTALLISE, T_CRYSTALLISE + 300);
        if (t < T_CRYSTALLISE + FLICKER_MS)
          alpha = clamp01(alpha + flicker(t, i));
        paintFakeSeam(
          ctx,
          cell,
          cell.inner,
          cell.bb,
          alpha * fake,
          k,
          core * fake,
          0,
        );
      });
      if (fadeU > 0) blit(seamLayer, fadeU);
    }
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
      drawSettled(easeOutCubic(u));
      drawParticles(skipAt, 1 - u);
      if (u >= 1) {
        finishIntro();
        return;
      }
    } else {
      introFrame(clock, dt);
      if (!clusterPlayed && clock >= T_CRYSTALLISE) {
        clusterPlayed = true;
        chimeCluster(
          labelled.map((s) => s.id),
          { velocity: 0.3 },
        );
      }
      if (!settledDom && clock >= T_SETTLE) {
        settledDom = true;
        settle();
      }
      if (clock >= T_SETTLE + SEAM_FADE_MS) {
        finishIntro();
        return;
      }
    }
    schedule();
  }

  function settle(): void {
    root.dataset.state = "settled";
    document.documentElement.classList.remove(INTRO_CLASS);
  }

  function finishIntro(): void {
    unschedule();
    particles = [];
    cellSprites = [];
    state = "settled";
    settle();
    document.removeEventListener("keydown", onKeyDown);
    root.removeEventListener("pointerdown", onPointerDown);
    drawSettled();
    enableLight();
    parkLightOnFocus();
  }

  function skip(): void {
    if (state !== "intro" || skipAt >= 0) return;
    skipAt = clock;
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
    state = "intro";
    root.dataset.state = "intro";
    try {
      sessionStorage.setItem(SESSION_KEY, "1");
    } catch {
      // Storage unavailable: the intro still plays this once.
    }
    document.documentElement.classList.add(INTRO_CLASS);
    root.classList.add("is-live");
    spawnParticles();
    // Nothing in the layers is needed before nucleation (1.3 s), so the
    // whole pipeline runs off the critical path for the first frames.
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
    if (!firstFrameMarked) {
      firstFrameMarked = true;
      mark("first-frame");
    }
    enableLight();
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
    const poly = scalePolygon(cell.inner, s, cell.c);
    const bb = bbox(poly);
    const r = intersectRect(rectOf(bb), viewport());
    if (r) {
      const tint = `rgba(${Math.round(lerp(2, 5, e))},${Math.round(lerp(2, 5, e))},${Math.round(lerp(8, 16, e))},${lerp(0.42, 0.92, e).toFixed(3)})`;
      ctx.save();
      tracePoly(ctx, poly);
      ctx.clip();
      paintRefraction(ctx, cell.c, r);
      ctx.fillStyle = tint;
      ctx.fillRect(r.x, r.y, r.w, r.h);
      paintSpecular(ctx, bb, r);
      ctx.restore();
    }
    paintFakeSeam(ctx, cell, poly, bb, 1, 1.4, 1, e);
  }

  function expand(cell: Cell): void {
    if (!cell.link || !cell.shard) return;
    const href = cell.link.href;
    chimeForShard(cell.shard.id, { velocity: 0.9, length: 1.4 });
    state = "expanding";
    root.dataset.state = "expanding";
    cell.link.classList.add("is-active");
    clearLight();
    if (reduceMotion) {
      go(href);
      return;
    }
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
        go(href);
      }
    };
    raf = requestAnimationFrame(step);
  }

  /* ----- events ----- */

  function onGesture(): void {
    unlockAudio();
  }

  function onClick(e: MouseEvent): void {
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

  /** Hover: the chime and the subtle tint. Touch has no hover; a tap chimes
   * through the click. */
  function onPointerEnter(e: Event): void {
    if (state !== "settled" || coarse) return;
    const cell = cellOf(e.currentTarget as HTMLAnchorElement);
    if (!cell?.shard) return;
    chimeForShard(cell.shard.id, { velocity: 0.45 });
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
    const cell = cellOf(focused);
    if (cell?.shard) chimeForShard(cell.shard.id, { velocity: 0.4 });
    parkLightOnFocus();
  }

  function onFocusOut(): void {
    if (!focused) return;
    focused = null;
    if (useLight && state === "settled") {
      lightPoint = null;
      renderLight();
    }
  }

  /** Full rebuild: geometry, DOM positions, layers; then whatever the current
   * state needs on top. */
  function relayout(): void {
    layout();
    buildLayers();
    if (state === "intro") {
      cellSprites = [];
      for (const p of particles) p.cell = cellAt(p.x, p.y);
      retarget();
    } else if (state === "settled") {
      drawSettled();
      parkLightOnFocus();
    }
  }

  let resizeTimer = 0;
  function onResize(): void {
    if (
      root.clientWidth === w &&
      root.clientHeight === h &&
      targetDpr() === dpr
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
  observer.observe(root);

  if (shouldPlayIntro()) startIntro();
  else settleImmediately();

  return () => {
    unschedule();
    cancelDeferred(pendingBuild);
    pendingBuild = null;
    disableLight();
    clearLight();
    cancelAnimationFrame(liveTimer);
    window.clearTimeout(resizeTimer);
    observer.disconnect();
    unsubscribe();
    document.removeEventListener("visibilitychange", onVisibility);
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
    particles = [];
    cellSprites = [];
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
  destroy = createField(root);
}

function unmount(): void {
  destroy?.();
  destroy = null;
}

document.addEventListener("astro:page-load", () => {
  // A visitor who already clicked elsewhere on the site may hear the chimes
  // straight away; browsers allow audio once the page has been activated.
  if (navigator.userActivation?.hasBeenActive) unlockAudio();
  mount();
});
document.addEventListener("astro:before-swap", unmount);
mount();

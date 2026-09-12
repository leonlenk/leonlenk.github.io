// Site placement and cell geometry for the home shard field, kept pure (no
// DOM, no colour) so the client script and offline checks share one source
// of truth. Deterministic for a given viewport size and shard count.
//
// Labelled shards sit on a jittered grid; filler crystals are strung along
// a few "veins" near the crystal axis, with the rest scattered between the
// shards. Cells come from a power diagram (additively weighted Voronoi)
// computed in a metric compressed along the crystal axis, so every cell
// comes back stretched along it — long, narrow, crystalline. Gaps and
// insets are applied afterwards in screen space, short edges are sharpened
// into acute tips, and cells too thin to read as crystals are culled: they
// are simply not drawn, and the gap shows the nebula.

import {
  anisotropy,
  hashString,
  insetPolygon,
  jitteredGridSites,
  mulberry32,
  polygonArea,
  powerCells,
  rectPoly,
  sharpenPolygon,
  type Poly,
  type Pt,
} from "./geometry";

export const LAYOUT_SEED = hashString("shard-field");

/** Viewports at least this wide get the desktop gap and filler count. */
export const WIDE_MIN = 900;
export const GAP_WIDE = 20;
export const GAP_NARROW = 14;

/** Crystal axis, degrees from horizontal rising to the right, and how much
 * cells stretch along it. Anisotropy steps down by ANISOTROPY_STEP until
 * every label fits its cell horizontally. */
export const CRYSTAL_AXIS_DEG = 64;
export const ANISOTROPY_WIDE = 2.3;
export const ANISOTROPY_NARROW = 1.9;
export const ANISOTROPY_STEP = 0.2;
/** A labelled cell must offer this much room beside its label. */
export const LABEL_MARGIN = 32;

/** Filler crystals: unlabelled, inert cells between the shards. */
export const FILLERS_WIDE = 18;
export const FILLERS_NARROW = 8;
/** Share of fillers strung along veins; the veins run at the crystal axis
 * ± VEIN_ANGLE_SPREAD, with points every VEIN_SPACING_MIN–MAX px and a
 * small perpendicular jitter. */
export const VEIN_SHARE = 0.6;
export const VEINS_MIN = 2;
export const VEINS_MAX = 3;
export const VEIN_ANGLE_SPREAD = 25;
export const VEIN_SPACING_MIN = 60;
export const VEIN_SPACING_MAX = 120;
export const VEIN_JITTER = 18;
/** Power-diagram weights as a fraction of min(w, h); squared before use.
 * Tuned so labelled cells stay far larger than any filler. */
export const LABELLED_WEIGHT = 0.27;
export const FILLER_WEIGHT = 0.045;
/** Rejection-sampling distances for fillers, fractions of min(w, h). */
export const FILLER_MIN_TO_LABELLED = 0.26;
export const FILLER_MIN_TO_FILLER = 0.07;
export const FILLER_TRIES = 40;

/** Acute tips: an inner edge shorter than TIP_MAX_EDGE becomes a point,
 * if that point is within TIP_MAX_OUT × gap outward of it and reachable. */
export const TIP_MAX_EDGE = 26;
export const TIP_MAX_OUT = 0.45;
export const TIP_MAX_REACH = 60;

/** Cull rules for the visible crystal (the inset polygon): it must keep at
 * least this share of the outer cell's area and be at least this wide
 * (by the 2·area/perimeter proxy, so needles survive). */
export const MIN_INSET_AREA_RATIO = 0.35;
export const MIN_WIDTH = 14;

export interface FieldCell {
  /** Full power cell (tiles the viewport with its neighbours). */
  poly: Poly;
  /** Cell inset by half the gap and sharpened: the visible crystal. */
  inner: Poly;
  site: Pt;
  /** Index into the labelled list, or -1 for a filler. */
  labelled: number;
}

export interface FieldLayout {
  wide: boolean;
  gap: number;
  cells: FieldCell[];
  /** Cells the power diagram produced but the cull rules rejected. */
  culled: number;
  /** The stretch actually used after the label-fit check. */
  anisotropy: number;
  veins: number;
}

/** The tunable numbers, overridable so offline checks can sweep them. */
export interface LayoutTuning {
  fillers: number;
  labelledWeight: number;
  fillerWeight: number;
  minToLabelled: number;
  minToFiller: number;
  anisotropy: number;
  axisDeg: number;
}

export function perimeter(poly: Poly): number {
  let sum = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

/** 2·area / perimeter: a cheap proxy for thinness, about half the true
 * minimum width of a compact polygon. Used by the cull rule. */
export function minWidth(poly: Poly): number {
  const p = perimeter(poly);
  return p > 0 ? (2 * Math.abs(polygonArea(poly))) / p : 0;
}

/** Exact minimum width of a convex polygon (rotating calipers): for each
 * edge, the farthest vertex's distance from its line; the smallest of those.
 * Used where a real size matters, such as fitting text. */
export function polygonWidth(poly: Poly): number {
  let best = Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const len = Math.hypot(ex, ey);
    if (len < 1e-6) continue;
    let far = 0;
    for (const p of poly) {
      const d = Math.abs(ex * (p.y - a.y) - ey * (p.x - a.x)) / len;
      if (d > far) far = d;
    }
    if (far < best) best = far;
  }
  return best === Infinity ? 0 : best;
}

/** Length of the horizontal chord of a convex polygon at height `y`. */
export function horizontalChord(poly: Poly, y: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    if ((a.y <= y && b.y >= y) || (b.y <= y && a.y >= y)) {
      const x =
        a.y === b.y ? a.x : a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (x < lo) lo = x;
      if (x > hi) hi = x;
      if (a.y === b.y) {
        lo = Math.min(lo, a.x, b.x);
        hi = Math.max(hi, a.x, b.x);
      }
    }
  }
  return hi > lo ? hi - lo : 0;
}

function centroidOf(poly: Poly): Pt {
  let x = 0;
  let y = 0;
  for (const p of poly) {
    x += p.x;
    y += p.y;
  }
  return { x: x / poly.length, y: y / poly.length };
}

/** One attempt at a given anisotropy; the rng is fresh per attempt so sites
 * and veins are identical whatever `k` ends up being. */
function buildLayout(
  w: number,
  h: number,
  labelledCount: number,
  tuning: LayoutTuning,
  k: number,
): FieldLayout {
  const wide = w >= WIDE_MIN;
  const gap = wide ? GAP_WIDE : GAP_NARROW;
  const m = Math.min(w, h);
  const rng = mulberry32(LAYOUT_SEED + labelledCount);
  const sites = jitteredGridSites(labelledCount, w, h, rng);

  const want = tuning.fillers;
  const minToLabelled = tuning.minToLabelled * m;
  const minToFiller = tuning.minToFiller * m;
  const tooClose = (p: Pt, list: Pt[], min: number): boolean =>
    list.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < min);
  const fillers: Pt[] = [];
  const accept = (p: Pt): boolean => {
    if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) return false;
    if (tooClose(p, sites, minToLabelled) || tooClose(p, fillers, minToFiller))
      return false;
    fillers.push(p);
    return true;
  };

  // Veins: a few lines near the crystal axis, points strung along them.
  const veins = VEINS_MIN + Math.floor(rng() * (VEINS_MAX - VEINS_MIN + 1));
  const quota = Math.round(want * VEIN_SHARE);
  const perVein = Math.ceil(quota / veins);
  const diag = Math.hypot(w, h);
  for (let v = 0; v < veins && fillers.length < quota; v++) {
    const ang =
      ((tuning.axisDeg + (rng() * 2 - 1) * VEIN_ANGLE_SPREAD) * Math.PI) / 180;
    const dx = Math.cos(ang);
    const dy = -Math.sin(ang);
    const ox = rng() * w;
    const oy = rng() * h;
    let taken = 0;
    let t = -diag / 2 + rng() * VEIN_SPACING_MAX;
    while (t < diag / 2 && taken < perVein && fillers.length < quota) {
      const jitter = (rng() * 2 - 1) * VEIN_JITTER;
      const p = { x: ox + dx * t - dy * jitter, y: oy + dy * t + dx * jitter };
      t += VEIN_SPACING_MIN + rng() * (VEIN_SPACING_MAX - VEIN_SPACING_MIN);
      if (accept(p)) taken++;
    }
  }
  // The rest scattered.
  while (fillers.length < want) {
    let placed = false;
    for (let tries = 0; tries < FILLER_TRIES && !placed; tries++)
      placed = accept({ x: rng() * w, y: rng() * h });
    if (!placed) break;
  }

  // Power cells in the compressed metric, mapped back to screen space.
  const map = anisotropy(tuning.axisDeg, k);
  const all = [...sites, ...fillers];
  const weights = all.map(
    (_, i) =>
      ((i < labelledCount ? tuning.labelledWeight : tuning.fillerWeight) * m) **
        2 /
      k,
  );
  const polys = powerCells(
    all.map(map.to),
    weights,
    rectPoly(w, h).map(map.to),
  ).map((poly) => poly.map(map.from));

  const cells: FieldCell[] = [];
  let culled = 0;
  polys.forEach((poly, i) => {
    const outerArea = Math.abs(polygonArea(poly));
    if (poly.length < 3 || outerArea < 1) return;
    let inner = insetPolygon(poly, gap / 2);
    if (inner.length >= 3)
      inner = sharpenPolygon(
        inner,
        TIP_MAX_EDGE,
        TIP_MAX_OUT * gap,
        TIP_MAX_REACH,
      );
    if (
      inner.length < 3 ||
      Math.abs(polygonArea(inner)) < MIN_INSET_AREA_RATIO * outerArea ||
      minWidth(inner) < MIN_WIDTH
    ) {
      culled++;
      return;
    }
    cells.push({
      poly,
      inner,
      site: all[i],
      labelled: i < labelledCount ? i : -1,
    });
  });
  return { wide, gap, cells, culled, anisotropy: k, veins };
}

/** Every labelled cell offers its label (widths in site order) enough
 * horizontal room through the centroid. */
function labelsFit(
  layout: FieldLayout,
  labelWidths: readonly number[],
): boolean {
  return layout.cells.every((cell) => {
    if (cell.labelled < 0) return true;
    const width = labelWidths[cell.labelled];
    if (width === undefined) return true;
    const c = centroidOf(cell.inner);
    return horizontalChord(cell.inner, c.y) >= width + LABEL_MARGIN;
  });
}

/**
 * Lay out `labelledCount` shards plus the fillers for a `w × h` viewport.
 * Labelled cells come first, in the order of the grid sites (row-major), so
 * a caller that hands them shards in spectrum order gets the spectrum
 * flowing left to right; fillers follow. `labelWidths` (site order, CSS px)
 * lets the stretch back off until every label fits.
 */
export function layoutField(
  w: number,
  h: number,
  labelledCount: number,
  overrides: Partial<LayoutTuning> = {},
  labelWidths: readonly number[] = [],
): FieldLayout {
  const wide = w >= WIDE_MIN;
  const tuning: LayoutTuning = {
    fillers: wide ? FILLERS_WIDE : FILLERS_NARROW,
    labelledWeight: LABELLED_WEIGHT,
    fillerWeight: FILLER_WEIGHT,
    minToLabelled: FILLER_MIN_TO_LABELLED,
    minToFiller: FILLER_MIN_TO_FILLER,
    anisotropy: wide ? ANISOTROPY_WIDE : ANISOTROPY_NARROW,
    axisDeg: CRYSTAL_AXIS_DEG,
    ...overrides,
  };
  let k = tuning.anisotropy;
  for (;;) {
    const layout = buildLayout(w, h, labelledCount, tuning, k);
    if (k <= 1 || labelsFit(layout, labelWidths)) return layout;
    k = Math.max(1, Math.round((k - ANISOTROPY_STEP) * 100) / 100);
  }
}

/* ---------- ghost text ---------- */

/** Ghosts: faint decorative labels on the largest fillers (see
 * src/data/ghosts.ts). A filler qualifies when it is at least this wide and
 * its area is at least GHOST_AREA_FACTOR × the median labelled-cell area;
 * the widest, largest ones may carry a phrase instead of a word. */
export const GHOST_MAX_WIDE = 5;
export const GHOST_MAX_NARROW = 2;
export const GHOST_MIN_WIDTH = 96;
export const GHOST_AREA_FACTOR = 0.55 * 0.25;
export const GHOST_PHRASE_MIN_WIDTH = 180;
export const GHOST_PHRASE_AREA_FACTOR = 1.6;
/** Fit estimate: average glyph advance as a fraction of the font size
 * (words also carry their 0.22em tracking), against this share of the
 * cell's minimum width. Phrases may wrap onto this many balanced lines. */
export const GHOST_CHAR_ADVANCE = 0.62;
export const GHOST_WORD_TRACKING = 0.22;
export const GHOST_FIT = 0.8;
export const GHOST_PHRASE_LINES = 2;

export interface GhostAssignment {
  /** Index into `FieldLayout.cells`. */
  cell: number;
  text: string;
  kind: "word" | "phrase";
  /** 0.8 × the cell's minimum width: the label's max-width, CSS px. */
  maxWidth: number;
}

/** The ghost font sizes ShardField.astro uses, mirrored for the fit test:
 * clamp(10px, 0.75vw + 5px, 13px) and clamp(11px, 0.8vw + 6px, 14px). */
export function ghostFontSizes(w: number): { word: number; phrase: number } {
  return {
    word: Math.min(13, Math.max(10, 0.0075 * w + 5)),
    phrase: Math.min(14, Math.max(11, 0.008 * w + 6)),
  };
}

function shuffled<T>(list: readonly T[], rng: () => number): T[] {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pick which fillers carry ghost text and what they say. `seed` should be
 * the day number so the ghosts change daily but hold still within a visit;
 * no entry is used twice in one layout, and a label that would not fit its
 * cell is skipped (phrase → word → nothing).
 */
export function assignGhosts(
  layout: FieldLayout,
  w: number,
  seed: number,
  words: readonly string[],
  phrases: readonly string[],
): GhostAssignment[] {
  const area = (i: number): number =>
    Math.abs(polygonArea(layout.cells[i].inner));
  const labelledAreas = layout.cells
    .map((c, i) => (c.labelled >= 0 ? area(i) : -1))
    .filter((a) => a >= 0)
    .sort((a, b) => a - b);
  if (labelledAreas.length === 0) return [];
  const mid = labelledAreas.length >> 1;
  const median =
    labelledAreas.length % 2
      ? labelledAreas[mid]
      : (labelledAreas[mid - 1] + labelledAreas[mid]) / 2;
  const threshold = GHOST_AREA_FACTOR * median;

  const candidates = layout.cells
    .map((c, i) => ({
      i,
      width: polygonWidth(c.inner),
      area: area(i),
      filler: c.labelled < 0,
    }))
    .filter(
      (c) => c.filler && c.width >= GHOST_MIN_WIDTH && c.area >= threshold,
    )
    .sort((a, b) => b.area - a.area)
    .slice(0, layout.wide ? GHOST_MAX_WIDE : GHOST_MAX_NARROW);

  const rng = mulberry32(seed);
  const wordPool = shuffled(words, rng);
  const phrasePool = shuffled(phrases, rng);
  const usedWords = new Set<number>();
  const usedPhrases = new Set<number>();
  const sizes = ghostFontSizes(w);
  const wordAdvance = (GHOST_CHAR_ADVANCE + GHOST_WORD_TRACKING) * sizes.word;
  const phraseAdvance = GHOST_CHAR_ADVANCE * sizes.phrase;

  const out: GhostAssignment[] = [];
  for (const c of candidates) {
    const limit = GHOST_FIT * c.width;
    let text: string | null = null;
    let kind: GhostAssignment["kind"] = "word";
    if (
      c.width >= GHOST_PHRASE_MIN_WIDTH &&
      c.area >= GHOST_PHRASE_AREA_FACTOR * threshold
    ) {
      const k = phrasePool.findIndex(
        (p, idx) =>
          !usedPhrases.has(idx) &&
          p.length * phraseAdvance <= limit * GHOST_PHRASE_LINES,
      );
      if (k >= 0) {
        usedPhrases.add(k);
        text = phrasePool[k];
        kind = "phrase";
      }
    }
    if (!text) {
      const k = wordPool.findIndex(
        (wd, idx) => !usedWords.has(idx) && wd.length * wordAdvance <= limit,
      );
      if (k >= 0) {
        usedWords.add(k);
        text = wordPool[k];
      }
    }
    if (text) out.push({ cell: c.i, text, kind, maxWidth: limit });
  }
  return out;
}

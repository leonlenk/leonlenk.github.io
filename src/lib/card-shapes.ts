// Irregular convex silhouettes for cards, paper rows and header panels,
// plus the padding needed to keep content clear of every cut. Percent
// space (0–100 on both axes) so one shape scales with its box. Pure and
// deterministic: same seeded rng, same shape.
//
// Construction only removes corners from a rectangle (optionally with one
// slanted side), so the result is convex by design: a slanted rectangle is
// a trapezoid, and chamfering a convex corner with cut points on its two
// edges keeps convexity. 5–8 vertices: at least one corner is always cut.

import { hashString, mulberry32 } from "./geometry";

export interface Pt {
  x: number;
  y: number;
}

export type Poly = Pt[];

export interface CardShapeOptions {
  /**
   * Width ÷ height the box is expected to have. Vertical cuts are percent
   * of height, but CSS padding percentages are percent of width, so the
   * aspect converts one to the other. Use the lowest (squarest) aspect the
   * box can reach, which is the worst case. Default 1.2.
   */
  aspect?: number;
  /** Multiplier on chamfer depths; < 1 for wide, shallow rows. Default 1. */
  depth?: number;
  /** Probability (0–1) that one side is slanted. Default 0.5. */
  slant?: number;
  /** Largest slant, percent of the box on the slant's axis. Default 7. */
  maxSlant?: number;
  /** Wide box: a slant may lean a left or right side too. Default false. */
  wide?: boolean;
  /** Extra clearance added to both pads, percent of width. Default 3. */
  margin?: number;
}

export interface CardShape {
  /** Convex, 5–8 vertices, clockwise from the top-left corner. */
  polygon: Poly;
  /**
   * Horizontal and vertical padding, as percent of the box WIDTH (the unit
   * CSS padding percentages use), that keeps a content rectangle inside
   * the polygon at the given aspect. Apply as `calc(var(--pad-x) * 1%)`.
   */
  padX: number;
  padY: number;
}

/* ---------- pieces ---------- */

/** A corner cut: `a` along the horizontal edge (%W), `b` down the vertical one (%H). */
interface Cut {
  a: number;
  b: number;
}

type Side = "top" | "bottom" | "left" | "right";

const between = (t: number, lo: number, hi: number): number =>
  lo + t * (hi - lo);

const lerp = (p: Pt, q: Pt, t: number): Pt => ({
  x: p.x + (q.x - p.x) * t,
  y: p.y + (q.y - p.y) * t,
});

/** One of: none · small chamfer 4–9% · deep chamfer 12–22% · asymmetric (one side up to 26%). */
function drawCut(rng: () => number): Cut {
  const kind = rng();
  const u = rng();
  const v = rng();
  if (kind < 0.25) return { a: 0, b: 0 };
  if (kind < 0.55) return { a: between(u, 4, 9), b: between(v, 4, 9) };
  if (kind < 0.8) return { a: between(u, 12, 22), b: between(v, 12, 22) };
  const short = between(u, 4, 10);
  const long = between(v, 14, 26);
  return kind < 0.9 ? { a: long, b: short } : { a: short, b: long };
}

/** Point-in-convex-polygon by consistent cross-product sign. */
function inside(poly: Poly, pt: Pt): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cross = (q.x - p.x) * (pt.y - p.y) - (q.y - p.y) * (pt.x - p.x);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/** Does the content rect for these pads (percent of width) sit inside? */
function rectFits(poly: Poly, padX: number, padY: number, aspect: number) {
  const y0 = padY * aspect;
  const y1 = 100 - padY * aspect;
  if (y1 <= y0 || padX >= 50) return false;
  return (
    inside(poly, { x: padX, y: y0 }) &&
    inside(poly, { x: 100 - padX, y: y0 }) &&
    inside(poly, { x: 100 - padX, y: y1 }) &&
    inside(poly, { x: padX, y: y1 })
  );
}

/* ---------- the generator ---------- */

export function cardShape(
  rng: () => number,
  opts: CardShapeOptions = {},
): CardShape {
  const {
    aspect = 1.2,
    depth = 1,
    slant = 0.5,
    maxSlant = 7,
    wide = false,
    margin = 3,
  } = opts;

  // Every random draw happens up front, unconditionally, so two calls with
  // the same seed and different options (a wide and a narrow variant of one
  // panel) share corner kinds and slant side.
  const drawn = [drawCut(rng), drawCut(rng), drawCut(rng), drawCut(rng)];
  const forced = Math.floor(rng() * 4);
  const slantRoll = rng();
  const axisRoll = rng();
  const sideRoll = rng();
  const amountRoll = rng();
  const endRoll = rng();

  if (drawn.every((c) => c.a === 0 && c.b === 0))
    drawn[forced] = { a: 6, b: 6 };

  const lateral = wide && axisRoll < 0.35;
  const side: Side | null =
    slantRoll < slant
      ? lateral
        ? sideRoll < 0.5
          ? "left"
          : "right"
        : sideRoll < 0.5
          ? "top"
          : "bottom"
      : null;
  const end = endRoll < 0.5 ? 0 : 1;
  const slantAmount = side ? between(amountRoll, 3, maxSlant) : 0;

  // Build at a given scale; shrink and rebuild if the safe area gets too
  // small (content keeps at least 62% of the width and 60% of the height).
  let scale = depth;
  let shape = build(scale);
  for (let i = 0; i < 12 && !roomy(shape); i++) {
    scale *= 0.85;
    shape = build(scale);
  }
  return shape;

  function roomy({ padX, padY }: CardShape): boolean {
    return 100 - 2 * padX >= 62 && 100 - 2 * padY * aspect >= 60;
  }

  function build(k: number): CardShape {
    const cuts = drawn.map((c) => ({ a: c.a * k, b: c.b * k }));
    const s = slantAmount * k;

    // Cap the total cut per axis (deepest left + deepest right, and the
    // slant if it is on that axis) so opposite cuts never crowd the middle.
    const [tl, tr, br, bl] = cuts;
    const xTotal =
      Math.max(tl.a, bl.a) +
      Math.max(tr.a, br.a) +
      (side === "left" || side === "right" ? s : 0);
    const yTotal =
      Math.max(tl.b, tr.b) +
      Math.max(bl.b, br.b) +
      (side === "top" || side === "bottom" ? s : 0);
    const kx = xTotal > 38 ? 38 / xTotal : 1;
    const ky = yTotal > 40 ? 40 / yTotal : 1;
    for (const c of cuts) {
      c.a *= kx;
      c.b *= ky;
    }

    // Base corners, then lean one side by moving a single corner inward.
    const corner: Pt[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
    ];
    if (side === "top") corner[end === 0 ? 0 : 1].y = s;
    if (side === "bottom") corner[end === 0 ? 3 : 2].y = 100 - s;
    if (side === "left") corner[end === 0 ? 0 : 3].x = s;
    if (side === "right") corner[end === 0 ? 1 : 2].x = 100 - s;

    // For each corner: the neighbour along its horizontal edge and along
    // its vertical edge. Cut points are interpolated along those edges, so
    // they stay on the (possibly slanted) outline.
    const along: [number, number][] = [
      [1, 3],
      [0, 2],
      [3, 1],
      [2, 0],
    ];
    const polygon: Poly = [];
    corner.forEach((p, i) => {
      const { a, b } = cuts[i];
      const [hx, vy] = along[i];
      if (a <= 0 || b <= 0) {
        polygon.push(p);
        return;
      }
      const h = corner[hx];
      const v = corner[vy];
      const onH = lerp(p, h, Math.min(0.5, a / Math.abs(h.x - p.x)));
      const onV = lerp(p, v, Math.min(0.5, b / Math.abs(v.y - p.y)));
      // Clockwise: leave the corner along the edge we arrive on.
      if (i === 0 || i === 2) polygon.push(onV, onH);
      else polygon.push(onH, onV);
    });

    // Pads: half of the deepest chamfer on each axis (the two halves meet
    // the diagonal), the full slant on its axis, then a margin; verified
    // against the actual outline and nudged up if the compound of a slant
    // and a chamfer at one corner needs more.
    const deepA = Math.max(...cuts.map((c) => c.a));
    const deepB = Math.max(...cuts.map((c) => c.b));
    let padX = deepA / 2 + (side === "left" || side === "right" ? s : 0);
    let padY =
      (deepB / 2 + (side === "top" || side === "bottom" ? s : 0)) / aspect;
    padX += margin;
    padY += margin;
    for (let i = 0; i < 80 && !rectFits(polygon, padX, padY, aspect); i++) {
      padX += 0.5;
      padY += 0.5;
    }

    return {
      polygon,
      padX: Math.round(padX * 10) / 10,
      padY: Math.round(padY * 10) / 10,
    };
  }
}

/* ---------- paper rows ---------- */

export interface PaperShapes {
  /** Desktop row, about 5:1. */
  wide: CardShape;
  /** Phone row, nearly square, with shallower cuts from the same seed. */
  narrow: CardShape;
}

/**
 * Silhouettes for one paper row. Rows are wide on desktop (about 5:1) and
 * nearly square on a phone, where the same percent cuts would bite five
 * times deeper; so two silhouettes from one seed, each with pads for its
 * aspect.
 */
export function paperShapes(id: string): PaperShapes {
  const seed = hashString(id);
  return {
    wide: cardShape(mulberry32(seed), {
      aspect: 4,
      depth: 0.6,
      slant: 0.7,
      wide: true,
    }),
    narrow: cardShape(mulberry32(seed), {
      aspect: 1,
      depth: 0.35,
      slant: 0.7,
      maxSlant: 4,
      wide: true,
    }),
  };
}

/**
 * Stacked paper rows share one width, so a shared horizontal pad lines
 * their text up in a single column. Each row keeps its own silhouette; the
 * pad is the largest any row needs, so every row still clears its cuts.
 */
export function sharedPaperPadX(ids: string[]): {
  wide: number;
  narrow: number;
} {
  let wide = 0;
  let narrow = 0;
  for (const id of ids) {
    const shapes = paperShapes(id);
    wide = Math.max(wide, shapes.wide.padX);
    narrow = Math.max(narrow, shapes.narrow.padX);
  }
  return { wide, narrow };
}

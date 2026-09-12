// Pure 2D polygon helpers shared by the home shard field (client, Canvas 2D)
// and the shard cards (build time, CSS clip-path). No DOM, no dependencies.
//
// Polygons are arrays of points in either winding. Everything here assumes
// convex input, which holds for Voronoi cells, their insets, and the card
// shapes generated below.

export interface Pt {
  x: number;
  y: number;
}

export type Poly = Pt[];

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/* ---------- seeded randomness ---------- */

/** Small, fast, deterministic PRNG. Same seed, same sequence, every visit. */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, so a shard or post id can seed its own stable geometry. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* ---------- basic measures ---------- */

export function rectPoly(w: number, h: number, x = 0, y = 0): Poly {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function polygonArea(poly: Poly): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Area centroid, falling back to the vertex mean for degenerate input. */
export function centroid(poly: Poly): Pt {
  const n = poly.length;
  if (n === 0) return { x: 0, y: 0 };
  const area = polygonArea(poly);
  if (Math.abs(area) < 1e-6) {
    let x = 0;
    let y = 0;
    for (const p of poly) {
      x += p.x;
      y += p.y;
    }
    return { x: x / n, y: y / n };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const f = p.x * q.y - q.x * p.y;
    cx += (p.x + q.x) * f;
    cy += (p.y + q.y) * f;
  }
  return { x: cx / (6 * area), y: cy / (6 * area) };
}

export function bbox(poly: Poly): BBox {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of poly) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/** Point-in-convex-polygon by consistent cross-product sign. */
export function containsPoint(poly: Poly, pt: Pt): boolean {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const cr = (q.x - p.x) * (pt.y - p.y) - (q.y - p.y) * (pt.x - p.x);
    if (cr !== 0) {
      const s = cr > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (s !== sign) return false;
    }
  }
  return true;
}

/* ---------- clipping ---------- */

/**
 * Sutherland–Hodgman against a single half-plane. `side(p)` is a signed
 * distance; points with side <= 0 are kept.
 */
export function clipLine(poly: Poly, side: (p: Pt) => number): Poly {
  const out: Poly = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const sp = side(p);
    const sq = side(q);
    if (sp <= 0) out.push(p);
    if ((sp < 0 && sq > 0) || (sp > 0 && sq < 0)) {
      const t = sp / (sp - sq);
      out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
    }
  }
  return out;
}

/** Keep the part of `poly` closer to `a` than to `b`. */
export function clipHalfPlane(poly: Poly, a: Pt, b: Pt): Poly {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return clipLine(poly, (p) => (p.x - mx) * dx + (p.y - my) * dy);
}

/**
 * Voronoi cells of `sites` inside the convex `bounds`, by repeated half-plane
 * clipping. O(n²) per call, which is nothing for the dozen cells a site has.
 */
export function voronoiCells(sites: Pt[], bounds: Poly): Poly[] {
  return sites.map((s, i) => {
    let poly = bounds;
    for (let j = 0; j < sites.length && poly.length; j++) {
      if (i !== j) poly = clipHalfPlane(poly, s, sites[j]);
    }
    return poly;
  });
}

/**
 * Keep the part of `poly` on `a`'s side of the *power* bisector of `a` and
 * `b`: points where |p−a|² − wa ≤ |p−b|² − wb. That is the perpendicular
 * bisector shifted from the midpoint toward `b` by (wa − wb) / (2·|ab|), so
 * a heavier site claims more of the plane.
 */
export function clipHalfPlaneWeighted(
  poly: Poly,
  a: Pt,
  b: Pt,
  wa: number,
  wb: number,
): Poly {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 && dy === 0) return poly.slice();
  // |p−a|² − wa − (|p−b|² − wb) = 2·p·(b−a) + |a|² − |b|² − wa + wb
  const k = a.x * a.x + a.y * a.y - b.x * b.x - b.y * b.y - wa + wb;
  return clipLine(poly, (p) => 2 * (p.x * dx + p.y * dy) + k);
}

/**
 * Power diagram (additively weighted Voronoi) of `sites` inside the convex
 * `bounds`: cell i is where |p−sᵢ|² − wᵢ is minimal. Unlike a plain Voronoi
 * cell, a light site's cell can be empty or can exclude its own site, so
 * callers should skip cells with fewer than 3 vertices.
 */
export function powerCells(
  sites: Pt[],
  weights: number[],
  bounds: Poly,
): Poly[] {
  return sites.map((s, i) => {
    let poly = bounds;
    for (let j = 0; j < sites.length && poly.length; j++) {
      if (i !== j)
        poly = clipHalfPlaneWeighted(poly, s, sites[j], weights[i], weights[j]);
    }
    return poly;
  });
}

/* ---------- offsets and interpolation ---------- */

/**
 * Parallel inset of a convex polygon by distance `d` (shrinks for d > 0),
 * done by clipping: the polygon is cut against each edge's supporting line
 * moved inward by `d`. Clipping can only shrink or empty a polygon, so a
 * cell thinner than 2·d comes back with fewer than 3 vertices instead of
 * folding into a bowtie the way offset-and-reintersect does. The gap between
 * neighbouring cells stays uniform. Callers must handle an empty result.
 */
export function insetPolygon(poly: Poly, d: number): Poly {
  const n = poly.length;
  if (n < 3 || d <= 0) return poly.slice();
  const c = centroid(poly);
  let out: Poly = poly.slice();
  for (let i = 0; i < n && out.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    let nx = q.y - p.y;
    let ny = -(q.x - p.x);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    // orient inward, toward the centroid
    if ((c.x - p.x) * nx + (c.y - p.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    // keep points whose inward distance from this edge is at least d
    out = clipLine(out, (pt) => d - ((pt.x - p.x) * nx + (pt.y - p.y) * ny));
  }
  return out;
}

function lineIntersect(p1: Pt, p2: Pt, p3: Pt, p4: Pt): Pt | null {
  const d = (p1.x - p2.x) * (p3.y - p4.y) - (p1.y - p2.y) * (p3.x - p4.x);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((p1.x - p3.x) * (p3.y - p4.y) - (p1.y - p3.y) * (p3.x - p4.x)) / d;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}

/**
 * Sharpen a convex polygon's tips: an edge shorter than `maxEdge` is
 * replaced by the point where its two neighbouring edges meet, provided that
 * point lies at most `maxOut` outward of the removed edge and within
 * `maxReach` of it (near-parallel neighbours meet too far away and are left
 * alone). Edges are only ever extended outward, so convexity is preserved.
 */
export function sharpenPolygon(
  poly: Poly,
  maxEdge: number,
  maxOut: number,
  maxReach: number,
): Poly {
  const out = poly.slice();
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    const n = out.length;
    const c = centroid(out);
    for (let i = 0; i < n; i++) {
      const a = out[i];
      const b = out[(i + 1) % n];
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const len = Math.hypot(ex, ey);
      if (len >= maxEdge) continue;
      const prev = out[(i - 1 + n) % n];
      const next = out[(i + 2) % n];
      const x = lineIntersect(prev, a, b, next);
      if (!x) continue;
      const reach = Math.hypot(x.x - (a.x + b.x) / 2, x.y - (a.y + b.y) / 2);
      if (reach > maxReach) continue;
      // signed side of the removed edge: the tip must lie opposite the interior
      const side = (p: Pt): number => ex * (p.y - a.y) - ey * (p.x - a.x);
      const sx = side(x);
      if (len > 1e-6) {
        if (Math.sign(sx) === Math.sign(side(c))) continue;
        if (Math.abs(sx) / len > maxOut) continue;
      }
      if (i === n - 1) {
        out.splice(i, 1, x);
        out.shift();
      } else out.splice(i, 2, x);
      changed = true;
      break;
    }
  }
  return out;
}

/**
 * A linear map that compresses distances along one axis by `k` (and its
 * inverse). Running a Voronoi or power diagram in the mapped space and
 * mapping the vertices back stretches every cell along that axis by `k`;
 * bisectors stay straight because the map is linear. `thetaDeg` is measured
 * from horizontal, rising to the right in screen coordinates.
 */
export function anisotropy(
  thetaDeg: number,
  k: number,
): { to: (p: Pt) => Pt; from: (p: Pt) => Pt } {
  const t = (thetaDeg * Math.PI) / 180;
  const ux = Math.cos(t);
  const uy = -Math.sin(t);
  const vx = -uy;
  const vy = ux;
  const map = (p: Pt, s: number): Pt => {
    const a = (p.x * ux + p.y * uy) * s;
    const b = p.x * vx + p.y * vy;
    return { x: a * ux + b * vx, y: a * uy + b * vy };
  };
  return { to: (p) => map(p, 1 / k), from: (p) => map(p, k) };
}

/** Scale a polygon about a point. */
export function scalePolygon(poly: Poly, s: number, about: Pt): Poly {
  return poly.map((p) => ({
    x: about.x + (p.x - about.x) * s,
    y: about.y + (p.y - about.y) * s,
  }));
}

/**
 * Insert vertices along the longest edges until the polygon has exactly `n`
 * vertices (n >= current count). Two polygons resampled to the same count can
 * be interpolated vertex-by-vertex, which is what CSS clip-path transitions
 * and the shard expand animation need.
 */
export function resamplePolygon(poly: Poly, n: number): Poly {
  const out = poly.slice();
  while (out.length < n) {
    let best = 0;
    let bestLen = -1;
    for (let i = 0; i < out.length; i++) {
      const p = out[i];
      const q = out[(i + 1) % out.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len > bestLen) {
        bestLen = len;
        best = i;
      }
    }
    const p = out[best];
    const q = out[(best + 1) % out.length];
    out.splice(best + 1, 0, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 });
  }
  return out;
}

/** Vertex-wise lerp of two same-length polygons. */
export function lerpPolygon(a: Poly, b: Poly, t: number): Poly {
  return a.map((p, i) => ({
    x: p.x + (b[i].x - p.x) * t,
    y: p.y + (b[i].y - p.y) * t,
  }));
}

/** The smallest uniform scale about `about` that makes `poly` cover `rect`. */
export function coverScale(poly: Poly, about: Pt, rect: BBox): number {
  // For a convex polygon containing `about`, each edge's supporting line
  // must be pushed past the farthest rect corner on its outer side.
  const corners: Pt[] = [
    { x: rect.x0, y: rect.y0 },
    { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 },
    { x: rect.x0, y: rect.y1 },
  ];
  let s = 1;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    let nx = q.y - p.y;
    let ny = -(q.x - p.x);
    const len = Math.hypot(nx, ny) || 1;
    nx /= len;
    ny /= len;
    // orient outward (away from `about`)
    if ((about.x - p.x) * nx + (about.y - p.y) * ny > 0) {
      nx = -nx;
      ny = -ny;
    }
    const edgeDist = (p.x - about.x) * nx + (p.y - about.y) * ny;
    if (edgeDist <= 1e-6) continue;
    for (const c of corners) {
      const cornerDist = (c.x - about.x) * nx + (c.y - about.y) * ny;
      if (cornerDist > 0) s = Math.max(s, cornerDist / edgeDist);
    }
  }
  return s;
}

/* ---------- site layouts ---------- */

/**
 * `n` sites on a jittered grid that fits the aspect of `w × h`, so cells stay
 * roughly equal in area on both a wide desktop and a tall phone. Rows get
 * balanced counts (7 → 3/2/2, never 3/3/1). `jitter` is a fraction of the
 * grid cell; ~0.28 gives clearly irregular cells without pathological slivers.
 */
export function jitteredGridSites(
  n: number,
  w: number,
  h: number,
  rng: () => number,
  jitter = 0.28,
): Pt[] {
  if (n <= 0) return [];
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt((n * w) / h))));
  const rows = Math.ceil(n / cols);
  const base = Math.floor(n / rows);
  const extra = n % rows;
  const rowCounts = Array.from(
    { length: rows },
    (_, r) => base + (r < extra ? 1 : 0),
  );
  const ch = h / rows;
  const sites: Pt[] = [];
  rowCounts.forEach((count, r) => {
    const cw = w / count;
    for (let c = 0; c < count; c++) {
      const jx = (rng() * 2 - 1) * jitter * cw;
      const jy = (rng() * 2 - 1) * jitter * ch;
      sites.push({ x: (c + 0.5) * cw + jx, y: (r + 0.5) * ch + jy });
    }
  });
  return sites;
}

/* ---------- card shapes ---------- */

/**
 * An irregular convex polygon for a card, expressed in percent of the card
 * box so it scales with the element. Corners of the rectangle are chamfered
 * by random depths, giving a cut-glass silhouette with 5–8 vertices that
 * never clips the content region inset by `safe` percent.
 */
export function cardPolygonPercent(rng: () => number, safe = 12): Poly {
  const cut = () => safe * (0.35 + rng() * 0.65);
  const maybe = () => rng() > 0.22;
  const pts: Poly = [];
  // top-left
  if (maybe()) {
    const a = cut();
    const b = cut();
    pts.push({ x: 0, y: b }, { x: a, y: 0 });
  } else pts.push({ x: 0, y: 0 });
  // top-right
  if (maybe()) {
    const a = cut();
    const b = cut();
    pts.push({ x: 100 - a, y: 0 }, { x: 100, y: b });
  } else pts.push({ x: 100, y: 0 });
  // bottom-right
  if (maybe()) {
    const a = cut();
    const b = cut();
    pts.push({ x: 100, y: 100 - b }, { x: 100 - a, y: 100 });
  } else pts.push({ x: 100, y: 100 });
  // bottom-left
  if (maybe()) {
    const a = cut();
    const b = cut();
    pts.push({ x: a, y: 100 }, { x: 0, y: 100 - b });
  } else pts.push({ x: 0, y: 100 });
  return pts;
}

/** `polygon(x% y%, …)` for CSS clip-path from a percent-space polygon. */
export function toClipPathPercent(poly: Poly, precision = 2): string {
  const f = (v: number) => v.toFixed(precision).replace(/\.?0+$/, "");
  return `polygon(${poly.map((p) => `${f(p.x)}% ${f(p.y)}%`).join(", ")})`;
}

/** `polygon(xpx ypx, …)` for CSS clip-path from a pixel-space polygon. */
export function toClipPathPx(poly: Poly, precision = 1): string {
  const f = (v: number) => v.toFixed(precision).replace(/\.?0+$/, "");
  return `polygon(${poly.map((p) => `${f(p.x)}px ${f(p.y)}px`).join(", ")})`;
}

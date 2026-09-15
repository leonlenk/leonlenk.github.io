import {
  bbox,
  centroid,
  containsPoint,
  mulberry32,
  polygonArea,
  type Poly,
  type Pt,
} from "./geometry";

export interface InclusionFleck {
  poly: Poly;
  opacity: number;
  /** Relative halo strength from 0 to 1; most grains have no halo. */
  glow: number;
}

export interface CrystalInclusions {
  flecks: InclusionFleck[];
}

/**
 * A sparse, stable scatter of mineral grains inside a convex crystal face.
 * A small best-candidate sample leaves uneven areas of clear glass, with a
 * minority of grains gathering into loose pairs or trios around existing grains.
 */
export function generateInclusions(
  poly: Poly,
  seed: number,
  options: { density?: number } = {},
): CrystalInclusions {
  const result: CrystalInclusions = { flecks: [] };
  if (poly.length < 3 || poly.some((p) => !Number.isFinite(p.x + p.y)))
    return result;
  const area = Math.abs(polygonArea(poly));
  if (area < 100) return result;
  const rng = mulberry32(seed);
  const b = bbox(poly);
  const center = centroid(poly);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const density = Number.isFinite(options.density)
    ? Math.max(0, Math.min(3, options.density!))
    : 1;
  const desired = Math.min(
    30,
    Math.round(
      Math.min(10, Math.sqrt(area) / 42) * (0.82 + rng() * 0.36) * density,
    ),
  );
  if (desired === 0) return result;
  const spacing = Math.sqrt(area / desired);
  const phaseX = rng() * Math.PI * 2;
  const phaseY = rng() * Math.PI * 2;
  const placed: { p: Pt; radius: number }[] = [];
  const anchors: { p: Pt; radius: number; satellites: number }[] = [];
  const satelliteCount = Math.round(desired * 0.3);
  for (let index = 0; index < desired; index++) {
    // Separate size populations keep a handful of substantial inclusions among
    // smaller grains. Compact facets do not resemble needles or scratches.
    const radius =
      rng() < 0.24 ? 1.9 + rng() * 1.6 : 0.55 + Math.pow(rng(), 1.5) * 0.95;
    const available = anchors.filter((anchor) => anchor.satellites < 2);
    const anchor =
      index >= desired - satelliteCount && available.length
        ? available[Math.floor(rng() * available.length)]
        : undefined;
    const clearance = anchor ? 6 : spacing * (0.19 + rng() * 0.18);
    let best: Pt | undefined;
    let bestScore = -Infinity;
    let valid = 0;
    const candidates = 3 + Math.floor(rng() * 4);
    for (let attempt = 0; attempt < 90 && valid < candidates; attempt++) {
      let p: Pt;
      if (anchor) {
        const direction = rng() * Math.PI * 2;
        const offset =
          6 +
          radius +
          anchor.radius +
          Math.pow(rng(), 1.3) * Math.min(32, spacing * 0.32);
        p = {
          x: anchor.p.x + Math.cos(direction) * offset,
          y: anchor.p.y + Math.sin(direction) * offset,
        };
      } else p = { x: b.x0 + rng() * w, y: b.y0 + rng() * h };
      if (!containsPoint(poly, p)) continue;
      // A low-frequency field thins broad, irregular regions of the scatter.
      const field =
        0.66 +
        0.2 * Math.sin(((p.x - b.x0) / w) * 3.5 + phaseX) +
        0.14 * Math.sin(((p.y - b.y0) / h) * 4.2 + phaseY);
      if (!anchor && rng() > field) continue;
      const central =
        Math.pow((p.x - center.x) / (w * 0.24), 2) +
        Math.pow((p.y - center.y) / (h * 0.17), 2);
      if (central < 1 && rng() < 0.7) continue;
      // Grain-sized boundary clearance also makes every rendered facet fit.
      let boundary = Infinity;
      for (let edge = 0; edge < poly.length; edge++) {
        const a = poly[edge];
        const z = poly[(edge + 1) % poly.length];
        const length = Math.hypot(z.x - a.x, z.y - a.y);
        if (length > 0)
          boundary = Math.min(
            boundary,
            Math.abs((z.x - a.x) * (p.y - a.y) - (z.y - a.y) * (p.x - a.x)) /
              length,
          );
      }
      if (boundary < radius * 1.45 + 2) continue;
      let nearest = spacing;
      for (const other of placed)
        nearest = Math.min(
          nearest,
          Math.hypot(p.x - other.p.x, p.y - other.p.y) - radius - other.radius,
        );
      if (nearest < clearance) continue;
      valid++;
      // Saturate the spacing reward and randomize it: pure farthest-point
      // placement becomes conspicuously even at these very small counts.
      const score = anchor
        ? rng()
        : Math.min(nearest / spacing, 0.65) * (0.65 + rng() * 0.7);
      if (score > bestScore) {
        best = p;
        bestScore = score;
      }
    }
    if (!best) continue;
    const p = best;
    const angle = rng() * Math.PI * 2;
    const stretch = 1 + rng() * 0.35;
    const sides = 4 + Math.floor(rng() * 3);
    const grain = Array.from({ length: sides }, (_, i) => {
      const theta = ((i + (rng() - 0.5) * 0.35) * Math.PI * 2) / sides;
      const r = radius * (0.65 + rng() * 0.35);
      const x = Math.cos(theta) * r * stretch;
      const y = Math.sin(theta) * r * (0.8 + rng() * 0.2);
      return {
        x: p.x + x * Math.cos(angle) - y * Math.sin(angle),
        y: p.y + x * Math.sin(angle) + y * Math.cos(angle),
      };
    });
    if (!grain.every((vertex) => containsPoint(poly, vertex))) continue;
    placed.push({ p, radius });
    if (anchor) anchor.satellites++;
    else anchors.push({ p, radius, satellites: 0 });
    result.flecks.push({
      poly: grain,
      opacity: 0.3 + Math.pow(rng(), 1.2) * 0.55,
      glow: rng() < 0.3 ? 0.25 + rng() * 0.65 : 0,
    });
  }
  return result;
}

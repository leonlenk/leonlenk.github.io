import { hashString, mulberry32, type Pt, type Poly } from "../lib/geometry";
import { LAYOUT_SEED } from "../lib/field-layout";
import type { Cell } from "./field-types";
export const T_NUCLEATE = 800;
const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
/** Seed and crystal axes cached once; each frame only scales six vertices. */
export interface Growth {
  seed: Pt;
  cs: number;
  sn: number;
  radius: number;
  stretch: number;
  rateX: number;
  rateY: number;
  start: number;
  duration: number;
  face: Poly;
}

export function buildGrowths(cells: Cell[]): Growth[] {
  return cells.map((cell, index) => {
    const rng = mulberry32(
      hashString(`growth:${cell.shard?.id ?? index}`) ^ LAYOUT_SEED,
    );
    const corner = cell.inner[Math.floor(rng() * cell.inner.length)];
    const offset = 0.08 + rng() * 0.1;
    const seed = {
      x: lerp(cell.c.x, corner.x, offset),
      y: lerp(cell.c.y, corner.y, offset),
    };
    const angle = Math.atan2(cell.ly, cell.lx) + (rng() - 0.5) * 0.5;
    let farthest = 0;
    for (const vertex of cell.inner)
      farthest = Math.max(
        farthest,
        Math.hypot(vertex.x - seed.x, vertex.y - seed.y),
      );
    // A regular hexagon's inradius is cos(π/6) times its radius. This
    // margin ensures even the slower axis covers every final corner.
    const radius = farthest * 1.2;
    return {
      seed,
      cs: Math.cos(angle),
      sn: Math.sin(angle),
      radius,
      stretch: 1.15 + rng() * 0.55,
      rateX: 0.7 + rng() * 0.3,
      rateY: 0.9 + rng() * 0.35,
      start: T_NUCLEATE + rng() * 600,
      duration: 1550 + rng() * 650,
      face: Array.from({ length: 6 }, () => ({ x: 0, y: 0 })),
    };
  });
}

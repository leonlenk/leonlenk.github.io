import { mixHex, withAlpha } from "./color";
import {
  generateInclusions,
  type CrystalInclusions,
} from "./crystal-inclusions";
import type { Poly } from "./geometry";

/** Paint mineral geometry for the whole crystal, once per layout. Grains
 * have independent sizes, depth and reflectivity. */
export function paintCrystalLight(
  g: CanvasRenderingContext2D,
  polygon: Poly,
  seed: number,
  colour: string,
  strength: number,
): CrystalInclusions {
  const inclusions = generateInclusions(polygon, seed);
  const bright = mixHex(colour, "#f5f0ff", 0.65);
  g.save();
  for (const fleck of inclusions.flecks) {
    if (fleck.glow > 0.45) {
      const x = fleck.poly.reduce((sum, p) => sum + p.x, 0) / fleck.poly.length;
      const y = fleck.poly.reduce((sum, p) => sum + p.y, 0) / fleck.poly.length;
      const r =
        Math.max(...fleck.poly.map((p) => Math.hypot(p.x - x, p.y - y))) * 4;
      const glow = g.createRadialGradient(x, y, 0, x, y, r);
      glow.addColorStop(0, withAlpha(colour, strength * fleck.glow * 0.35));
      glow.addColorStop(1, withAlpha(colour, 0));
      g.fillStyle = glow;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.beginPath();
    g.moveTo(fleck.poly[0].x, fleck.poly[0].y);
    for (let i = 1; i < fleck.poly.length; i++)
      g.lineTo(fleck.poly[i].x, fleck.poly[i].y);
    g.closePath();
    g.fillStyle = withAlpha(
      mixHex(colour, bright, 0.35 + fleck.glow * 0.65),
      strength * fleck.opacity,
    );
    g.fill();
  }
  g.restore();
  return inclusions;
}

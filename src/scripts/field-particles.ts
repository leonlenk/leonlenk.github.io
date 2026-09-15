import { mixHex, withAlpha } from "../lib/color";
import { mulberry32 } from "../lib/geometry";
import { LAYOUT_SEED } from "../lib/field-layout";
import type { Cell } from "./field-types";
const FILLER_DENSITY = 0.6;
const SPRITE_RADII = [8, 12, 16] as const;
const TONES = 3;
const TAU = Math.PI * 2;
const ramp = (t: number, a: number, b: number): number =>
  Math.max(0, Math.min(1, (t - a) / (b - a)));
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  cell: number;
  tone: number;
  size: number;
  phase: number;
  alpha: number;
}

export function createFieldParticles(
  ctx: CanvasRenderingContext2D,
  coarse: boolean,
  getFrame: () => { w: number; h: number; dpr: number; cells: Cell[] },
  cellAt: (x: number, y: number) => number,
) {
  let particles: Particle[] = [];
  let sprites = new Map<string, HTMLCanvasElement[]>();
  let spriteDpr = 0;
  /* ----- particles ----- */

  function spriteKey(cell: Cell): string {
    return cell.shard ? cell.shard.id : `filler:${cell.edge[0]}${cell.edge[1]}`;
  }

  /** Glow sprites: per cell colour, three tones along its edge gradient,
   * three radii. Built per colour on first use for the current dpr; only
   * the intro needs them. */
  function spritesFor(cell: Cell, dpr: number): HTMLCanvasElement[] {
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

  function spawn(): void {
    const { w, h, cells } = getFrame();
    const n = !coarse && Math.min(w, h) >= 700 ? 36 : 18;
    const rng = mulberry32(LAYOUT_SEED ^ 0x9e3779b9);
    particles = [];
    for (let i = 0; i < n; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const cell = cellAt(x, y);
      if (!cells[cell].shard && rng() > FILLER_DENSITY) continue;
      particles.push({
        x,
        y,
        vx: (rng() * 2 - 1) * 3,
        vy: -2 - rng() * 3,
        cell,
        tone: Math.min(TONES - 1, Math.floor(rng() * TONES)),
        size: 0,
        phase: rng() * TAU,
        alpha: 0.12 + rng() * 0.18,
      });
    }
  }

  /** A few suspended motes drift throughout growth, with no seam targets. */
  function updateParticles(t: number, dt: number): void {
    const seconds = Math.min(dt, 80) / 1000;
    for (const p of particles) {
      p.x += (p.vx + Math.sin(t * 0.0005 + p.phase)) * seconds;
      p.y += p.vy * seconds;
    }
  }

  function draw(t: number, mul: number, settleTime: number): void {
    const { cells, dpr } = getFrame();
    const visibility = ramp(t, 0, 500) * (1 - ramp(t, 2100, settleTime));
    if (mul <= 0 || visibility <= 0 || particles.length === 0) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const p of particles) {
      const list = spritesFor(cells[p.cell], dpr);
      const r = SPRITE_RADII[p.size] * 0.65;
      ctx.globalAlpha = visibility * p.alpha * mul;
      ctx.drawImage(
        list[p.tone * SPRITE_RADII.length + p.size],
        p.x - r,
        p.y - r,
        r * 2,
        r * 2,
      );
    }
    ctx.restore();
  }

  function remap(): void {
    for (const p of particles) p.cell = cellAt(p.x, p.y);
  }
  function clear(): void {
    particles = [];
    sprites.clear();
  }
  return { spawn, update: updateParticles, draw, remap, clear };
}

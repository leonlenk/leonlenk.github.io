import type { Shard } from "../data/shards";
import type { BBox, Poly, Pt } from "../lib/geometry";

/** An offscreen bitmap covering a viewport-space rectangle, snapped to the
 * device-pixel grid so every blit is a 1:1 copy. Its context is set up so
 * drawing in viewport coordinates lands in the right place. */
export interface Layer {
  canvas: HTMLCanvasElement;
  g: CanvasRenderingContext2D;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Cell {
  /** null for a filler. */
  shard: Shard | null;
  /** null for a filler. */
  link: HTMLAnchorElement | null;
  edge: readonly [string, string];
  mid: string;
  /** Seam gradient colours, evenly spaced: around the outline from the
   * conic start angle when `seamConic`, else across `bb` (linear). */
  seam: readonly string[];
  seamConic: boolean;
  /** The seam gradient for `inner` at full alpha (stroke with globalAlpha). */
  seamStroke: CanvasGradient;
  /** Fillers only: the undulled gem palette (same layout as `seam`) that
   * the cursor light paints, so the light reveals the gem in the rock. */
  litSeam?: readonly string[];
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
  /** Unit vector toward the light as this slab sees it (KEY_LIGHT, tilted). */
  lx: number;
  ly: number;
  /** Shading amplitude: how steeply the slab is tilted. */
  amp: number;
  /** Art-directed shelter from the fixed top light, independent of the mouse. */
  keyExposure: number;
  /** This pane's magnification of the sky. */
  refract: number;
  /** The prism's inner face (same vertex order as `inner`), null only for
   * a degenerate cell with fewer than three vertices. */
  face: Poly | null;
  /** Per outer edge: the side face's fill alpha, positive for white
   * (toward the light), negative for black (away). */
  faceShade: number[];
  /** Cached mineral surfaces for pointer-driven specular glints. */
  mineralGlints?: {
    poly: Poly;
    x: number;
    y: number;
    radius: number;
    axis: number;
    gain: number;
  }[];
}

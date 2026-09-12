// Tiny colour helpers shared by build-time (card variants, shard tokens) and
// client (canvas seams) code. Hex in, hex or rgba() out. No dependencies.

export type Rgb = [number, number, number];
export type Hsl = [number, number, number]; // degrees, 0–100, 0–100

export function hexToRgb(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const to = (x: number) =>
    Math.round(Math.max(0, Math.min(255, x)))
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

export function hslToHex([h, s, l]: Hsl): string {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) =>
    l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}

/** `rgba(r,g,b,a)` string for canvas and CSS. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** sRGB midpoint (t=0.5) or any lerp between two hexes. */
export function mixHex(a: string, b: string, t = 0.5): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex([
    A[0] + (B[0] - A[0]) * t,
    A[1] + (B[1] - A[1]) * t,
    A[2] + (B[2] - A[2]) * t,
  ]);
}

/** Rotate hue by `deg` and nudge lightness/saturation, clamped. */
export function shiftHex(hex: string, deg: number, dl = 0, ds = 0): string {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return hslToHex([
    h + deg,
    Math.max(0, Math.min(100, s + ds)),
    Math.max(0, Math.min(100, l + dl)),
  ]);
}

/**
 * Per-post variant of a shard's edge pair: small hue rotation and lightness
 * nudge keyed on the post's position, so siblings differ but stay inside
 * their shard's slice of the spectrum.
 */
export function variantPair(
  edge: readonly [string, string],
  index: number,
): [string, string] {
  const steps = [0, -9, 9, -4, 5, -13, 12];
  const light = [0, 4, -4, 7, -6, 2, -2];
  const k = index % steps.length;
  return [
    shiftHex(edge[0], steps[k], light[k]),
    shiftHex(edge[1], steps[k], light[k]),
  ];
}

interface Grain {
  el: SVGPolygonElement;
  x: number;
  y: number;
  nx: number;
  ny: number;
  reach: number;
  sharpness: number;
  lit: boolean;
}

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const coarsePointer = window.matchMedia("(pointer: coarse)");
let grains: Grain[] = [];
let frame = 0;
let pointerX = 0;
let pointerY = 0;

function unlight(): void {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  for (const grain of grains) {
    if (grain.lit) grain.el.style.removeProperty("--grain-glint");
    grain.lit = false;
  }
}

function measure(): void {
  unlight();
  grains = [];
  document
    .querySelectorAll<SVGPolygonElement>(".mineral-field .mineral-grain")
    .forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const matrix = el.getScreenCTM();
      if (!matrix) return;
      const angle = Number(el.dataset.grainAngle);
      const phase = Number(el.dataset.grainPhase);
      // Transform each grain's cleavage direction along with the SVG.
      // Its perpendicular is the small face's specular orientation.
      const tx = matrix.a * Math.cos(angle) + matrix.c * Math.sin(angle);
      const ty = matrix.b * Math.cos(angle) + matrix.d * Math.sin(angle);
      const length = Math.hypot(tx, ty) || 1;
      grains.push({
        el,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        nx: -ty / length,
        ny: tx / length,
        reach: 170 + phase * 80,
        sharpness: 14 + phase * 22,
        lit: false,
      });
    });
}

function illuminate(): void {
  frame = 0;
  for (const grain of grains) {
    const dx = pointerX - grain.x;
    const dy = pointerY - grain.y;
    // Outside this radius both the angular lobe and direct Gaussian are
    // below the paint threshold. Avoid trigonometry and exponentials for
    // the many grains that cannot catch the cursor light.
    if (dx * dx + dy * dy > grain.reach * grain.reach) {
      if (grain.lit) grain.el.style.removeProperty("--grain-glint");
      grain.lit = false;
      continue;
    }
    const distance = Math.hypot(dx, dy);
    // Direct light always catches a nearby grain. Farther away, a softer
    // angular lobe retains the impression of differently oriented faces.
    const alignment =
      Math.abs(dx * grain.nx + dy * grain.ny) / Math.max(1, distance);
    const proximity = Math.max(0, 1 - distance / grain.reach);
    const direct = 0.85 * Math.exp(-(distance * distance) / (2 * 30 * 30));
    const glint = Math.min(
      1,
      direct +
        0.28 * Math.pow(alignment, grain.sharpness) * proximity * proximity,
    );
    if (glint > 0.005) {
      grain.el.style.setProperty("--grain-glint", glint.toFixed(3));
      grain.lit = true;
    } else if (grain.lit) {
      grain.el.style.removeProperty("--grain-glint");
      grain.lit = false;
    }
  }
}

function move(event: PointerEvent): void {
  if (event.pointerType === "touch") return;
  pointerX = event.clientX;
  pointerY = event.clientY;
  if (!frame) frame = requestAnimationFrame(illuminate);
}

function leave(event: PointerEvent): void {
  if (event.relatedTarget === null) unlight();
}

function stop(): void {
  document.removeEventListener("pointermove", move);
  document.removeEventListener("pointerout", leave);
  window.removeEventListener("blur", unlight);
  window.removeEventListener("resize", measure);
  unlight();
  grains = [];
}

function start(): void {
  stop();
  if (reducedMotion.matches || coarsePointer.matches) return;
  measure();
  if (!grains.length) return;
  document.addEventListener("pointermove", move, { passive: true });
  document.addEventListener("pointerout", leave, { passive: true });
  window.addEventListener("blur", unlight);
  window.addEventListener("resize", measure, { passive: true });
}

document.addEventListener("astro:page-load", start);
document.addEventListener("astro:before-swap", stop);
reducedMotion.addEventListener("change", start);
coarsePointer.addEventListener("change", start);

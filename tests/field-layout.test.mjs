import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// Transpile the pure layout modules into a scratch directory and import them.
const dir = mkdtempSync(join(tmpdir(), "field-layout-"));
after(() => rmSync(dir, { recursive: true, force: true }));
for (const name of ["geometry", "field-layout"]) {
  const source = readFileSync(
    new URL(`../src/lib/${name}.ts`, import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
  });
  writeFileSync(
    join(dir, `${name}.mjs`),
    outputText.replace(/from "\.\/geometry"/g, 'from "./geometry.mjs"'),
  );
}
const layoutModule = await import(
  pathToFileURL(join(dir, "field-layout.mjs")).href
);
const geometry = await import(pathToFileURL(join(dir, "geometry.mjs")).href);
const { layoutField, assignGhosts, RIM_BAND, RIM_KEEP_LABELLED } = layoutModule;
const { polygonArea, centroid } = geometry;

const LABELS = ["Writing", "Research", "Food", "Art", "Self", "AI"];
const widths = (w) => {
  const size = Math.min(20, Math.max(13, 0.0125 * w + 6));
  return LABELS.map((label) => label.length * 0.82 * size);
};
const area = (cell) => Math.abs(polygonArea(cell.inner));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};
const VIEWPORTS = [
  [1440, 900],
  [1280, 800],
  [1920, 1080],
  [390, 844],
  [360, 740],
];

test("the layout is deterministic, rim crust included", () => {
  for (const [w, h] of VIEWPORTS) {
    const a = layoutField(w, h, 6, {}, widths(w));
    const b = layoutField(w, h, 6, {}, widths(w));
    assert.deepEqual(a, b);
  }
});

test("rim fillers add to the field without moving the inner sites", () => {
  for (const [w, h] of VIEWPORTS) {
    const plain = layoutField(w, h, 6, { rimFillers: 0 }, widths(w));
    const crust = layoutField(w, h, 6, {}, widths(w));
    assert.equal(plain.cells.filter((c) => c.rim).length, 0);
    const sites = (layout) =>
      layout.cells.filter((c) => !c.rim).map((c) => `${c.site.x},${c.site.y}`);
    // Every rimless site is still there (a rim crystal never displaces one).
    assert.deepEqual(new Set(sites(crust)), new Set(sites(plain)));
  }
  // The reference viewports gain a crust: about six on desktop, a few on
  // a phone.
  const rimCount = (w, h) =>
    layoutField(w, h, 6, {}, widths(w)).cells.filter((c) => c.rim).length;
  assert.ok(rimCount(1440, 900) >= 5);
  assert.ok(rimCount(390, 844) >= 2);
});

test("rim fillers hug the edges and stay smaller than the inner ones", () => {
  for (const [w, h] of VIEWPORTS) {
    const layout = layoutField(w, h, 6, {}, widths(w));
    const band = RIM_BAND * Math.min(w, h);
    const inner = median(
      layout.cells.filter((c) => c.labelled < 0 && !c.rim).map(area),
    );
    for (const cell of layout.cells.filter((c) => c.rim)) {
      const { x, y } = cell.site;
      assert.ok(Math.min(x, w - x, y, h - y) <= band + 1e-6);
      assert.ok(area(cell) < inner, `${w}×${h}: rim cell smaller than median`);
    }
  }
});

test("the crust costs the labelled shards little", () => {
  for (const [w, h] of VIEWPORTS) {
    const plain = layoutField(w, h, 6, { rimFillers: 0 }, widths(w));
    const crust = layoutField(w, h, 6, {}, widths(w));
    if (plain.anisotropy !== crust.anisotropy) continue;
    for (let i = 0; i < 6; i++) {
      const before = plain.cells.find((c) => c.labelled === i);
      const now = crust.cells.find((c) => c.labelled === i);
      assert.ok(before && now);
      assert.ok(area(now) >= RIM_KEEP_LABELLED * area(before) - 1e-6);
    }
  }
});

test("ghosts land on inner fillers, never on the rim crust", () => {
  const words = Array.from({ length: 20 }, (_, i) => `word${i}`);
  for (const [w, h] of VIEWPORTS) {
    const layout = layoutField(w, h, 6, {}, widths(w));
    for (const seed of [1, 2, 3]) {
      for (const ghost of assignGhosts(layout, w, seed, words, ["a phrase"])) {
        const cell = layout.cells[ghost.cell];
        assert.equal(cell.labelled, -1);
        assert.equal(cell.rim, false);
        const c = centroid(cell.inner);
        assert.ok(Number.isFinite(c.x));
      }
    }
  }
});

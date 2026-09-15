import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the component's actual script across Astro swaps, including the
// initial double mount. Canvas painting is stubbed; subscriptions are real sets.
function scene(initiallyHome = true) {
  const events = new EventTarget();
  const listeners = new Set();
  const bitmap = { canvas: {}, w: 100, h: 100, version: 1 };
  function makeCanvas() {
    const canvas = { width: 0, height: 0, paints: 0 };
    const ctx = {
      drawImage: () => canvas.paints++,
      beginPath() {},
      arc() {},
      fill() {},
    };
    canvas.getContext = () => ctx;
    return canvas;
  }
  let current = initiallyHome ? makeCanvas() : null;
  const source = readFileSync(
    new URL("../src/components/Nebula.astro", import.meta.url),
    "utf8",
  );
  const script = source.match(/<script>([\s\S]*?)<\/script>/)[1];
  const { outputText } = ts.transpileModule(script, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  runInNewContext(outputText, {
    exports: {},
    require: () => ({
      NEBULA_SEED: 1,
      mulberry32: () => () => 0.5,
      getSharedNebula: () => bitmap,
      subscribeNebula: (paint) => {
        listeners.add(paint);
        return () => listeners.delete(paint);
      },
    }),
    document: {
      querySelector: () => current,
      addEventListener: events.addEventListener.bind(events),
    },
    window: { innerWidth: 100, innerHeight: 100, devicePixelRatio: 1 },
  });
  return {
    listeners,
    get canvas() {
      return current;
    },
    load: () => events.dispatchEvent(new Event("astro:page-load")),
    beforeSwap: () => events.dispatchEvent(new Event("astro:before-swap")),
    replace: (home) => {
      current = home ? makeCanvas() : null;
    },
    resize: () => {
      for (const paint of listeners) paint(bitmap);
    },
  };
}

test("home → section → home repaints the new canvas and releases the old one", () => {
  const app = scene();
  const old = app.canvas;
  assert.equal(old.paints, 1);
  app.load();
  assert.equal(old.paints, 1, "initial page-load must not double-mount");
  assert.equal(app.listeners.size, 1);
  app.beforeSwap();
  app.replace(false);
  app.load();
  assert.equal(app.listeners.size, 0);
  app.resize();
  assert.equal(old.paints, 1, "detached canvas must not receive resize paints");
  app.beforeSwap();
  app.replace(true);
  app.load();
  assert.equal(app.canvas.paints, 1);
  assert.equal(app.listeners.size, 1);
  app.resize();
  assert.equal(app.canvas.paints, 2);
  assert.equal(old.paints, 1);
});

test("entering home from a section mounts once; a persisted canvas rebinds once", () => {
  const app = scene(false);
  app.load();
  assert.equal(app.listeners.size, 0);
  app.beforeSwap();
  app.replace(true);
  app.load();
  const canvas = app.canvas;
  assert.equal(canvas.paints, 1);
  app.beforeSwap();
  app.load();
  app.load();
  assert.equal(app.listeners.size, 1);
  assert.equal(canvas.paints, 2);
});

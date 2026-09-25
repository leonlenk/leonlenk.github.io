import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { soundScene } from "./audio-harness.mjs";

test("ambient music is on by default and starts on the first gesture", async () => {
  const app = soundScene();
  assert.equal(app.audio.getSoundMode(), "ambient");
  assert.equal(app.attributeValues.get("data-sound"), "ambient");
  app.audio.unlockAudio(); // before any gesture: nothing
  assert.equal(app.ctx, null);
  assert.equal(app.elements.length, 0);
  app.gesture("pointerdown");
  assert.ok(app.elements.some((el) => el.plays > 0));
  assert.equal(app.oscillators.length, 0); // the music is not synthesised
});

test("a visitor who chose chimes only gets no music", async () => {
  const app = soundScene({ stored: { "shards:sound": "chimes" } });
  assert.equal(app.audio.getSoundMode(), "chimes");
  app.gesture("click");
  await app.settle();
  assert.equal(app.elements.length, 0);
  app.audio.chimeForShard("art");
  assert.ok(app.oscillators.length > 0);
  app.audio.setSoundMode("ambient");
  assert.ok(app.elements.some((el) => el.plays > 0));
  assert.equal(app.storage.get("shards:sound"), "ambient");
});

test("mute stops clicked voices without cancelAndHoldAtTime", async () => {
  const app = soundScene();
  app.gesture("pointerdown");
  await app.settle();
  app.audio.chimeForShard("art");
  const chimeOscillators = app.oscillators.length;
  assert.ok(chimeOscillators > 0);
  let changes = 0;
  app.events.addEventListener("chime:muted-change", () => changes++);
  assert.doesNotThrow(() => app.audio.toggleMuted());
  assert.equal(app.audio.isMuted(), true);
  assert.ok(app.attributes.has("data-muted"));
  assert.equal(changes, 1);
  assert.ok(app.oscillators.every((osc) => osc.stops.length >= 2));
  app.audio.chimeForShard("food");
  assert.equal(app.oscillators.length, chimeOscillators);
  app.clock.advance(5000);
  assert.equal(app.ctx.state, "suspended");
  app.audio.toggleMuted();
  assert.equal(app.audio.getSoundMode(), "ambient");
});

test("shard notes all sit in G major pentatonic", () => {
  const app = soundScene();
  const pentatonic = new Set([7, 9, 11, 2, 4]);
  for (const id of ["writing", "research", "self", "ai", "art", "food"]) {
    const midi = 69 + 12 * Math.log2(app.audio.noteForShard(id) / 440);
    assert.ok(Math.abs(midi - Math.round(midi)) < 1e-9);
    assert.ok(pentatonic.has(((Math.round(midi) % 12) + 12) % 12), id);
  }
});

test("the stored sound mode is restored, including the legacy mute key", () => {
  assert.equal(
    soundScene({ stored: { "shards:sound": "muted" } }).audio.getSoundMode(),
    "muted",
  );
  assert.equal(
    soundScene({ stored: { "shards:muted": "true" } }).audio.getSoundMode(),
    "muted",
  );
});

test("a pending start cannot restart audio after muting", async () => {
  const app = soundScene({ state: "suspended" });
  app.gesture("keydown");
  app.audio.toggleMuted();
  await app.settle();
  app.clock.advance(5000);
  assert.equal(app.audio.isMuted(), true);
  assert.ok(app.elements.every((el) => el.paused));
});

test("the sound button's own press never starts the music", () => {
  const app = soundScene();
  const button = { closest: (sel) => (sel === "button.mute" ? button : null) };
  app.gesture("pointerdown", button);
  assert.equal(app.elements.length, 0);
});

test("sound button cycles modes while suspended and resyncs its icon after navigation", async () => {
  const app = soundScene();
  let pendingUnlock = () => {};
  function makeButton() {
    const button = new EventTarget();
    button.dataset = {};
    button.attributes = {};
    button.setAttribute = (name, value) => {
      button.attributes[name] = value;
    };
    button.removeAttribute = (name) => {
      delete button.attributes[name];
    };
    return button;
  }
  let button = makeButton();
  app.document.querySelector = (selector) =>
    selector === "button.mute" ? button : null;
  const source = readFileSync(
    new URL("../src/components/Chrome.astro", import.meta.url),
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
      ...app.audio,
      audioAvailable: () => false,
      unlockAudio: () => pendingUnlock(),
    }),
    document: app.document,
    window: { scrollY: 0, removeEventListener() {}, addEventListener() {} },
  });
  app.events.dispatchEvent(new Event("astro:page-load"));
  assert.equal(
    button.attributes["aria-label"],
    "Sound: chimes and ambient music",
  );
  // Nothing has played yet: the tooltip and description say how to start.
  assert.equal(button.title, "Sound begins on your first click");
  assert.equal(button.attributes["aria-describedby"], "sound-hint");
  // A click while pending starts the sound instead of stepping the mode.
  let unlocked = 0;
  pendingUnlock = () => unlocked++;
  button.dispatchEvent(new Event("click"));
  assert.equal(unlocked, 1);
  assert.equal(app.audio.getSoundMode(), "ambient");
  app.gesture("pointerdown");
  await app.settle();
  button.dispatchEvent(new Event("click"));
  assert.equal(app.audio.getSoundMode(), "chimes");
  assert.equal(button.attributes["aria-describedby"], undefined);
  assert.equal(app.storage.get("shards:sound"), "chimes");
  assert.equal(button.attributes["aria-label"], "Sound: chimes only");
  assert.equal(button.title, "Chimes only. Click to turn sound off");
  button.dispatchEvent(new Event("click"));
  assert.equal(app.audio.isMuted(), true);
  assert.equal(button.attributes["aria-label"], "Sound: off");
  assert.equal(button.title, "Sound off. Click to turn it back on");
  app.attributes.clear(); // Astro replaces the document's HTML attributes.
  button = makeButton();
  app.events.dispatchEvent(new Event("astro:page-load"));
  assert.ok(app.attributes.has("data-muted"));
  assert.equal(app.attributeValues.get("data-sound"), "muted");
  assert.equal(button.attributes["aria-label"], "Sound: off");
  button.dispatchEvent(new Event("click"));
  assert.equal(app.audio.getSoundMode(), "ambient");
});

test("the pending hint shows until the music starts", async () => {
  const app = soundScene();
  // Fresh visit, ambient by default, nothing played yet.
  assert.ok(app.attributes.has("data-sound-pending"));
  assert.equal(app.audio.isSoundPending(), true);
  app.gesture("pointerdown");
  assert.ok(app.attributes.has("data-sound-pending")); // loading, not playing
  await app.settle();
  assert.equal(app.attributes.has("data-sound-pending"), false);
});

test("the pending hint clears when switching away from ambient", () => {
  const app = soundScene();
  assert.ok(app.attributes.has("data-sound-pending"));
  app.audio.setSoundMode("chimes");
  assert.equal(app.attributes.has("data-sound-pending"), false);
  app.audio.setSoundMode("muted");
  assert.equal(app.attributes.has("data-sound-pending"), false);
  // Back to ambient before any gesture: waiting again.
  app.audio.setSoundMode("ambient");
  assert.ok(app.attributes.has("data-sound-pending"));
});

test("the pending hint never shows when autoplay succeeds on reload", async () => {
  const app = soundScene({
    stored: { "shards:sound": "ambient" },
    state: "suspended",
  });
  assert.equal(app.attributes.has("data-sound-pending"), false);
  await app.settle();
  assert.equal(app.attributes.has("data-sound-pending"), false);
  assert.ok(app.elements.some((el) => !el.paused));
});

test("the pending hint appears once autoplay is refused", async () => {
  const app = soundScene({
    stored: { "shards:sound": "ambient" },
    state: "suspended",
    autoplay: "blocked",
  });
  assert.equal(app.attributes.has("data-sound-pending"), false);
  app.clock.advance(1000);
  await app.settle();
  assert.ok(app.attributes.has("data-sound-pending"));
});

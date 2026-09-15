import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function soundScene() {
  const events = new EventTarget();
  const attributes = new Set();
  const oscillators = [];
  const timers = new Map();
  let timerId = 0;
  // Deliberately omit cancelAndHoldAtTime, as in browsers without that API.
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
    setTargetAtTime() {},
  });
  const node = () => ({
    gain: param(),
    frequency: param(),
    detune: param(),
    pan: param(),
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
    Q: param(),
    connect() {},
    disconnect() {},
    start() {},
    stops: [],
    stop(t) {
      this.stops.push(t);
    },
  });
  class AudioContext {
    state = "running";
    currentTime = 10;
    sampleRate = 100;
    destination = {};
    async resume() {}
    createGain = node;
    createStereoPanner = node;
    createDynamicsCompressor = node;
    createConvolver = node;
    createBiquadFilter = node;
    createBufferSource = node;
    createOscillator() {
      const osc = node();
      oscillators.push(osc);
      return osc;
    }
    createBuffer(_channels, length) {
      return { getChannelData: () => new Float32Array(length) };
    }
  }
  const document = {
    hidden: false,
    documentElement: {
      toggleAttribute(name, enabled) {
        if (enabled) attributes.add(name);
        else attributes.delete(name);
      },
    },
    addEventListener: events.addEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  const window = {
    AudioContext,
    setTimeout(fn, delay) {
      timers.set(++timerId, { fn, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  const audio = {};
  const source = readFileSync(
    new URL("../src/scripts/chime.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  runInNewContext(outputText, {
    exports: audio,
    document,
    window,
    Event,
    CustomEvent,
    performance,
    setTimeout: window.setTimeout,
  });
  return { audio, events, attributes, oscillators, timers, document };
}

test("mute stops ambient and clicked voices without cancelAndHoldAtTime", async () => {
  const app = soundScene();
  app.audio.unlockAudio();
  await new Promise(setImmediate);
  app.audio.chimeForShard("books");
  assert.ok(app.oscillators.length > 0);
  let changes = 0;
  app.events.addEventListener("chime:muted-change", () => changes++);
  assert.doesNotThrow(() => app.audio.toggleMuted());
  assert.equal(app.audio.isMuted(), true);
  assert.ok(app.attributes.has("data-muted"));
  assert.equal(changes, 1);
  assert.ok(app.oscillators.every((osc) => osc.stops.length >= 2));
  assert.ok([...app.timers.values()].every((timer) => timer.delay < 2000));
  const count = app.oscillators.length;
  app.audio.chimeForShard("food");
  app.document.hidden = false;
  app.events.dispatchEvent(new Event("visibilitychange"));
  assert.equal(app.oscillators.length, count);
  app.audio.toggleMuted();
  await new Promise(setImmediate);
  assert.equal(app.audio.isMuted(), false);
  assert.ok(app.oscillators.length > count);
});

test("a pending start cannot restart audio after muting", async () => {
  const app = soundScene();
  app.audio.unlockAudio();
  app.audio.toggleMuted();
  await new Promise(setImmediate);
  assert.equal(app.audio.isMuted(), true);
  assert.equal(app.oscillators.length, 0);
});

test("sound button toggles while suspended and resyncs its icon after navigation", () => {
  const app = soundScene();
  function makeButton() {
    const button = new EventTarget();
    button.dataset = {};
    button.attributes = {};
    button.setAttribute = (name, value) => {
      button.attributes[name] = value;
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
      unlockAudio() {},
    }),
    document: app.document,
    window: { scrollY: 0, removeEventListener() {}, addEventListener() {} },
  });
  app.events.dispatchEvent(new Event("astro:page-load"));
  button.dispatchEvent(new Event("click"));
  assert.equal(app.audio.isMuted(), true);
  assert.equal(button.attributes["aria-pressed"], "false");
  assert.equal(button.title, "Turn sound on");
  app.attributes.clear(); // Astro replaces the document's HTML attributes.
  button = makeButton();
  app.events.dispatchEvent(new Event("astro:page-load"));
  assert.ok(app.attributes.has("data-muted"));
  assert.equal(button.attributes["aria-pressed"], "false");
});

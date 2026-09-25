// Shared scene for the sound tests: loads src/scripts/chime.ts (and what it
// imports: audio, music, glints, data/music) as CommonJS in one VM context
// with mocked Web Audio, media elements, storage, fetch and timers.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const cueSheet = JSON.parse(
  readFileSync(join(root, "public/audio/cavern.json"), "utf8"),
);

/** Fake clock: timers fire only when the test advances time. */
function makeClock() {
  const timers = new Map();
  let id = 0;
  let now = 0;
  const clock = {
    timers,
    get now() {
      return now;
    },
    setTimeout(fn, delay = 0) {
      timers.set(++id, { fn, at: now + Math.max(0, delay), delay });
      return id;
    },
    setInterval(fn, delay) {
      timers.set(++id, { fn, at: now + delay, delay, every: delay });
      return id;
    },
    clearTimeout(t) {
      timers.delete(t);
    },
    /** Run every timer due within `ms`, in order. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [k, t] of timers)
          if (t.at <= end && (!next || t.at < next[1].at)) next = [k, t];
        if (!next) break;
        const [k, t] = next;
        now = t.at;
        if (t.every) t.at += t.every;
        else timers.delete(k);
        t.fn();
      }
      now = end;
    },
  };
  clock.clearInterval = clock.clearTimeout;
  return clock;
}

export function soundScene({
  stored = {},
  session = {},
  state = "running",
  coarse = false,
  webm = true,
  random = Math.random,
  // The browser's autoplay policy before a gesture: "allowed", "media"
  // (context runs, play() refused) or "blocked" (context stays suspended).
  autoplay = "allowed",
} = {}) {
  let activation = false;
  const clock = makeClock();
  const storage = new Map(Object.entries(stored));
  const sessionStore = new Map(Object.entries(session));
  const store = (map) => ({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  });
  const events = new EventTarget();
  const windowEvents = new EventTarget();
  const attributes = new Set();
  const attributeValues = new Map();
  const oscillators = [];
  const convolvers = [];
  const elements = [];
  const fetches = [];
  const mediaSources = [];

  const contexts = [];
  // Deliberately omit cancelAndHoldAtTime, as in browsers without that API.
  const param = (value = 0) => ({
    value,
    calls: [],
    setValueAtTime(v, t) {
      this.calls.push(["set", v, t]);
      this.value = v;
    },
    linearRampToValueAtTime(v, t) {
      this.calls.push(["ramp", v, t]);
      this.value = v;
    },
    exponentialRampToValueAtTime(v, t) {
      this.calls.push(["exp", v, t]);
    },
    cancelScheduledValues(t) {
      this.calls.push(["cancel", t]);
    },
    setTargetAtTime(v, t, c) {
      this.calls.push(["target", v, t, c]);
    },
    setValueCurveAtTime(curve, t, d) {
      this.calls.push(["curve", Array.from(curve), t, d]);
      this.value = curve[curve.length - 1];
    },
  });
  const node = (kind) => ({
    kind,
    gain: param(1),
    frequency: param(),
    detune: param(),
    pan: param(),
    threshold: param(),
    knee: param(),
    ratio: param(),
    attack: param(),
    release: param(),
    Q: param(),
    delayTime: param(),
    outputs: new Set(),
    connect(target) {
      this.outputs.add(target);
      return target;
    },
    disconnect(target) {
      if (target) this.outputs.delete(target);
      else this.outputs.clear();
    },
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ??= []).push(fn);
    },
    start() {},
    stops: [],
    stop(t) {
      this.stops.push(t);
    },
  });
  class AudioContext {
    state = state;
    currentTime = 10;
    sampleRate = 100;
    destination = node("destination");
    constructor() {
      contexts.push(this);
    }
    resume() {
      // A blocked context's resume() stays pending until a gesture.
      if (autoplay === "blocked" && !activation) return new Promise(() => {});
      this.state = "running";
      return Promise.resolve();
    }
    async suspend() {
      this.state = "suspended";
    }
    createGain = () => node("gain");
    createStereoPanner = () => node("panner");
    createDynamicsCompressor = () => node("compressor");
    createConvolver = () => {
      const c = node("convolver");
      convolvers.push(c);
      return c;
    };
    createBiquadFilter = () => node("biquad");
    createBufferSource = () => node("buffer");
    createDelay = () => node("delay");
    createChannelMerger = () => node("merger");
    createMediaElementSource = (el) => {
      const n = node("media");
      n.element = el;
      mediaSources.push(n);
      return n;
    };
    createOscillator() {
      const osc = node("oscillator");
      oscillators.push(osc);
      return osc;
    }
    createBuffer(channels, length) {
      const data = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
      return { getChannelData: (ch) => data[ch] };
    }
  }
  class Audio extends EventTarget {
    src = "";
    preload = "auto";
    currentTime = 0;
    duration = NaN;
    paused = true;
    readyState = 0;
    playbackRate = 1;
    plays = 0;
    constructor() {
      super();
      elements.push(this);
    }
    canPlayType(type) {
      return webm && type.includes("webm") ? "probably" : "";
    }
    play() {
      this.plays++;
      if (autoplay !== "allowed" && !activation) {
        const err = new Error("play() needs a gesture");
        err.name = "NotAllowedError";
        return Promise.reject(err);
      }
      this.paused = false;
      return Promise.resolve();
    }
    pause() {
      this.paused = true;
    }
  }
  const document = {
    hidden: false,
    documentElement: {
      toggleAttribute(name, enabled) {
        if (enabled) attributes.add(name);
        else attributes.delete(name);
      },
      setAttribute(name, value) {
        attributes.add(name);
        attributeValues.set(name, value);
      },
      dataset: {},
    },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  };
  const window = {
    AudioContext,
    localStorage: store(storage),
    sessionStorage: store(sessionStore),
    matchMedia: (q) => ({ matches: coarse && q.includes("coarse") }),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    addEventListener: windowEvents.addEventListener.bind(windowEvents),
    dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
  };
  const fetch = async (url) => {
    fetches.push(url);
    return { ok: true, json: async () => structuredClone(cueSheet) };
  };

  const context = createContext({
    window,
    document,
    navigator: { hardwareConcurrency: 8 },
    Audio,
    fetch,
    Event,
    CustomEvent,
    EventTarget,
    Float32Array,
    Promise,
    JSON,
    Math: Object.assign(Object.create(Math), { random }),
    Date: { now: () => 1_000_000 + clock.now },
    performance: { now: () => clock.now },
    setTimeout: clock.setTimeout,
    console,
  });
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const source = readFileSync(file, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const module = { exports: {} };
    cache.set(file, module);
    const require = (spec) => load(resolve(dirname(file), spec) + ".ts");
    runInContext(
      `(function (exports, require, module) {${outputText}\n})`,
      context,
    )(module.exports, require, module);
    return module.exports;
  }
  const audio = load(join(root, "src/scripts/chime.ts"));

  /** Let resolved promises (play(), fetch) run. */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise(setImmediate);
  };

  return {
    audio,
    clock,
    events,
    windowEvents,
    attributes,
    attributeValues,
    oscillators,
    convolvers,
    elements,
    fetches,
    mediaSources,
    /** Each element's gain, in element order. */
    gains() {
      return mediaSources.map((s) => [...s.outputs][0]);
    },
    /** The shared music bus the element gains feed. */
    bus() {
      return [...[...mediaSources[0].outputs][0].outputs][0];
    },
    document,
    storage,
    sessionStore,
    settle,
    get ctx() {
      return contexts[0] ?? null;
    },
    gesture(type = "pointerdown", target = null) {
      activation = true;
      const event = new Event(type);
      Object.defineProperty(event, "target", { value: target });
      events.dispatchEvent(event);
    },
    load,
  };
}

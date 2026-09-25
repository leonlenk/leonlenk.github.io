// Struck-glass chimes, synthesised live with Web Audio, and the site's
// sound modes. The background music is pre-rendered and played by
// ./music; this module decides when it may play.
//
// Harmony: the six shard notes are D4 E4 G4 A4 B4 D5 (G major pentatonic,
// equal temperament), which sit consonantly over every chord of the
// "Cavern of Light" music (no voice there uses F#, and C only as a low
// bass or inner voice).
//
// Sound modes, persisted in localStorage (`shards:sound`):
//   "ambient" — the default: chimes plus the background music, which
//               starts on the first gesture.
//   "chimes"  — clicks strike the shard's note; no music.
//   "muted"   — silence; the context is suspended to save CPU.
//
// Browsers refuse to start audio before a user gesture. This module
// listens for the first pointerdown/keydown/click/touchend itself and
// unlocks audio there (starting the music synchronously, which iOS
// requires). `unlockAudio()` may also be called from any handler; before a
// gesture it does nothing. With Astro's ClientRouter the document persists
// across navigations, so one unlock lasts the whole visit.
//
// A returning visitor whose saved mode is "ambient" gets the music back on
// load without a gesture where the browser allows it (Chrome and Edge do
// for sites the visitor has engaged with). If the context will not run, or
// play() is refused, it quietly waits for the first gesture instead.

import { getAudio, peekAudio, type AudioGraph } from "./audio";
import { musicStarted, onMusicState, startMusic, stopMusic } from "./music";

export interface ChimeOptions {
  /** 0–1, scales upper partials and the strike transient. Default 1. */
  brightness?: number;
  /** 0–1, scales loudness and brightness. Default 0.6. */
  velocity?: number;
  /** Random pitch spread in cents, ± this value. Default 4. */
  spread?: number;
  /** Multiplier on the decay times. Default 1. */
  length?: number;
}

export type SoundMode = "chimes" | "ambient" | "muted";

/** Fired on `document` whenever the sound mode, or whether the music is
 * still waiting for a gesture, changes. */
export const MUTED_CHANGE_EVENT = "chime:muted-change";

/* ---------- pitch ---------- */

function midiHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function cents(c: number): number {
  return 2 ** (c / 1200);
}

// D4 E4 G4 A4 B4 D5: G major pentatonic.
const SHARD_NOTES = [62, 64, 67, 69, 71, 74];

export function noteForIndex(index: number): number {
  return midiHz(SHARD_NOTES[index] ?? 67);
}

// Fixed assignments break up the rising visual order and survive reloads.
// In spectrum order the field plays A4 D4 B4 G4 D5 E4; the two Ds sit on
// shards that are never neighbours.
const shardNoteIndices: Readonly<Record<string, number>> = {
  writing: 3, // A4
  research: 0, // D4
  self: 4, // B4
  ai: 2, // G4
  art: 5, // D5
  food: 1, // E4
};

export function noteForShard(id: string): number {
  return noteForIndex(shardNoteIndices[id] ?? 0);
}

/* ---------- sound mode ---------- */

const STORAGE_KEY = "shards:sound";
const LEGACY_MUTED_KEY = "shards:muted";
const MODES: readonly SoundMode[] = ["ambient", "chimes", "muted"];

function isSoundMode(value: unknown): value is SoundMode {
  return MODES.includes(value as SoundMode);
}

function storedValue(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function readStoredMode(): SoundMode {
  try {
    const stored = storedValue();
    if (isSoundMode(stored)) return stored;
    if (window.localStorage.getItem(LEGACY_MUTED_KEY) === "true")
      return "muted";
  } catch {
    // Storage blocked or unavailable: fall back to the default.
  }
  return "ambient";
}

function storeMode(next: SoundMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
    window.localStorage.removeItem(LEGACY_MUTED_KEY);
  } catch {
    // Not persisted; the choice still lasts for this visit.
  }
}

let mode: SoundMode = readStoredMode();
let lastAudible: Exclude<SoundMode, "muted"> =
  mode === "chimes" ? "chimes" : "ambient";

export function getSoundMode(): SoundMode {
  return mode;
}

export function isMuted(): boolean {
  return mode === "muted";
}

export function isAmbientOn(): boolean {
  return mode === "ambient";
}

/**
 * Music is on but has not started: before the first gesture, or after a
 * reload whose autoplay was refused. Not while an autoplay attempt is still
 * in flight, so a successful one never flashes the hint.
 */
export function isSoundPending(): boolean {
  return mode === "ambient" && !musicStarted() && !autoplayInFlight;
}

/**
 * Mirror the mode onto <html>: `data-sound`, `data-muted` when off, and
 * `data-sound-pending` while the music waits for a gesture.
 */
export function reflectSoundMode(): void {
  const root = document.documentElement;
  root.toggleAttribute("data-muted", mode === "muted");
  root.toggleAttribute("data-sound-pending", isSoundPending());
  root.setAttribute("data-sound", mode);
}

/** Reflect, and tell listeners (the sound button) the state changed. */
function announce(): void {
  reflectSoundMode();
  document.dispatchEvent(
    new CustomEvent(MUTED_CHANGE_EVENT, {
      detail: { muted: mode === "muted", mode },
    }),
  );
}

export function setSoundMode(next: SoundMode): void {
  mode = next;
  if (next !== "muted") lastAudible = next;
  storeMode(next);
  if (next !== "ambient") stopMusic();
  if (next === "muted") {
    for (const voice of [...active]) voice.stop();
    scheduleSuspend();
  } else {
    enableSound();
  }
  announce();
}

/** ambient → chimes only → muted → ambient. Returns the new mode. */
export function cycleSoundMode(): SoundMode {
  setSoundMode(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
  return mode;
}

export function setMuted(next: boolean): void {
  setSoundMode(next ? "muted" : lastAudible);
}

export function toggleMuted(): boolean {
  setMuted(mode !== "muted");
  return mode === "muted";
}

/* ---------- unlock ---------- */

let gestured = false;
/** A returning visitor's on-load start is being tried. */
let autoplayInFlight = false;

/** Has the visitor interacted with the page (so audio may start)? */
function activated(): boolean {
  if (gestured || musicStarted()) return true;
  const ua = (
    navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }
  ).userActivation;
  return !!ua?.hasBeenActive;
}

/**
 * Resume the context and, with ambient on, start the music. Safe to call
 * on every gesture and every page load; does nothing before the first
 * gesture and nothing noticeable once running. Returns true when Web Audio
 * exists.
 */
export function unlockAudio(): boolean {
  if (!activated()) return "AudioContext" in window;
  if (!getAudio()) return false;
  if (mode !== "muted") enableSound();
  return true;
}

export function audioAvailable(): boolean {
  return peekAudio()?.ctx.state === "running";
}

/** Synchronous, so a gesture's play() call reaches the media element. */
function enableSound(): void {
  window.clearTimeout(suspendTimer);
  if (!activated()) return;
  const g = getAudio();
  if (!g) return;
  if (g.ctx.state !== "running") g.ctx.resume().catch(() => {});
  if (mode === "ambient" && !document.hidden) {
    // Remember the choice, so the next visit may start without a gesture.
    if (!storedValue()) storeMode(mode);
    startMusic();
  }
}

// How long a returning visitor's context gets to start without a gesture.
const AUTOPLAY_WAIT_MS = 800;

/**
 * On load, for a saved "ambient" mode: start the music if the browser lets
 * the context run without a gesture. Only once the context is running is
 * play() called, so an element never runs silently ahead of the graph.
 */
function tryAutoplay(): void {
  if (mode !== "ambient" || storedValue() !== "ambient" || document.hidden)
    return;
  const g = getAudio();
  if (!g) return;
  autoplayInFlight = true;
  const running =
    g.ctx.state === "running" ? Promise.resolve() : g.ctx.resume();
  void Promise.race([
    running.catch(() => {}),
    new Promise((ok) => window.setTimeout(ok, AUTOPLAY_WAIT_MS)),
  ]).then(() => {
    // A gesture got there first, or the context is still blocked: the
    // gesture path handles it.
    if (
      gestured ||
      g.ctx.state !== "running" ||
      mode !== "ambient" ||
      document.hidden
    ) {
      autoplayInFlight = false;
      announce();
      return;
    }
    // Settled by onMusicState: started, or refused.
    startMusic();
  });
}

// Suspending an idle context stops the audio thread entirely, which matters
// on laptops: muted pages and hidden tabs then cost nothing. The music has
// faded out and paused (./music) by the time this runs.
let suspendTimer: number | undefined;
const SUSPEND_AFTER_MS = 1200;

function scheduleSuspend(): void {
  window.clearTimeout(suspendTimer);
  suspendTimer = window.setTimeout(() => {
    suspendTimer = undefined;
    const ctx = peekAudio()?.ctx;
    if (!ctx || ctx.state !== "running") return;
    if (mode === "muted" || document.hidden) ctx.suspend().catch(() => {});
  }, SUSPEND_AFTER_MS);
}

/* ---------- struck glass ---------- */

// [ratio, amplitude, decay s, attack s, detune cents]. The rim modes of a
// struck glass: a fundamental split into two modes 3.2 cents apart (a slow
// shimmer) plus three faint inharmonic upper modes that die away quickly.
const GLASS: ReadonlyArray<readonly [number, number, number, number, number]> =
  [
    [1, 0.62, 3.2, 0.006, -1.6],
    [1, 0.42, 3.0, 0.006, 1.6],
    [2.32, 0.11, 1.3, 0.004, 0],
    [4.25, 0.04, 0.6, 0.003, 0],
    [6.63, 0.014, 0.28, 0.002, 0],
  ];
const TINK_LEVEL = 0.03;

interface Struck {
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  /** Seconds until the longest partial has died away. */
  ring: number;
}

// The chimes' small, bright room, built on the first chime.
let wet: GainNode | null = null;
let strikeBuffer: AudioBuffer | null = null;

function chimeRoom(g: AudioGraph): GainNode {
  if (wet) return wet;
  const convolver = g.ctx.createConvolver();
  convolver.buffer = makeImpulse(g.ctx, 1.9, 2.6);
  wet = g.ctx.createGain();
  wet.gain.value = 0.32;
  wet.connect(convolver);
  convolver.connect(g.compressor);
  return wet;
}

/** Exponentially decaying stereo noise: a small, bright, glassy room. */
function makeImpulse(
  ctx: AudioContext,
  seconds: number,
  decay: number,
): AudioBuffer {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      data[i] = (Math.random() * 2 - 1) * (1 - t) ** decay;
    }
  }
  return buffer;
}

/** 50 ms of noise with a fast decay: the "tink" at the start of a chime. */
function strikeNoise(ctx: AudioContext): AudioBuffer {
  if (strikeBuffer) return strikeBuffer;
  const length = Math.floor(ctx.sampleRate * 0.05);
  strikeBuffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = strikeBuffer.getChannelData(0);
  for (let i = 0; i < length; i++)
    data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  return strikeBuffer;
}

/** Schedule one struck-glass note into `out` at context time `t0`. */
function glassStrike(
  ctx: AudioContext,
  out: AudioNode,
  hz: number,
  t0: number,
  opts: ChimeOptions,
): Struck {
  const velocity = Math.max(0.05, Math.min(1, opts.velocity ?? 0.6));
  const spread = opts.spread ?? 4;
  const brightness = Math.max(0, Math.min(1, opts.brightness ?? 1));
  const length = opts.length ?? 1;
  const jitter = (Math.random() * 2 - 1) * spread;
  const sources: AudioScheduledSourceNode[] = [];
  const nodes: AudioNode[] = [];
  let ring = 0;

  GLASS.forEach(([ratio, amp, decay, attack, detune], i) => {
    const osc = ctx.createOscillator();
    const drift = (Math.random() * 2 - 1) * (1 + i) * 0.5;
    osc.frequency.value = hz * ratio * cents(jitter + detune + drift);
    // harder strikes ring longer and carry more of the upper modes
    const level = amp * (i === 0 ? 1 : (0.55 + velocity * 0.6) * brightness);
    const d = decay * length * (0.85 + velocity * 0.3);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), t0 + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    osc.connect(env);
    env.connect(out);
    osc.start(t0);
    osc.stop(t0 + d + 0.05);
    sources.push(osc);
    nodes.push(env);
    ring = Math.max(ring, d);
  });

  // transient: a few milliseconds of band-limited noise, the "tink"
  const noise = ctx.createBufferSource();
  noise.buffer = strikeNoise(ctx);
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = Math.min(12000, hz * 6.6);
  band.Q.value = 5;
  const tink = ctx.createGain();
  tink.gain.setValueAtTime(
    Math.max(0.0001, TINK_LEVEL * velocity * brightness),
    t0,
  );
  tink.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
  noise.connect(band);
  band.connect(tink);
  tink.connect(out);
  noise.start(t0);
  noise.stop(t0 + 0.07);
  sources.push(noise);
  nodes.push(band, tink);

  return { sources, nodes, ring };
}

/* ---------- chime voices ---------- */

const MAX_VOICES = 8;
const RETRIGGER_MS = 80;
// A chime requested before the context runs is kept only this long.
const PENDING_CHIME_MS = 300;

const active: { stop: () => void; until: number }[] = [];
const lastByKey = new Map<string, number>();

/** Play a single chime at `hz`. */
export function chimeNote(
  hz: number,
  opts: ChimeOptions = {},
  key = String(hz),
): void {
  if (mode === "muted") return;
  const g = getAudio();
  if (!g) return;

  const now = performance.now();
  const last = lastByKey.get(key) ?? -Infinity;
  if (now - last < RETRIGGER_MS) return;
  lastByKey.set(key, now);

  if (g.ctx.state === "running") {
    strike(g, hz, opts);
    return;
  }
  // The first gesture's resume() settles a few milliseconds later. Play
  // then, but drop notes whose context only starts much later.
  g.ctx.resume().then(
    () => {
      if (mode !== "muted" && performance.now() - now < PENDING_CHIME_MS)
        strike(g, hz, opts);
    },
    () => {},
  );
}

function strike(g: AudioGraph, hz: number, opts: ChimeOptions): void {
  const velocity = Math.max(0.05, Math.min(1, opts.velocity ?? 0.6));
  const { ctx, master } = g;
  const t0 = ctx.currentTime + 0.005;

  // steal the oldest voice past the polyphony cap
  while (active.length >= MAX_VOICES) {
    const oldest = active.shift();
    oldest?.stop();
  }

  const voice = ctx.createGain();
  voice.gain.value = velocity * 0.38;
  voice.connect(master);
  voice.connect(chimeRoom(g));
  const { sources, ring } = glassStrike(ctx, voice, hz, t0, opts);

  const entry = {
    until: performance.now() + (ring + 0.1) * 1000,
    stop: () => {
      const t = ctx.currentTime;
      voice.gain.cancelScheduledValues(t);
      voice.gain.setTargetAtTime(0.0001, t, 0.03);
      sources.forEach((n) => {
        try {
          n.stop(t + 0.15);
        } catch {
          /* already stopped */
        }
      });
      const i = active.indexOf(entry);
      if (i >= 0) active.splice(i, 1);
      setTimeout(() => voice.disconnect(), 250);
    },
  };
  active.push(entry);
  sources[0].onended = () => {
    const i = active.indexOf(entry);
    if (i >= 0) active.splice(i, 1);
    voice.disconnect();
  };
}

/** Play the shard's own note. */
export function chimeForShard(id: string, opts: ChimeOptions = {}): void {
  chimeNote(noteForShard(id), opts, id);
}

/* ---------- page wiring ---------- */

// Events that count as user activation somewhere: Chrome takes pointerdown
// only from a mouse (touch activates on pointerup/touchend), and iOS allows
// media to start on touchstart/touchend and click. Whichever lands first
// unlocks; they are removed once the audio is running.
const GESTURES = [
  "pointerdown",
  "pointerup",
  "touchstart",
  "touchend",
  "keydown",
  "click",
];
const LISTEN = { capture: true, passive: true } as const;

function onGesture(event: Event): void {
  if (event.type === "keydown" && (event as KeyboardEvent).key === "Escape")
    return;
  gestured = true;
  // Done: the context runs and the music (if wanted) has started. Later
  // mode changes come from the sound button, itself a gesture.
  if (audioAvailable() && (mode !== "ambient" || musicStarted())) {
    for (const type of GESTURES)
      document.removeEventListener(type, onGesture, LISTEN);
    return;
  }
  // The sound button handles its own click, so it cannot start then stop.
  const target = event.target as Element | null;
  if (target?.closest?.("button.mute")) return;
  if (mode !== "muted") unlockAudio();
}

if (typeof document !== "undefined") {
  onMusicState(() => {
    autoplayInFlight = false;
    announce();
  });
  for (const type of GESTURES)
    document.addEventListener(type, onGesture, LISTEN);
  tryAutoplay();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopMusic();
      scheduleSuspend();
    } else if (mode !== "muted" && peekAudio()) {
      enableSound();
    }
  });
  // Reflect the restored sound mode as soon as the module loads.
  reflectSoundMode();
}

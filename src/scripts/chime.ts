// Crystal chimes, synthesised with Web Audio. No samples, no dependencies.
//
// Each shard owns one note of a pentatonic scale; playing it produces a
// bell-like, glassy tone in the spirit of a struck amethyst cluster: a short
// bright transient, a handful of inharmonic partials that decay at different
// rates (the "shimmer"), a touch of random detune so no two strikes are
// identical, and a small synthetic reverb tail.
//
// Browsers refuse to start audio before a user gesture. Call `unlockAudio()`
// from any pointerdown/keydown handler; until then `chime*` calls are
// silently dropped. With Astro's ClientRouter the document persists across
// navigations, so one unlock lasts the whole visit.

import { shards } from "../data/shards";
import { hexToRgb, rgbToHsl } from "../lib/color";

export interface ChimeOptions {
  /** 0–1, scales loudness and brightness. Default 0.6. */
  velocity?: number;
  /** Random pitch spread in cents, ± this value. Default 12. */
  spread?: number;
  /** Multiplier on the decay times. Default 1. */
  length?: number;
}

const STORAGE_KEY = "shards:muted";
export const MUTED_CHANGE_EVENT = "chime:muted-change";

/* ---------- pitch ---------- */

// The shards spell one rising arpeggio (C major ninth, then on up through the
// chord tones) in SPECTRUM order — teal lowest, ember highest — so sweeping
// the pointer left to right across the field plays the chord, and the intro
// cluster (played in the same order) is a rising arpeggio.
const BASE_HZ = 523.25; // C5
const ARPEGGIO = [1, 5 / 4, 3 / 2, 15 / 8, 9 / 4, 5 / 2, 3, 15 / 4, 9 / 2, 5];

export function noteForIndex(index: number): number {
  const octave = Math.floor(index / ARPEGGIO.length);
  return BASE_HZ * ARPEGGIO[index % ARPEGGIO.length] * 2 ** octave;
}

/** Same rule the field uses to place shards left → right. */
function spectrumHue(hex: string): number {
  const [h] = rgbToHsl(hexToRgb(hex));
  return h < 150 ? h + 360 : h;
}

const spectrumOrder: readonly string[] = [...shards]
  .sort((a, b) => spectrumHue(a.edge[0]) - spectrumHue(b.edge[0]))
  .map((s) => s.id);

export function noteForShard(id: string): number {
  const index = spectrumOrder.indexOf(id);
  return noteForIndex(index < 0 ? 0 : index);
}

/* ---------- mute preference ---------- */

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

let muted = readMuted();

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  try {
    localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    /* private mode; the in-memory flag still applies */
  }
  document.documentElement.toggleAttribute("data-muted", next);
  document.dispatchEvent(
    new CustomEvent(MUTED_CHANGE_EVENT, { detail: { muted: next } }),
  );
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}

/* ---------- audio graph ---------- */

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  wet: GainNode;
}

let graph: Graph | null = null;

/** Build the shared output chain once: voices → (dry + reverb) → compressor. */
function ensureGraph(): Graph | null {
  if (graph) return graph;
  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;

  const ctx = new Ctor({ latencyHint: "interactive" });
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 12;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;
  compressor.connect(ctx.destination);

  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(compressor);

  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx, 1.9, 2.6);
  const wet = ctx.createGain();
  wet.gain.value = 0.32;
  wet.connect(convolver);
  convolver.connect(compressor);

  graph = { ctx, master, wet };
  return graph;
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

/**
 * Resume the context. Safe to call on every gesture; cheap once unlocked.
 * Returns true when audio is (or has just become) available.
 */
export function unlockAudio(): boolean {
  const g = ensureGraph();
  if (!g) return false;
  if (g.ctx.state === "suspended") void g.ctx.resume();
  return true;
}

export function audioAvailable(): boolean {
  return !!graph && graph.ctx.state === "running";
}

/* ---------- voices ---------- */

// Inharmonic partials of a struck glass: ratio, relative amplitude, decay (s).
const PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [1.0, 1.0, 1.7],
  [2.0, 0.42, 1.15],
  [2.98, 0.3, 0.85],
  [4.17, 0.18, 0.55],
  [5.61, 0.11, 0.38],
  [7.3, 0.06, 0.25],
];

const MAX_VOICES = 8;
const RETRIGGER_MS = 80;

const active: { stop: () => void; until: number }[] = [];
const lastByKey = new Map<string, number>();

function cents(c: number): number {
  return 2 ** (c / 1200);
}

/** Play a single chime at `hz`. */
export function chimeNote(
  hz: number,
  opts: ChimeOptions = {},
  key = String(hz),
): void {
  if (muted) return;
  const g = ensureGraph();
  if (!g || g.ctx.state !== "running") return;

  const now = performance.now();
  const last = lastByKey.get(key) ?? -Infinity;
  if (now - last < RETRIGGER_MS) return;
  lastByKey.set(key, now);

  const velocity = Math.max(0.05, Math.min(1, opts.velocity ?? 0.6));
  const spread = opts.spread ?? 12;
  const length = opts.length ?? 1;
  const { ctx, master, wet } = g;
  const t0 = ctx.currentTime + 0.005;

  // steal the oldest voice past the polyphony cap
  while (active.length >= MAX_VOICES) {
    const oldest = active.shift();
    oldest?.stop();
  }

  const voice = ctx.createGain();
  voice.gain.value = velocity * 0.8;
  voice.connect(master);
  voice.connect(wet);

  const strikeDetune = (Math.random() * 2 - 1) * spread;
  const nodes: AudioScheduledSourceNode[] = [];
  let longest = 0;

  // partials: each a sine with its own exponential decay and tiny detune
  PARTIALS.forEach(([ratio, amp, decay], i) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const partialDetune = strikeDetune + (Math.random() * 2 - 1) * (3 + i * 2);
    osc.frequency.value = hz * ratio * cents(partialDetune);

    // brighter strikes carry more of the upper partials
    const level = amp * (i === 0 ? 1 : 0.55 + velocity * 0.6);
    const d = decay * length * (0.85 + velocity * 0.3);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(level, t0 + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + d);

    osc.connect(env);
    env.connect(voice);
    osc.start(t0);
    osc.stop(t0 + d + 0.05);
    nodes.push(osc);
    longest = Math.max(longest, d);
  });

  // transient: a few milliseconds of band-limited noise, the "tink"
  const noiseLen = Math.floor(ctx.sampleRate * 0.05);
  const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < noiseLen; i++)
    data[i] = (Math.random() * 2 - 1) * (1 - i / noiseLen) ** 3;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = Math.min(12000, hz * 4.2);
  band.Q.value = 5;
  const tink = ctx.createGain();
  tink.gain.setValueAtTime(0.22 * velocity, t0);
  tink.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
  noise.connect(band);
  band.connect(tink);
  tink.connect(voice);
  noise.start(t0);
  noise.stop(t0 + 0.07);
  nodes.push(noise);

  const entry = {
    until: now + (longest + 0.1) * 1000,
    stop: () => {
      const t = ctx.currentTime;
      voice.gain.cancelScheduledValues(t);
      voice.gain.setTargetAtTime(0.0001, t, 0.03);
      nodes.forEach((n) => {
        try {
          n.stop(t + 0.15);
        } catch {
          /* already stopped */
        }
      });
      setTimeout(() => voice.disconnect(), 250);
    },
  };
  active.push(entry);
  const marker = nodes[0];
  marker.onended = () => {
    const i = active.indexOf(entry);
    if (i >= 0) active.splice(i, 1);
    voice.disconnect();
  };
}

/** Play the shard's own note. */
export function chimeForShard(id: string, opts: ChimeOptions = {}): void {
  chimeNote(noteForShard(id), opts, id);
}

/**
 * A soft cluster of several shards' notes in quick succession, for the
 * moment the field crystallises. Only audible if audio is already unlocked
 * (a first-visit intro is silent by browser policy).
 */
export function chimeCluster(ids: string[], opts: ChimeOptions = {}): void {
  if (muted) return;
  ids.forEach((id, i) => {
    setTimeout(() => chimeForShard(id, { velocity: 0.35, ...opts }), i * 70);
  });
}

// Reflect the stored preference on the document as soon as the module loads.
if (typeof document !== "undefined") {
  document.documentElement.toggleAttribute("data-muted", muted);
}

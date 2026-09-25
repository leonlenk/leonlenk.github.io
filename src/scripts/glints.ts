// Live glints over the pre-rendered bed: distant gems catching the light,
// and Hover's drifting dust. Ported from the "Cavern of Light" prototype
// with its own logic, voice, levels and sends; only the randomness is live
// (Math.random), so no two visits glint alike.
//
// Where we are in the piece comes from the music player (which file, and
// its currentTime) and the cue sheet (movement spans). Timers run only
// while music plays: one for the next glint, one for the next dust burst,
// one for the next movement boundary, and one that puts the cave to sleep.
//
// CPU: the cave reverb (a ConvolverNode) is the expensive node, so it and
// the stereo echo exist only while a glint is ringing, and are rebuilt for
// the next one. The cave impulse is 5 s instead of the prototype's 8.9 s:
// the same decay rate, darkening and early reflections, faded out over its
// last 1.5 s, at the level the full-length impulse would have had. On
// phones and small machines the cave is one mono convolution (half the
// cost) and the glass keeps three partials.

import type { Cue, CueMovement } from "../data/music";
import { getAudio, peekAudio, rampTo, setNow } from "./audio";

export interface Position {
  part: "intro" | "loop";
  /** Seconds into that file. */
  time: number;
}

/* ---------- pitch ---------- */

const NOTE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function hz(note: string): number {
  const midi = 12 * (Number(note.slice(1)) + 1) + NOTE[note[0]];
  return 440 * 2 ** ((midi - 69) / 12);
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(list: readonly T[]): T =>
  list[Math.floor(Math.random() * list.length)];

/* ---------- voice ---------- */

type Partial = readonly [number, number, number, number, number];

// [ratio, amplitude, decay s, attack s, detune cents], as in the prototype.
const GLASS: readonly Partial[] = [
  [1, 0.62, 3.2, 0.006, -1.6],
  [1, 0.42, 3.0, 0.006, 1.6],
  [2.32, 0.11, 1.3, 0.004, 0],
  [4.25, 0.04, 0.6, 0.003, 0],
  [6.63, 0.014, 0.28, 0.002, 0],
];
const TICK: readonly Partial[] = [
  [1, 1, 0.9, 0.002, 0],
  [2.32, 0.25, 0.35, 0.002, 0],
];

// Phones and small machines drop the two faintest glass partials.
function lowPower(): boolean {
  try {
    return (
      window.matchMedia("(pointer: coarse)").matches ||
      (navigator.hardwareConcurrency ?? 8) <= 4
    );
  } catch {
    return false;
  }
}

/* ---------- the cave and the echo ---------- */

const IMPULSE_SECONDS = 5;
const IMPULSE_FADE = 1.5;
// After the last strike's partials die: the echo falls 40 dB in about
// 11 s (0.42 feedback per 2.12 s round trip), then the cave rings out.
const TAIL = 11 + IMPULSE_SECONDS + 1;

interface Chain {
  /** Inputs fed from the glint bus. */
  inputs: AudioNode[];
  /** Every node, for a clean disconnect. */
  nodes: AudioNode[];
}

interface Fx {
  ctx: AudioContext;
  /** Everything the layer makes, faded with the music. */
  out: GainNode;
  bus: GainNode;
  space: number;
  mono: boolean;
  glass: readonly Partial[];
  impulse: AudioBuffer | null;
  /** The echo and the cave, present only while a glint rings. */
  chain: Chain | null;
  until: number;
}

let fx: Fx | null = null;
let sleepTimer: number | undefined;
/** Glint voices that have not ended yet. */
const live = new Set<AudioScheduledSourceNode>();
/**
 * The prototype's cave impulse, 5 s long. The full 8.9 s response is
 * generated so its darkening and normalisation match; the kept head is
 * scaled exactly as ConvolverNode normalisation would scale the full one.
 */
function caveImpulse(
  ctx: AudioContext,
  space: number,
  channelCount: number,
): AudioBuffer {
  const full = 4 + space * 7;
  const rate = ctx.sampleRate;
  const fullLen = Math.floor(rate * full);
  const keep = Math.min(fullLen, Math.floor(rate * IMPULSE_SECONDS));
  const fadeFrom = keep - Math.floor(rate * IMPULSE_FADE);
  const buf = ctx.createBuffer(channelCount, keep, rate);
  let power = 0;
  const channels: Float32Array[] = [];
  for (let ch = 0; ch < channelCount; ch++) {
    const d = new Float32Array(fullLen);
    let y = 0;
    for (let i = 0; i < fullLen; i++) {
      const t = i / rate;
      const u = i / fullLen;
      const env = Math.exp((-6.9 * t) / full) * Math.min(1, t / 0.08);
      const a = 0.55 * (1 - u) ** 2 + 0.03;
      y += a * (Math.random() * 2 - 1 - y);
      d[i] = y * env * 1.6;
    }
    for (let k = 0; k < 9; k++) {
      const i = Math.floor(rate * rand(0.012, 0.12));
      d[i] += (Math.random() < 0.5 ? -1 : 1) * rand(0.25, 0.6) * (1 - k / 12);
    }
    for (let i = 0; i < fullLen; i++) power += d[i] * d[i];
    channels.push(d);
  }
  // ConvolverNode's normalisation (Blink/WebKit/Gecko): 1/RMS, calibrated
  // to −58 dB at 44.1 kHz.
  const rms = Math.max(0.000125, Math.sqrt(power / (channelCount * fullLen)));
  const scale = (1 / rms) * 10 ** (-58 / 20) * (44100 / rate);
  channels.forEach((d, ch) => {
    const out = buf.getChannelData(ch);
    for (let i = 0; i < keep; i++) {
      const fade =
        i < fadeFrom
          ? 1
          : 0.5 +
            0.5 * Math.cos((Math.PI * (i - fadeFrom)) / (keep - fadeFrom));
      out[i] = d[i] * scale * fade;
    }
  });
  return buf;
}

function ensureFx(space: number): Fx | null {
  if (fx) return fx;
  const g = getAudio();
  if (!g) return null;
  const { ctx, master } = g;
  const out = ctx.createGain();
  out.connect(master);
  const bus = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 0.25;
  bus.connect(dry);
  dry.connect(out);
  const small = lowPower();
  fx = {
    ctx,
    out,
    bus,
    space,
    // Phones: one mono convolution instead of two, and fewer partials.
    mono: small,
    glass: small ? GLASS.slice(0, 3) : GLASS,
    impulse: null,
    chain: null,
    until: 0,
  };
  return fx;
}

/**
 * The prototype's cave and stereo echo, built fresh for each ringing
 * spell so no old tail, frozen while disconnected, can come back later.
 */
function buildChain(f: Fx): Chain {
  const { ctx, space } = f;
  f.impulse ??= caveImpulse(ctx, space, f.mono ? 1 : 2);
  const cavernIn = ctx.createGain();
  cavernIn.gain.value = 0.25 + space * 0.75;
  if (f.mono) {
    cavernIn.channelCount = 1;
    cavernIn.channelCountMode = "explicit";
  }
  const cavern = ctx.createConvolver();
  cavern.normalize = false;
  cavern.buffer = f.impulse;
  const cavernOut = ctx.createGain();
  cavernOut.gain.value = 0.9;
  cavernIn.connect(cavern);
  cavern.connect(cavernOut);
  cavernOut.connect(f.out);

  // Stereo echo: long, dark, and fed into the cave.
  const echoIn = ctx.createGain();
  const dl = ctx.createDelay(3);
  const dr = ctx.createDelay(3);
  dl.delayTime.value = 0.83;
  dr.delayTime.value = 1.29;
  const fb = ctx.createGain();
  fb.gain.value = 0.42;
  const tone = ctx.createBiquadFilter();
  tone.type = "lowpass";
  tone.frequency.value = 2400;
  const merger = ctx.createChannelMerger(2);
  echoIn.connect(dl);
  dl.connect(dr);
  dr.connect(tone);
  tone.connect(fb);
  fb.connect(dl);
  dl.connect(merger, 0, 0);
  dr.connect(merger, 0, 1);
  const echoOut = ctx.createGain();
  echoOut.gain.value = 0.5;
  merger.connect(echoOut);
  echoOut.connect(f.out);
  echoOut.connect(cavernIn);

  f.bus.connect(cavernIn);
  f.bus.connect(echoIn);
  return {
    inputs: [cavernIn, echoIn],
    nodes: [
      cavernIn,
      cavern,
      cavernOut,
      echoIn,
      dl,
      dr,
      fb,
      tone,
      merger,
      echoOut,
    ],
  };
}

/** Connect the echo and the cave until `until` (context time). */
function wake(f: Fx, until: number): void {
  f.until = Math.max(f.until, until);
  f.chain ??= buildChain(f);
  if (sleepTimer === undefined) armSleep(f);
}

function armSleep(f: Fx): void {
  sleepTimer = window.setTimeout(
    () => {
      sleepTimer = undefined;
      if (f.ctx.currentTime < f.until - 0.05) armSleep(f);
      else sleep(f);
    },
    Math.max(0, f.until - f.ctx.currentTime) * 1000,
  );
}

/** Drop the echo and the cave so Chromium stops processing them. */
function sleep(f: Fx): void {
  window.clearTimeout(sleepTimer);
  sleepTimer = undefined;
  const chain = f.chain;
  if (!chain) return;
  f.chain = null;
  f.until = 0;
  for (const input of chain.inputs) f.bus.disconnect(input);
  for (const node of chain.nodes) node.disconnect();
}

/** Register a voice's sources; `done` runs when the last one ends. */
function track(sources: AudioScheduledSourceNode[], done: () => void): void {
  let left = sources.length;
  for (const src of sources) {
    live.add(src);
    src.addEventListener("ended", () => {
      live.delete(src);
      if (--left === 0) done();
    });
  }
}

function strike(
  f: Fx,
  freq: number,
  velocity: number,
  pan = 0,
  length = 1,
  delay = 0,
  partials: readonly Partial[] = f.glass,
): void {
  const { ctx } = f;
  const t0 = ctx.currentTime + 0.01 + delay;
  const out = ctx.createGain();
  out.gain.value = velocity * 0.38;
  const p = ctx.createStereoPanner();
  p.pan.value = Math.max(-1, Math.min(1, pan));
  out.connect(p);
  p.connect(f.bus);
  let longest = 0;
  const sources: OscillatorNode[] = [];
  const jitter = rand(-4, 4);
  partials.forEach(([ratio, amp, decay, attack, detune], i) => {
    const o = ctx.createOscillator();
    o.frequency.value = freq * ratio * 2 ** ((jitter + detune) / 1200);
    const d = decay * length * (0.85 + velocity * 0.3);
    const lvl = amp * (i === 0 ? 1 : 0.55 + velocity * 0.6);
    const e = ctx.createGain();
    e.gain.setValueAtTime(0.0001, t0);
    e.gain.exponentialRampToValueAtTime(Math.max(0.0001, lvl), t0 + attack);
    e.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    o.connect(e);
    e.connect(out);
    o.start(t0);
    o.stop(t0 + d + 0.05);
    sources.push(o);
    longest = Math.max(longest, d);
  });
  track(sources, () => p.disconnect());
  wake(f, t0 + longest + TAIL);
}

/** A gem left ringing: two sines a hair apart, swelling and fading. */
function resonate(f: Fx, freq: number, pan: number): void {
  const { ctx } = f;
  const t = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.01, t + 2.5);
  // released after 4 s over 7 s, as the prototype's timer did
  g.gain.setValueAtTime(0.01, t + 4);
  g.gain.linearRampToValueAtTime(0.0001, t + 11);
  const p = ctx.createStereoPanner();
  p.pan.value = pan;
  g.connect(p);
  p.connect(f.bus);
  const oscs = [0, 2.5].map((cents) => {
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.value = freq;
    o.detune.value = cents;
    o.connect(g);
    o.start(t);
    o.stop(t + 11.2);
    return o;
  });
  track(oscs, () => p.disconnect());
  wake(f, t + 11.2 + TAIL);
}

/* ---------- where we are ---------- */

interface Here {
  movement: CueMovement;
  /** Unique per movement occurrence within a file. */
  key: string;
  since: number;
  remaining: number;
}

let cue: Cue | null = null;
let position: () => Position | null = () => null;

function locate(): Here | null {
  const p = position();
  if (!cue || !p) return null;
  let t = p.time;
  let part = cue.loop;
  let name = "loop";
  if (p.part === "intro") {
    if (t < cue.intro.duration) {
      part = cue.intro;
      name = "intro";
    } else t -= cue.intro.duration;
  }
  if (part === cue.loop) {
    const L = cue.loop.duration;
    t = ((t % L) + L) % L;
  }
  let i = part.movements.length - 1;
  while (i > 0 && part.movements[i].start > t) i--;
  const movement = part.movements[i];
  return {
    movement,
    key: `${name}:${i}`,
    since: t - movement.start,
    remaining: movement.start + movement.length - t,
  };
}

/* ---------- scheduling ---------- */

let glintTimer: number | undefined;
let dustTimer: number | undefined;
let sectionTimer: number | undefined;

function clearTimers(): void {
  window.clearTimeout(glintTimer);
  window.clearTimeout(dustTimer);
  window.clearTimeout(sectionTimer);
  glintTimer = dustTimer = sectionTimer = undefined;
}

function light(): number {
  return cue?.settings.light ?? 0.37;
}

function gap(m: CueMovement): number {
  const quiet = m.fadeOut ? 1.6 : 1;
  const mean = (26 - 20 * light() - 5 * m.I) * quiet;
  return Math.max(1.5, -Math.log(1 - Math.random()) * mean);
}

function later(fn: () => void, secs: number): number {
  return window.setTimeout(fn, Math.max(0, secs) * 1000);
}

function glint(): void {
  glintTimer = undefined;
  const here = locate();
  const f = cue && ensureFx(cue.settings.space ?? 0.7);
  if (!here || !f) return;
  const m = here.movement;
  let pool = m.glints;
  if (m.slide) {
    // Descent: the lit gems drift lower as the movement goes on.
    const p = Math.min(1, here.since / m.length);
    const start = Math.round(p * (pool.length - 3));
    pool = pool.slice(start, start + 3);
  }
  const note = pick(pool);
  const pan = rand(-0.9, 0.9);
  strike(f, hz(note), rand(0.2, 0.45), pan);
  if (Math.random() < 0.3)
    strike(
      f,
      hz(pick(pool)),
      rand(0.12, 0.25),
      pan + rand(-0.3, 0.3),
      1,
      rand(0.18, 0.65),
    );
  if (Math.random() < 0.22) resonate(f, hz(note), pan);
  glintTimer = later(glint, gap(m));
}

function dust(): void {
  dustTimer = undefined;
  const here = locate();
  const f = cue && ensureFx(cue.settings.space ?? 0.7);
  if (!here || !f || !here.movement.dust) return;
  // An octave above the movement's glints.
  const pool = here.movement.glints.map((n) => n[0] + (Number(n.slice(1)) + 1));
  const count = Math.floor(rand(5, 12));
  const pan = rand(-0.8, 0.8);
  const span = rand(1.2, 2.8);
  for (let k = 0; k < count; k++)
    strike(
      f,
      hz(pick(pool)),
      rand(0.05, 0.12),
      pan + rand(-0.35, 0.35),
      1,
      (k / count) * span + rand(0, 0.08),
      TICK,
    );
  dustTimer = later(dust, rand(6, 13));
}

/**
 * Schedule a movement's glints as the prototype's enter() did: the first
 * 4–9 s in, dust (if any) 6–10 s after its voices enter. Picking up
 * mid-movement, the remaining part of those delays is kept; later on, the
 * gaps are the ordinary ones.
 */
function enter(): void {
  clearTimers();
  const here = locate();
  if (!here) return;
  const m = here.movement;
  const since = here.since;
  glintTimer = later(
    glint,
    since < 9 ? Math.max(0.5, rand(4, 9) - since) : gap(m),
  );
  if (m.dust) {
    const first = m.entry + rand(6, 10) - since;
    dustTimer = later(dust, first > 0 ? first : rand(6, 13));
  }
  sectionTimer = later(enter, here.remaining + 0.05);
}

/* ---------- public ---------- */

/** Start (or restart) glinting along with the music. */
export function startGlints(sheet: Cue, where: () => Position | null): void {
  cue = sheet;
  position = where;
  const g = peekAudio();
  if (fx && g) rampTo(fx.out.gain, 1, 1.5);
  enter();
}

/** Stop glinting and fade whatever still rings over `fade` seconds. */
export function stopGlints(fade = 1): void {
  clearTimers();
  if (fx) rampTo(fx.out.gain, 0, fade);
}

/**
 * After the fade: silence the layer outright. Every glint voice still
 * ringing or scheduled (a dust burst runs a few seconds ahead) is stopped,
 * and the echo and cave are dropped, so nothing rings on.
 */
export function haltGlints(): void {
  clearTimers();
  if (!fx) return;
  setNow(fx.out.gain, 0);
  const now = fx.ctx.currentTime;
  for (const src of live) {
    try {
      src.stop(now);
    } catch {
      /* not started yet in some engines: already stopped */
    }
  }
  live.clear();
  sleep(fx);
}

// Crystal chimes, synthesised with Web Audio. No samples, no dependencies.
//
// Each shard draws from the ambient soundscape's G–A–B–D palette: a soft
// bell with harmonic partials, a rounded attack, gentle detuning, and a
// lingering reverb tail.
//
// Browsers refuse to start audio before a user gesture. Call `unlockAudio()`
// from any pointerdown/keydown handler; until then `chime*` calls are
// silently dropped. With Astro's ClientRouter the document persists across
// navigations, so one unlock lasts the whole visit.

export interface ChimeOptions {
  /** 0–1, scales upper harmonics and the strike transient. Default 1. */
  brightness?: number;
  /** 0–1, scales loudness and brightness. Default 0.6. */
  velocity?: number;
  /** Random pitch spread in cents, ± this value. Default 4. */
  spread?: number;
  /** Multiplier on the decay times. Default 1. */
  length?: number;
}

export const MUTED_CHANGE_EVENT = "chime:muted-change";

/* ---------- pitch ---------- */

// Six distinct notes, D4–E4–G4–A4–B4–C5, tuned around the ambient G harmony.
// Explicit pitches avoid octave folding that made several shards identical.
const BASE_HZ = 391.995; // G4
const SHARD_RATIOS = [3 / 4, 5 / 6, 1, 9 / 8, 5 / 4, 4 / 3];

export function noteForIndex(index: number): number {
  return BASE_HZ * (SHARD_RATIOS[index] ?? 1);
}

// Fixed assignments break up the rising visual order and survive reloads.
const shardNoteIndices: Readonly<Record<string, number>> = {
  writing: 3, // A4
  research: 0, // D4
  self: 4, // B4
  philosophy: 2, // G4
  books: 5, // C5
  food: 1, // E4
};

export function noteForShard(id: string): number {
  return noteForIndex(shardNoteIndices[id] ?? 0);
}

/* ---------- shared sound state ---------- */

// Sound starts enabled; ClientRouter navigation preserves the toggle state.
let muted = false;

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  if (next) {
    stopAmbient();
    for (const voice of active) voice.stop();
  } else {
    void enableAmbient();
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
  if (!muted) void enableAmbient();
  return true;
}

export function audioAvailable(): boolean {
  return !!graph && graph.ctx.state === "running";
}

/* ---------- optional ambient soundscape ---------- */

let ambientTimer: number | undefined;
let ambientBus: GainNode | null = null;
const ambientVoices = new Set<OscillatorNode>();

// Each stage lasts several overlapping phrases. The sequence advances only
// while playing, preserving its place across navigation and hidden tabs.
const AMBIENT_STAGES = [
  {
    phrases: 1,
    root: 1 / 2,
    layers: [1, 3 / 2],
    level: 0.025,
    texture: 0,
    notes: [2, 5 / 2, 3],
  },
  {
    phrases: 3,
    root: 1 / 4,
    layers: [1, 3 / 2, 2],
    level: 0.035,
    texture: 0.12,
    notes: [1, 3 / 2, 2],
  },
  {
    phrases: 3,
    root: 1 / 4,
    layers: [1, 3 / 2, 2, 5 / 2],
    level: 0.03,
    texture: 0.3,
    notes: [2, 5 / 2, 3, 9 / 4],
  },
  {
    phrases: 2,
    root: 1 / 2,
    layers: [1, 3 / 2],
    level: 0.026,
    texture: 0.06,
    notes: [1, 3 / 2, 2],
  },
] as const;
let ambientStage = 0;
let stagePhrase = 0;

function ambientVoice(
  hz: number,
  duration: number,
  level: number,
  texture = 0,
  attack = 2,
  delay = 0,
): void {
  if (!graph || !ambientBus) return;
  const { ctx } = graph;
  const start = ctx.currentTime + delay;
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0, start);
  // Let the initial rise bloom into a sustained crest before releasing.
  envelope.gain.linearRampToValueAtTime(level * 0.65, start + attack);
  envelope.gain.linearRampToValueAtTime(level, start + attack + 4);
  envelope.gain.setValueAtTime(level, start + attack + 7);
  envelope.gain.linearRampToValueAtTime(0, start + duration);
  const pan = ctx.createStereoPanner();
  pan.pan.value = (Math.random() - 0.5) * 1.1;
  envelope.connect(pan);
  pan.connect(ambientBus);

  // Transfer weight to the main tone as the envelope rises: quiet tails
  // retain movement, while the crest has much less beating. The two
  // fundamental weights always sum to 2 to preserve the swell's level.
  const partials = [
    { ratio: 1, detune: -1.25, gain: 1.39, crestGain: 1.88 },
    { ratio: 1, detune: 1.75, gain: 0.61, crestGain: 0.12 },
    ...(texture > 0
      ? [
          { ratio: 2, detune: -2.6, gain: texture, crestGain: texture * 0.4 },
          {
            ratio: 3,
            detune: 2.2,
            gain: texture * 0.3,
            crestGain: texture * 0.12,
          },
        ]
      : []),
  ];
  let remaining = partials.length;
  for (const partial of partials) {
    const osc = ctx.createOscillator();
    osc.frequency.value = hz * partial.ratio;
    osc.detune.value = partial.detune;
    const weight = ctx.createGain();
    weight.gain.setValueAtTime(partial.gain, start);
    weight.gain.linearRampToValueAtTime(
      partial.gain + (partial.crestGain - partial.gain) * 0.65,
      start + attack,
    );
    weight.gain.linearRampToValueAtTime(partial.crestGain, start + attack + 4);
    weight.gain.setValueAtTime(partial.crestGain, start + attack + 7);
    weight.gain.linearRampToValueAtTime(partial.gain, start + duration);
    osc.connect(weight);
    weight.connect(envelope);
    ambientVoices.add(osc);
    osc.onended = () => {
      ambientVoices.delete(osc);
      osc.disconnect();
      weight.disconnect();
      if (--remaining === 0) {
        envelope.disconnect();
        pan.disconnect();
      }
    };
    osc.start(start);
    osc.stop(start + duration);
  }
}

function ambientPhrase(): void {
  if (muted || document.hidden) return;
  const stage = AMBIENT_STAGES[ambientStage];
  const root = BASE_HZ * stage.root;
  stage.layers.forEach((ratio, i) => {
    ambientVoice(
      root * ratio,
      26 + i * 2,
      stage.level / (1 + i * 0.7),
      stage.texture,
      stagePhrase === 0 && ambientStage === 0 ? 3.5 : 7 + i,
    );
  });
  ambientVoice(
    root * stage.notes[Math.floor(Math.random() * stage.notes.length)],
    18 + Math.random() * 6,
    0.009,
    stage.texture * 0.5,
    5,
  );
  // Soft G4, B4, and D5 entrances gradually fill out the opening. Their
  // tails overlap the deeper section without extending the intro.
  if (ambientStage === 0) {
    [1, 5 / 4, 3 / 2].forEach((ratio, i) => {
      ambientVoice(BASE_HZ * ratio, 19, 0.006, 0, 2.5, 3 + i * 3);
    });
  }
  // Midway through the low section, float a higher G–A–B–D line above
  // the bass. Carry it into the fuller stage with staggered entrances.
  if ((ambientStage === 1 && stagePhrase >= 1) || ambientStage === 2) {
    const upperNotes = [1, 9 / 8, 5 / 4, 3 / 2];
    const note = upperNotes[Math.floor(Math.random() * upperNotes.length)];
    ambientVoice(BASE_HZ * note, 23, 0.012, 0.04, 4, 6);
    if (ambientStage === 2) ambientVoice(BASE_HZ, 22, 0.007, 0, 5, 10);
  }
  const nextPhraseMs =
    ambientStage === 0
      ? 12000 + Math.random() * 2000
      : 14000 + Math.random() * 4000;
  stagePhrase += 1;
  if (stagePhrase >= stage.phrases) {
    stagePhrase = 0;
    ambientStage = (ambientStage + 1) % AMBIENT_STAGES.length;
  }
  ambientTimer = window.setTimeout(ambientPhrase, nextPhraseMs);
}

function stopAmbient(): void {
  window.clearTimeout(ambientTimer);
  ambientTimer = undefined;
  const bus = ambientBus;
  ambientBus = null;
  if (!graph || !bus) return;
  const now = graph.ctx.currentTime;
  // This bus has a constant gain until stopping, so no hold API is needed.
  // cancelAndHoldAtTime is unavailable in some Web Audio implementations.
  bus.gain.cancelScheduledValues(now);
  bus.gain.setValueAtTime(bus.gain.value, now);
  bus.gain.linearRampToValueAtTime(0, now + 1.5);
  for (const osc of ambientVoices) osc.stop(now + 1.6);
  ambientVoices.clear();
  window.setTimeout(() => bus.disconnect(), 1800);
}

function startAmbient(): void {
  if (!graph || ambientBus || document.hidden) return;
  ambientBus = graph.ctx.createGain();
  ambientBus.gain.value = 0.7;
  ambientBus.connect(graph.master);
  ambientBus.connect(graph.wet);
  ambientPhrase();
}

async function enableAmbient(): Promise<void> {
  try {
    const g = ensureGraph();
    if (!g) throw new Error("Web Audio unavailable");
    await g.ctx.resume();
    if (!muted) {
      startAmbient();
      document.dispatchEvent(new Event(MUTED_CHANGE_EVENT));
    }
  } catch {
    // Autoplay may be blocked. Keep sound enabled and retry on a gesture.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAmbient();
  else if (!muted) void enableAmbient();
});

/* ---------- voices ---------- */

// Soft harmonic overtones blend with the ambient sine voices.
const PARTIALS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 2.6],
  [2, 0.2, 1.8],
  [3, 0.07, 1.2],
  [4, 0.025, 0.8],
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
  const spread = opts.spread ?? 4;
  const brightness = Math.max(0, Math.min(1, opts.brightness ?? 1));
  const length = opts.length ?? 1;
  const { ctx, master, wet } = g;
  const t0 = ctx.currentTime + 0.005;

  // steal the oldest voice past the polyphony cap
  while (active.length >= MAX_VOICES) {
    const oldest = active.shift();
    oldest?.stop();
  }

  const voice = ctx.createGain();
  voice.gain.value = velocity * 0.38;
  voice.connect(master);
  voice.connect(wet);

  const strikeDetune = (Math.random() * 2 - 1) * spread;
  const nodes: AudioScheduledSourceNode[] = [];
  let longest = 0;

  // partials: each a sine with its own exponential decay and tiny detune
  PARTIALS.forEach(([ratio, amp, decay], i) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    const partialDetune = strikeDetune + (Math.random() * 2 - 1) * (1 + i);
    osc.frequency.value = hz * ratio * cents(partialDetune);

    // brighter strikes carry more of the upper partials
    const level = amp * (i === 0 ? 1 : (0.55 + velocity * 0.6) * brightness);
    const d = decay * length * (0.85 + velocity * 0.3);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), t0 + 0.045);
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
  tink.gain.setValueAtTime(Math.max(0.0001, 0.025 * velocity * brightness), t0);
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
  chimeNote(
    noteForShard(id),
    { brightness: id === "books" ? 0.35 : 1, ...opts },
    id,
  );
}

// Reflect the initial sound state as soon as the module loads.
if (typeof document !== "undefined") {
  document.documentElement.toggleAttribute("data-muted", muted);
}

/* Cavern of Light: the offline engine.
 *
 * A faithful copy of the approved prototype (draft 8, "Cavern of Light"),
 * refactored so it can render in an OfflineAudioContext:
 *
 *   - Math.random → seeded mulberry32 streams, so a render is reproducible.
 *   - setTimeout / performance.now → a discrete-event queue on the audio
 *     clock. `later()` pushes an event at `now + ms/1000`; `clearTimers()`
 *     cancels the pending ones exactly as clearTimeout did. Events run in
 *     time order and every AudioParam call uses the event's own time, so
 *     all scheduling is done ahead of the render position.
 *   - voices take `release(r, atTime)`; `hold()` keeps cancelAndHoldAtTime
 *     and adds the anchor the prototype was missing (see "automation model").
 *   - releases fade exponentially (time constant r/3) instead of linearly
 *     to ~0, and the exits' bus dips are exponential ramps: the linear ones
 *     read as snaps. Everything else keeps the prototype's shapes.
 *   - movement lengths keep the ±6% jitter, drawn from their own seeded
 *     stream up front, so the whole timeline is known before the context is
 *     created (an OfflineAudioContext needs its length in advance).
 *   - glints and Hover's dust are NOT rendered (`opts.glints` false): they
 *     play live on the site. Their data goes to the cue sheet instead.
 *
 * Levels, voicings and timings are otherwise unchanged. Plain browser script: it
 * defines `window.Cavern`. Kept in the prototype's compact style so it
 * diffs cleanly against it; ESLint and Prettier skip this file.
 */
(function () {
"use strict";

/* ---------- seeded randomness ---------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Independent streams per purpose, so adding a call in one place never
// reshuffles another (e.g. the impulse response stays fixed).
function stream(seed, label) {
  let h = 2166136261 ^ seed;
  for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return mulberry32(h >>> 0);
}

/* ---------- pitch ---------- */
const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const midi = n => 12 * (+n.slice(1) + 1) + NOTE[n[0]];
const hz = n => 440 * 2 ** ((midi(n) - 69) / 12);

/* ---------- the arc (verbatim from the prototype) ---------- */
const MOVEMENTS = [
  { name: "Void", note: "G · open fifth, almost nothing", secs: 22, I: 0.1, fade: 8, once: true,
    bass: ["G1", "G2"], pad: ["D3", "A3"], glints: ["D5", "G5", "A5", "D6"] },
  { name: "Descent", note: "E → D → B → A · sinking to the deepest point, then rest",
    secs: 100, I: 0.5, fade: 16, inhale: 10, descend: true, exit: 4.5, gap: 3.5,
    bass: ["E1", "E2"],
    organ: ["E2"], strings: true,
    walk: [
      { at: 0.3, bass: ["D1", "D2"], organ: ["D2"] },
      { at: 0.55, bass: ["B0", "B1"], organ: ["B1"], pad: ["E3", "G3", "B3"] },
      { at: 0.75, bass: ["A0", "A1"], organ: ["A1"], pad: ["E3", "G3"] },
    ],
    pad: ["G3", "B3", "D4"], line: ["E5", "D5", "B4", "A4", "G4", "E4", "D4", "B3"],
    glints: ["G6", "E6", "D6", "B5", "A5", "G5", "E5", "D5", "B4", "A4"], slide: true },
  { name: "Awe", note: "G → C · builds on an open fifth, then resolves", secs: 96, I: 1.0, fade: 6, bloom: 0.58, exit: 3, gap: 2.2, settle: 8,
    rumble: true, bass: ["G1", "G2"], pad: [],
    score: {
      pedal: "G1",
      strings: [["D3", 4], ["A3", 12], ["D4", 24], ["A4", 34]],
      horn: [["G3", 14], ["D5", 40]],
      arrive: { strings: ["E3", "G3", "C4", "G4"], horn: ["E4"], high: ["E5"] },
      settleAfter: 8,
      settle: { bass: ["C1", "C2", "G2"], pedal: "C1", strings: ["C3"], horn: ["C4"], high: ["G5"] },
    },
    glints: ["E6", "G6", "B6", "D7"] },
  { name: "Hover", note: "D suspended · the afterglow", secs: 80, I: 0.28, fade: 7, tremolo: 0.28, dust: true,
    bass: ["D2", "A2"], pad: ["E3", "A3", "D4", "G4"], glints: ["A5", "D6", "E6", "A6"] },
  { name: "Return", note: "G · the dark closes again", secs: 95, I: 0.08, fade: 18, fadeOut: true, detune: 0.7,
    bass: ["G1", "D2"], pad: ["B3", "D4"], glints: ["G5", "B5", "D6"] },
];

/* Leon's approved settings (the prototype's defaults). */
const DEFAULTS = { space: 0.7, light: 0.37, depth: 0.73, swell: 1, air: 0.3, pace: 1 };

/* The order movements are entered in: Void once, then the cycle. */
function sequence(count) {
  const out = [];
  let i = 0, visited = false;
  while (out.length < count) {
    let next = i % MOVEMENTS.length;
    if (MOVEMENTS[next].once && visited) next = (next + 1) % MOVEMENTS.length;
    visited = true;
    out.push(next);
    i = next + 1;
  }
  return out;
}

/** The timeline: every movement's index, start and (jittered) length. */
function plan({ seed = 1, settings = {}, count = 9 } = {}) {
  const S = { ...DEFAULTS, ...settings };
  const r = stream(seed, "lengths");
  let at = 0;
  return sequence(count).map(index => {
    const m = MOVEMENTS[index];
    const length = m.secs * S.pace * (0.94 + r() * 0.12);
    const entry = { index, name: m.name, start: at, length };
    at += length;
    return entry;
  });
}

/**
 * Build the cavern into `ctx`, feeding `master`. Call `advance(t)` to run
 * every event before audio time t; it may be called repeatedly (from
 * OfflineAudioContext.suspend callbacks) as long as t never goes backwards
 * past the render position.
 */
function create(ctx, master, { seed = 1, settings = {}, timeline, glints = false, log = () => {} }) {
  const S = { ...DEFAULTS, ...settings };
  const R = stream(seed, "voices");
  const rand = (a, b) => a + R() * (b - a);
  const pick = a => a[Math.floor(R() * a.length)];

  /* ---------- the audio-clock event queue ---------- */
  let now = 0, gen = 0, seq = 0;
  const queue = [];
  function push(t, fn, cancelable) {
    const ev = { t, fn, gen: cancelable ? gen : -1, seq: seq++ };
    let lo = 0, hi = queue.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; const q = queue[mid]; if (q.t < t || (q.t === t && q.seq < ev.seq)) lo = mid + 1; else hi = mid; }
    queue.splice(lo, 0, ev);
  }
  const later = (fn, ms) => push(now + ms / 1000, fn, true);  // was setTimeout + timers[]
  const after = (fn, secs) => push(now + secs, fn, false);     // was a bare setTimeout
  const clearTimers = () => { gen++; };
  function advance(until) {
    while (queue.length && queue[0].t < until) {
      const ev = queue.shift();
      if (ev.gen !== -1 && ev.gen !== gen) continue;
      now = ev.t;
      ev.fn();
    }
  }

  const waves = {};
  let cavern, cavernIn, echoIn, padBus, padFilter, padTrem, tremAmt, choirIn, droneBus, droneFade, glintBus, airGain, organWave;
  let section = -1, prevMove = null, sectionStart = 0, sectionLen = 1;
  let aweArrive = 0;
  let voices = { bass: [], pad: [], organ: [], choir: [], high: [], line: [], pedal: [], brass: [], rumble: [] };
  let visit = 0;

  function impulse(seconds) {
    const rnd = stream(seed, "impulse");
    const rrand = (a, b) => a + rnd() * (b - a);
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      let y = 0;
      for (let i = 0; i < len; i++) {
        const t = i / rate, u = i / len;
        const env = Math.exp(-6.9 * t / seconds) * Math.min(1, t / 0.08);
        const a = 0.55 * (1 - u) ** 2 + 0.03;
        y += a * ((rnd() * 2 - 1) - y);
        d[i] = y * env * 1.6;
      }
      for (let k = 0; k < 9; k++) {
        const i = Math.floor(rate * rrand(0.012, 0.12));
        d[i] += (rnd() < 0.5 ? -1 : 1) * rrand(0.25, 0.6) * (1 - k / 12);
      }
    }
    return buf;
  }

  function build() {
    cavern = ctx.createConvolver();
    cavernIn = ctx.createGain();
    const cavernOut = ctx.createGain(); cavernOut.gain.value = 0.9;
    cavernIn.connect(cavern); cavern.connect(cavernOut); cavernOut.connect(master);
    applySpace();

    echoIn = ctx.createGain();
    const dl = ctx.createDelay(3), dr = ctx.createDelay(3);
    dl.delayTime.value = 0.83; dr.delayTime.value = 1.29;
    const fb = ctx.createGain(); fb.gain.value = 0.42;
    const tone = ctx.createBiquadFilter(); tone.type = "lowpass"; tone.frequency.value = 2400;
    const merger = ctx.createChannelMerger(2);
    echoIn.connect(dl); dl.connect(dr); dr.connect(tone); tone.connect(fb); fb.connect(dl);
    dl.connect(merger, 0, 0); dr.connect(merger, 0, 1);
    const echoOut = ctx.createGain(); echoOut.gain.value = 0.5;
    merger.connect(echoOut); echoOut.connect(master); echoOut.connect(cavernIn);

    padFilter = ctx.createBiquadFilter(); padFilter.type = "lowpass"; padFilter.Q.value = 0.5; padFilter.frequency.value = 300; tracked(padFilter.frequency);
    padTrem = ctx.createGain(); padTrem.gain.value = 1;
    const trem = ctx.createOscillator(); trem.frequency.value = 0.19;
    tremAmt = ctx.createGain(); tremAmt.gain.value = 0;
    trem.connect(tremAmt); tremAmt.connect(padTrem.gain); trem.start();
    padBus = ctx.createGain(); padBus.gain.value = 0.2; tracked(padBus.gain);
    padFilter.connect(padTrem); padTrem.connect(padBus); padBus.connect(master); padBus.connect(cavernIn);

    choirIn = ctx.createGain();
    const choirOut = ctx.createGain(); choirOut.gain.value = 1.4;
    [[760, 7, 1], [1150, 8, 0.6], [2800, 10, 0.18]].forEach(([f, q, g]) => {
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = f; bp.Q.value = q;
      const lvl = ctx.createGain(); lvl.gain.value = g;
      choirIn.connect(bp); bp.connect(lvl); lvl.connect(choirOut);
    });
    choirOut.connect(padTrem);

    const wave = amps => ctx.createPeriodicWave(new Float32Array(amps), new Float32Array(amps.length));
    organWave = wave([0, 1, 0.3, 0.12, 0.05, 0.02]);
    waves.soft = wave(Array.from({ length: 12 }, (_, n) => (n ? n ** -1.9 : 0)));
    waves.horn = wave([0, 1, 0.42, 0.18, 0.08, 0.035, 0.015]);
    waves.string = wave(Array.from({ length: 16 }, (_, n) => (n ? n ** -1.3 : 0)));

    droneBus = ctx.createGain(); droneBus.gain.value = S.depth;
    droneFade = ctx.createGain(); droneFade.gain.value = 1; tracked(droneFade.gain);
    const droneLp = ctx.createBiquadFilter(); droneLp.type = "lowpass"; droneLp.frequency.value = 320;
    droneBus.connect(droneFade); droneFade.connect(droneLp); droneLp.connect(master); droneLp.connect(cavernIn);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.031;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 0.15;
    lfo.connect(lfoAmt); lfoAmt.connect(droneBus.gain); lfo.start();

    glintBus = ctx.createGain(); glintBus.gain.value = 1;
    const glintDry = ctx.createGain(); glintDry.gain.value = 0.25;
    glintBus.connect(glintDry); glintDry.connect(master);
    glintBus.connect(cavernIn); glintBus.connect(echoIn);

    const rn = stream(seed, "air");
    const n = ctx.sampleRate * 6, nb = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = nb.getChannelData(ch); for (let i = 0; i < n; i++) d[i] = rn() * 2 - 1; }
    const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true;
    const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 520; bp.Q.value = 0.7;
    const airLfo = ctx.createOscillator(); airLfo.frequency.value = 0.017;
    const airLfoAmt = ctx.createGain(); airLfoAmt.gain.value = 260;
    airLfo.connect(airLfoAmt); airLfoAmt.connect(bp.frequency); airLfo.start();
    airGain = ctx.createGain(); airGain.gain.value = S.air * 0.03;
    noise.connect(bp); bp.connect(airGain); airGain.connect(master); airGain.connect(cavernIn);
    noise.start();
  }

  function applySpace() {
    const secs = 4 + S.space * 7;
    cavern.buffer = impulse(secs);
    cavernIn.gain.setTargetAtTime(0.25 + S.space * 0.75, now, 0.5);
  }

  /* ---------- automation model ----------
     The prototype's hold() relied on cancelAndHoldAtTime to pin a param at
     its current value. Per the spec (and in Chrome), when the cancel time
     falls after a ramp has already finished, no hold point is inserted, so
     the next ramp starts from the end of that old ramp instead: live, the
     level jumped at each release; offline, where everything is scheduled
     ahead, a release began the moment the attack ended and plunged late.
     So the params that are ever held keep a model of their schedule, and
     hold() adds an explicit anchor at the modelled value. */
  function tracked(p) {
    const m = { init: p.value, ev: [] };
    let n = 0;
    const add = e => { e.i = n++; m.ev.push(e); m.ev.sort((a, b) => a.t - b.t || a.i - b.i); };
    const o = {
      set: p.setValueAtTime.bind(p), lin: p.linearRampToValueAtTime.bind(p), exp: p.exponentialRampToValueAtTime.bind(p),
      tgt: p.setTargetAtTime.bind(p), curve: p.setValueCurveAtTime.bind(p), cancel: p.cancelScheduledValues.bind(p),
      hold: p.cancelAndHoldAtTime ? p.cancelAndHoldAtTime.bind(p) : null,
    };
    p.setValueAtTime = (v, t) => { add({ k: "set", v, t }); return o.set(v, t); };
    p.linearRampToValueAtTime = (v, t) => { add({ k: "lin", v, t }); return o.lin(v, t); };
    p.exponentialRampToValueAtTime = (v, t) => { add({ k: "exp", v, t }); return o.exp(v, t); };
    p.setTargetAtTime = (v, t, tau) => { add({ k: "tgt", v, t, tau }); return o.tgt(v, t, tau); };
    p.setValueCurveAtTime = (c, t, d) => { add({ k: "curve", c: Array.from(c), t, d }); return o.curve(c, t, d); };
    p.cancelScheduledValues = t => { m.ev = m.ev.filter(e => e.t < t); return o.cancel(t); };
    p.__valueAt = x => valueAt(m, x);
    p.__hold = t => {
      const v = valueAt(m, t);
      // Drop what the browser drops: events at or after t, and a ramp or
      // curve still running at t (its held value becomes the anchor).
      m.ev = m.ev.filter(e => e.t < t && !(e.k === "curve" && e.t + e.d > t));
      if (o.hold) o.hold(t); else o.cancel(t);
      add({ k: "set", v, t });
      o.set(v, t);
    };
    return p;
  }

  function valueAt(m, x) {
    let v = m.init, t0 = 0, tgt = null;
    const at = t => (tgt ? tgt.v + (tgt.v0 - tgt.v) * Math.exp(-(t - tgt.t) / tgt.tau) : v);
    for (const e of m.ev) {
      if (e.k === "lin" || e.k === "exp") {
        const v0 = at(t0);
        if (x < e.t) {
          if (x <= t0) return at(x);
          const u = (x - t0) / (e.t - t0);
          return e.k === "lin" ? v0 + (e.v - v0) * u : v0 * (e.v / v0) ** u;
        }
        v = e.v; t0 = e.t; tgt = null;
        continue;
      }
      if (e.t > x) break;
      if (e.k === "set") { v = e.v; t0 = e.t; tgt = null; }
      else if (e.k === "tgt") { tgt = { v: e.v, t: e.t, tau: e.tau, v0: at(e.t) }; t0 = e.t; }
      else if (e.k === "curve") {
        const end = e.t + e.d;
        if (x < end) {
          const pos = ((x - e.t) / e.d) * (e.c.length - 1), k = Math.floor(pos);
          return e.c[k] + (e.c[Math.min(k + 1, e.c.length - 1)] - e.c[k]) * (pos - k);
        }
        v = e.c[e.c.length - 1]; t0 = end; tgt = null;
      }
    }
    return at(x);
  }

  /* ---------- voices ---------- */
  function hold(p, t) {
    if (p.__hold) { p.__hold(t); return; }
    if (p.cancelAndHoldAtTime) { p.cancelAndHoldAtTime(t); return; }
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }

  function sustained({ note, type, level, attack, pan = 0, detunes = [0], dest, vibrato = 0, delay = 0, rise = 0 }) {
    const t = now + delay;
    const g = ctx.createGain();
    tracked(g.gain);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    const p = ctx.createStereoPanner(); p.pan.value = pan;
    g.connect(p); p.connect(dest);
    const f = hz(note);
    const oscs = detunes.map(c => {
      const o = ctx.createOscillator();
      if (type === "organ") o.setPeriodicWave(organWave); else if (waves[type]) o.setPeriodicWave(waves[type]); else o.type = type;
      if (rise) {
        o.frequency.setValueAtTime(f * 2 ** (-rise / 12), t);
        o.frequency.exponentialRampToValueAtTime(f, t + attack * 1.1);
      } else o.frequency.value = f;
      o.detune.value = c;
      o.connect(g); o.start(t); return o;
    });
    let vib;
    if (vibrato) {
      vib = ctx.createOscillator(); vib.frequency.value = rand(0.12, 0.2);
      const amt = ctx.createGain(); amt.gain.value = vibrato;
      vib.connect(amt); oscs.forEach(o => amt.connect(o.detune)); vib.start(t);
    }
    return {
      note,
      osc: oscs,
      glide(to, secs, at = now) {
        oscs.forEach(o => { hold(o.frequency, at); o.frequency.exponentialRampToValueAtTime(hz(to), at + secs); });
      },
      release(r, at = now) {
        if (at < t) { g.gain.cancelScheduledValues(at); oscs.forEach(o => o.stop(at + 0.05)); vib?.stop(at + 0.05); return; }
        hold(g.gain, at);
        // An exponential fade (the prototype ramped linearly to ~0, which
        // the ear hears as a sudden drop at the end), stopped ~60 dB down.
        const end = at + r * 2.3;
        g.gain.setTargetAtTime(0, at, r / 3);
        oscs.forEach(o => o.stop(end + 0.2));
        vib?.stop(end + 0.2);
        push(end + 1, () => p.disconnect(), false);
      },
    };
  }

  const releaseAll = (kinds, r) => kinds.forEach(k => { voices[k].forEach(v => v.release(r)); voices[k] = []; });

  function setBass(notes, fade, attack = fade + 2) {
    const out = Math.min(5, fade);
    releaseAll(["bass"], out);
    voices.bass = notes.map((note, k) => sustained({
      note, type: "sine", level: [0.09, 0.06, 0.045][k] * (note === "C1" ? 1.3 : 1),
      attack, delay: out * 0.75, dest: droneBus,
    }));
    log({ t: now + out * 0.75, bass: notes });
  }

  function enter(i) {
    let next = i % MOVEMENTS.length;
    if (MOVEMENTS[next].once && visit > 0) next = (next + 1) % MOVEMENTS.length;
    clearTimers();
    const prev = prevMove;
    section = next;
    const m = MOVEMENTS[section];
    prevMove = m;
    const t = now;
    const I = m.I * (0.35 + 0.65 * S.swell) + (1 - S.swell) * 0.15;
    const calm = 1 - 0.85 * Math.min(1, I);
    const fade = m.fade * Math.min(1.3, Math.max(0.6, S.pace));
    const planned = timeline[visit];
    if (!planned || planned.index !== section) throw new Error(`timeline mismatch at visit ${visit}`);
    sectionLen = planned.length;
    visit++;
    const rise = prev?.fadeOut ? 24 : 0;

    const out = prev?.exit ?? fade + 3;
    const gap = prev?.gap ?? 0;
    releaseAll(["pad", "organ", "choir", "high", "line", "pedal", "brass", "rumble"], out);
    if (prev?.exit) {
      const bus = [padBus.gain, droneFade.gain];
      // Exponential, so the stark exit falls evenly in dB, not in a snap.
      bus.forEach(p => { hold(p, t); p.exponentialRampToValueAtTime(0.02, t + out); });
      hold(padFilter.frequency, t);
    }
    const at = gap ? gap + out * 0.6 : 0;
    log({ t, movement: m.name, at });
    voices.bass.forEach(v => v.release(prev?.exit ? out : Math.min(5, fade)));
    voices.bass = [];
    later(() => { setBass(m.bass, prev?.exit ? fade * 0.6 : fade, m.bloom ? 24 : undefined); }, (at + (prev?.exit ? 0 : Math.min(5, fade) * 0.75)) * 1000);

    const spread = n => (k => (k / Math.max(1, n - 1) - 0.5) * 1.4);
    const mk = (kind, notes, opts) => { voices[kind] = notes.map((note, k) => sustained({ note, delay: at, pan: spread(notes.length)(k), ...opts(k) })); };
    const padType = m.strings ? "string" : "sawtooth";
    const padVib = m.strings ? 3 * calm + 0.5 : 0;
    const spreadC = m.detune ?? 4 * calm + 0.3;
    mk("pad", m.pad, k => ({ type: padType, level: 0.016, attack: fade + k * 2.5, detunes: [-spreadC, spreadC], dest: padFilter, vibrato: padVib }));
    if (m.pad.length) log({ t: t + at, chord: m.pad });
    if (m.organ) mk("organ", m.organ, () => ({ type: "organ", level: 0.024, attack: fade + 4, detunes: [0], dest: padFilter, pan: 0 }));
    if (m.rumble) voices.rumble = [rumble(at)];

    if (m.line) {
      const lineNote = (note, first) => sustained({ note, type: "soft", level: first && rise ? 0.022 : 0.03, attack: first && rise ? 9 : 4, pan: 0.2, detunes: [0], dest: padFilter });
      const lead = rise ? 16 : 0;
      const span = sectionLen - (m.inhale || 0) - 12 - lead;
      m.line.forEach((note, k) => later(() => {
        voices.line.forEach(v => v.release(5));
        voices.line = [lineNote(note, k === 0)];
        log({ t: now, line: note });
      }, (at + 6 + lead + span * k / m.line.length) * 1000));
    }
    (m.walk || []).forEach(w => later(() => {
      setBass(w.bass, 10);
      if (w.pad) {
        releaseAll(["pad"], 9);
        voices.pad = w.pad.map((note, k) => sustained({ note, type: padType, level: 0.016, attack: 10 + k * 2, pan: spread(w.pad.length)(k), detunes: [-4 * calm - 0.3, 4 * calm + 0.3], dest: padFilter, vibrato: padVib }));
        log({ t: now, chord: w.pad });
      }
      if (w.organ) {
        releaseAll(["organ"], 6);
        voices.organ = w.organ.map(note => sustained({ note, type: "organ", level: 0.024, attack: 8, delay: 2, detunes: [0], dest: padFilter }));
      }
    }, sectionLen * w.at * 1000));

    const g = padBus.gain, f = padFilter.frequency;
    const s0 = t + (prev?.exit ? out : 0);
    [g, f].forEach(p => { if (!prev?.exit) hold(p, t); });
    if (prev?.exit) f.setValueAtTime(260, s0);
    if (!prev?.exit) {
      hold(droneFade.gain, t);
    }
    droneFade.gain.linearRampToValueAtTime(1, s0 + at + fade + rise);
    tremAmt.gain.setTargetAtTime(m.tremolo || 0, t, 3);

    if (m.bloom) {
      const start = Math.max(s0, t + at) + 0.05;
      const build = sectionLen * m.bloom, arrive = start + build;
      const end = t + sectionLen;
      const holdAt = Math.min(end - 12, arrive + (m.settle || 0) + 8);
      const curve = (a, b) => Float32Array.from({ length: 96 }, (_, i) => a + (b - a) * (i / 95) ** 2);
      const gBuild = 0.12 + 0.4 * I, gPeak = 0.2 + 0.75 * I;
      const fBuild = 350 + 750 * I, fPeak = 600 + 2000 * I;
      g.setValueCurveAtTime(curve(0.1, gBuild), start, build);
      f.setValueCurveAtTime(curve(300, fBuild), start, build);
      g.setTargetAtTime(gPeak, arrive + 0.05, 0.9);
      f.setTargetAtTime(fPeak, arrive + 0.05, 0.7);
      g.setValueAtTime(gPeak, holdAt);
      g.linearRampToValueAtTime(0.06, end);
      f.setValueAtTime(fPeak, holdAt);
      f.exponentialRampToValueAtTime(420, end);
      aweArrive = arrive;
      if (m.score) score(m.score, at, calm);
    } else if (m.descend) {
      const inhaleAt = t + sectionLen - m.inhale;
      g.setTargetAtTime(0.15 + 0.85 * I, t, fade / 2.2 + rise / 2.5);
      g.setTargetAtTime(0.12 + 0.6 * I, t + sectionLen * 0.5, sectionLen * 0.15);
      f.setTargetAtTime(1300, t, fade / 1.8 + rise / 2.5);
      f.setValueAtTime(1300, t + fade * 2 + rise);
      f.exponentialRampToValueAtTime(330, inhaleAt);
      g.setTargetAtTime(0.1, inhaleAt, m.inhale / 3.5);
      f.setTargetAtTime(220, inhaleAt, m.inhale / 3.5);
      droneFade.gain.setTargetAtTime(0.45, inhaleAt, m.inhale / 3);
    } else {
      g.setTargetAtTime(0.15 + 0.85 * I, s0 + at, fade / 2.2);
      f.setTargetAtTime(260 + 1900 * I ** 1.6, s0 + at, fade / 1.8);
      if (m.fadeOut) {
        g.setTargetAtTime(0.03, t + sectionLen * 0.35, sectionLen * 0.2);
        f.setTargetAtTime(200, t + sectionLen * 0.35, sectionLen * 0.2);
        droneFade.gain.setTargetAtTime(0.2, t + sectionLen * 0.4, sectionLen * 0.2);
      }
    }

    if (glints) {
      later(glint, rand(4, 9) * 1000);
      if (m.dust) later(dust, (at + rand(6, 10)) * 1000);
    }

    sectionStart = now;
    later(() => enter(section + 1), sectionLen * 1000);
  }

  /* ---------- glass (kept for completeness; off in the bed render) ---------- */
  const GLASS = [[1, .62, 3.2, .006, -1.6], [1, .42, 3.0, .006, 1.6], [2.32, .11, 1.3, .004, 0], [4.25, .04, .6, .003, 0], [6.63, .014, .28, .002, 0]];

  function strike(freq, velocity, dest, pan = 0, length = 1, delay = 0, partials = GLASS) {
    const t0 = now + 0.01 + delay;
    const out = ctx.createGain(); out.gain.value = velocity * 0.38;
    const p = ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(p); p.connect(dest);
    let longest = 0;
    const jitter = rand(-4, 4);
    partials.forEach(([ratio, amp, decay, attack, detune], i) => {
      const o = ctx.createOscillator();
      o.frequency.value = freq * ratio * 2 ** ((jitter + detune) / 1200);
      const d = decay * length * (0.85 + velocity * 0.3), lvl = amp * (i === 0 ? 1 : 0.55 + velocity * 0.6);
      const e = ctx.createGain();
      e.gain.setValueAtTime(0.0001, t0);
      e.gain.exponentialRampToValueAtTime(Math.max(0.0001, lvl), t0 + attack);
      e.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(e); e.connect(out); o.start(t0); o.stop(t0 + d + 0.05);
      longest = Math.max(longest, d);
    });
    after(() => p.disconnect(), delay + longest + 0.5);
  }

  function score(sc, at, calm) {
    const strings = (note, k, n, attack, delay) => sustained({
      note, type: "string", level: 0.026, attack, delay, pan: (k / Math.max(1, n - 1) - 0.5) * 1.3,
      detunes: [-3 * calm - 0.4, 3 * calm + 0.4], dest: padFilter, vibrato: 2.5 * calm + 0.8,
    });
    const horn = (note, attack, delay) => sustained({ note, type: "horn", level: 0.02, attack, delay, pan: -0.15, detunes: [0], dest: padFilter });
    voices.pedal = [sustained({ note: sc.pedal, type: "organ", level: 0.04, attack: 14, delay: at, dest: droneBus })];
    voices.pad = sc.strings.map(([note, when], k) => strings(note, k, sc.strings.length, 12, at + when));
    voices.brass = sc.horn.map(([note, when]) => horn(note, 8, at + when));
    log({ t: now + at, chord: [...sc.strings.map(s => s[0]), ...sc.horn.map(h => h[0])] });

    const a = sc.arrive, b = sc.settle;
    const pure = (note, type, level, attack, delay, pan, dest = padFilter) =>
      sustained({ note, type, level, attack, delay, pan, detunes: [0], dest });
    const wait = Math.max(0, (aweArrive - now) * 1000);
    later(() => {
      releaseAll(["pad", "brass"], 2.4);
      voices.pad = a.strings.map((note, k) => pure(note, "string", 0.036, 1.8, 0.05 * k, (k / Math.max(1, a.strings.length - 1) - 0.5) * 1.3));
      voices.brass = a.horn.map(note => pure(note, "horn", 0.03, 2.2, 0.15, -0.15));
      voices.high = a.high.map(note => pure(note, "triangle", 0.016 * S.swell, 3.5, 0.6, -0.45, padBus));
      log({ t: now, chord: [...a.strings, ...a.horn, ...a.high] });
    }, wait);
    later(() => {
      releaseAll(["bass", "pedal"], 2.6);
      voices.bass = b.bass.map((note, k) => sustained({ note, type: "sine", level: [0.1, 0.065, 0.045][k], attack: 2, dest: droneBus }));
      voices.pedal = [sustained({ note: b.pedal, type: "organ", level: 0.045, attack: 2.2, dest: droneBus })];
      voices.pad.push(...b.strings.map(note => pure(note, "string", 0.034, 2.4, 0, 0)));
      voices.brass.push(...b.horn.map(note => pure(note, "horn", 0.024, 2.6, 0.2, 0.2)));
      voices.high.push(...b.high.map(note => pure(note, "triangle", 0.014 * S.swell, 4, 1, 0.45, padBus)));
      log({ t: now, bass: b.bass, chord: [...b.strings, ...a.strings, ...b.horn, ...a.horn, ...a.high, ...b.high] });
    }, wait + sc.settleAfter * 1000);
  }

  function rumble(delay) {
    const t = now + delay;
    const rn = stream(seed, "rumble" + visit);
    const len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = rn() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 95; lp.Q.value = 0.9;
    const g = ctx.createGain();
    tracked(g.gain);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.07, t + 30);
    g.gain.setTargetAtTime(0.02, t + 40, 10);
    src.connect(lp); lp.connect(g); g.connect(master); g.connect(cavernIn);
    src.start(t);
    return { release(r, at = now) { hold(g.gain, at); g.gain.setTargetAtTime(0, at, r / 3); src.stop(at + r * 2.3 + 0.1); } };
  }

  function glint() {
    const m = MOVEMENTS[section];
    let pool = m.glints;
    if (m.slide) {
      const p = Math.min(1, (now - sectionStart) / sectionLen);
      const start = Math.round(p * (pool.length - 3));
      pool = pool.slice(start, start + 3);
    }
    const note = pick(pool), pan = rand(-0.9, 0.9);
    strike(hz(note), rand(0.2, 0.45), glintBus, pan);
    if (R() < 0.3) strike(hz(pick(pool)), rand(0.12, 0.25), glintBus, pan + rand(-0.3, 0.3), 1, rand(0.18, 0.65));
    if (R() < 0.22) {
      const v = sustained({ note, type: "sine", level: 0.01, attack: 2.5, pan, detunes: [0, 2.5], dest: glintBus });
      after(() => v.release(7), 4);
    }
    const quiet = m.fadeOut ? 1.6 : 1;
    const mean = (26 - 20 * S.light - 5 * m.I) * quiet;
    later(glint, Math.max(1.5, -Math.log(1 - R()) * mean) * 1000);
  }

  const TICK = [[1, 1, 0.9, .002, 0], [2.32, .25, .35, .002, 0]];
  function dust() {
    if (!MOVEMENTS[section].dust) return;
    const pool = MOVEMENTS[section].glints.map(n => n[0] + (+n.slice(1) + 1));
    const count = Math.floor(rand(5, 12)), pan = rand(-0.8, 0.8), span = rand(1.2, 2.8);
    for (let k = 0; k < count; k++) {
      strike(hz(pick(pool)), rand(0.05, 0.12), glintBus, pan + rand(-0.35, 0.35), 1, (k / count) * span + rand(0, 0.08), TICK);
    }
    later(dust, rand(6, 13) * 1000);
  }

  build();
  // begin(): enter the first movement at t = 0.
  push(0, () => enter(0), false);
  return { advance, settings: S };
}

window.Cavern = { MOVEMENTS, DEFAULTS, plan, create, midi, hz };
})();

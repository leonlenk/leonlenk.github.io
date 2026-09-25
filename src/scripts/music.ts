// The background-music player: the pre-rendered "Cavern of Light" bed
// (src/data/music.ts), with live glints on top (./glints).
//
// Two HTMLAudioElements, never in the DOM, so they survive ClientRouter
// swaps; each feeds a MediaElementAudioSourceNode → its own gain → a shared
// music bus → the destination. Every level change goes through those gains
// (iOS ignores element.volume). Nothing is decoded into AudioBuffers: a
// six-minute stereo buffer would be ~140 MB, too much for phones.
//
// Timeline: the intro plays once per tab session, then the loop repeats.
// Each file runs `overhang` seconds past its musical end, so at a seam the
// outgoing element still has real music (the continuation that was
// rendered) while the incoming one starts at 0 and the two cross with an
// equal-power fade. The elements ping-pong: one timer per seam, armed from
// the playing element's currentTime; nothing polls.
//
// Nothing loads before the first gesture (preload="none", no src until
// then). `startMusic()` calls play() synchronously, so call it from inside
// the gesture handler (iOS requires that). Navigation never touches the
// player; a full reload resumes the loop where it would have been (the
// position is kept in sessionStorage) with a 3 s fade.

import { music, type Cue } from "../data/music";
import { getAudio, peekAudio, rampTo, setNow } from "./audio";
import { haltGlints, startGlints, stopGlints, type Position } from "./glints";

type Part = "intro" | "loop";

interface Slot {
  el: HTMLAudioElement;
  gain: GainNode;
  part: Part | null;
}

const SAVE_KEY = "shards:music";
const PAUSE_FADE = 1;
const RESUME_FADE = 1.5;
const RELOAD_FADE = 3;
const SAVE_EVERY_MS = 10_000;
// Used only until the cue sheet arrives (or if it cannot).
const FALLBACK_CROSSFADE = 2;
const FALLBACK_OVERHANG = 3;

interface Saved {
  part: Part;
  time: number;
  /** Date.now() when saved. */
  at: number;
}

function readSaved(): Saved | null {
  try {
    const raw = window.sessionStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Saved;
    if ((s.part === "intro" || s.part === "loop") && Number.isFinite(s.time))
      return s;
  } catch {
    // Storage blocked or malformed: start from the intro.
  }
  return null;
}

let slots: Slot[] = [];
let bus: GainNode | null = null;
let current: Slot | null = null;
let format: "webm" | "m4a" = "m4a";
let cue: Cue | null = null;
let cueLoad: Promise<Cue | null> | null = null;
/** Whether music should be sounding (mode on, tab visible). */
let wanted = false;
let boundaryTimer: number | undefined;
let pauseTimer: number | undefined;
let saveTimer: number | undefined;
/** Bumped by each first start, so a refused one can be told apart. */
let attempts = 0;
/** Some play() has succeeded on this page. */
let started = false;
/** A reload's saved position, consumed by the first start. */
let resumeFrom: Saved | null =
  typeof window === "undefined" ? null : readSaved();

function url(part: Part): string {
  return music[part][format];
}

function loadCue(): Promise<Cue | null> {
  cueLoad ??= fetch(music.cue)
    .then((r) => (r.ok ? (r.json() as Promise<Cue>) : null))
    .catch(() => null)
    .then((c) => {
      cue = c;
      // Glints need the cue; start them if the music got there first.
      if (c && wanted && current && !current.el.paused)
        startGlints(c, position);
      if (c) armBoundary();
      return c;
    });
  return cueLoad;
}

function ensureSlots(): boolean {
  if (slots.length) return true;
  const g = getAudio();
  if (!g) return false;
  bus = g.ctx.createGain();
  bus.connect(g.ctx.destination);
  slots = [0, 1].map(() => {
    const el = new Audio();
    el.preload = "none";
    const source = g.ctx.createMediaElementSource(el);
    const gain = g.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(bus!);
    const slot: Slot = { el, gain, part: null };
    el.addEventListener("ended", () => onEnded(slot));
    // A seek or a stall moves the seam in wall time: re-arm its timer.
    const rearm = (): void => {
      if (slot === current) armBoundary();
    };
    el.addEventListener("seeked", rearm);
    el.addEventListener("playing", rearm);
    return slot;
  });
  format = slots[0].el.canPlayType("audio/webm; codecs=opus") ? "webm" : "m4a";
  return true;
}

function load(slot: Slot, part: Part): void {
  if (slot.part === part) return;
  slot.part = part;
  slot.el.src = url(part);
}

/** Where the next part begins, in the slot's own time. */
function seamAt(slot: Slot): number | null {
  if (!slot.part) return null;
  if (cue) return cue[slot.part].duration;
  const d = slot.el.duration;
  return Number.isFinite(d) && d > 0
    ? Math.max(0, d - FALLBACK_OVERHANG)
    : null;
}

function armBoundary(): void {
  window.clearTimeout(boundaryTimer);
  boundaryTimer = undefined;
  const slot = current;
  if (!slot || !wanted || slot.el.paused) return;
  const seam = seamAt(slot);
  if (seam === null) {
    slot.el.addEventListener("durationchange", armBoundary, { once: true });
    return;
  }
  const wait = (seam - slot.el.currentTime) / (slot.el.playbackRate || 1);
  boundaryTimer = window.setTimeout(onBoundary, Math.max(0, wait * 1000 - 20));
}

function onBoundary(): void {
  boundaryTimer = undefined;
  const slot = current;
  if (!slot || !wanted) return;
  const seam = seamAt(slot);
  // Early (the element stalled, or a timer drifted): arm again.
  if (seam !== null && seam - slot.el.currentTime > 0.25) armBoundary();
  else advance();
}

/** Start the loop on the idle element and cross into it. */
function advance(): void {
  const out = current;
  const next = slots.find((s) => s !== out);
  if (!out || !next) return;
  load(next, "loop");
  next.el.currentTime = 0;
  setNow(next.gain.gain, 0);
  current = next;
  next.el.play().then(
    () => {
      if (current !== next || !wanted) return;
      crossfade(out, next, cue?.crossfade ?? FALLBACK_CROSSFADE);
      armBoundary();
    },
    () => {
      // Refused (no gesture on this element yet): the next gesture retries.
      if (current === next) current = out;
    },
  );
}

/** Equal-power crossfade between two element gains. */
function crossfade(out: Slot, into: Slot, secs: number): void {
  const ctx = peekAudio()?.ctx;
  if (!ctx) return;
  const n = 64;
  const up = new Float32Array(n);
  const down = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (Math.PI / 2);
    up[i] = Math.sin(x);
    down[i] = Math.cos(x);
  }
  const t = ctx.currentTime;
  for (const [param, shape] of [
    [out.gain.gain, down],
    [into.gain.gain, up],
  ] as const) {
    param.cancelScheduledValues(t);
    param.setValueAtTime(shape[0], t);
    param.setValueCurveAtTime(shape, t + 0.005, secs);
  }
}

function onEnded(slot: Slot): void {
  if (slot !== current) {
    // The outgoing element ran out its overhang after a crossfade. Park it
    // at the top of the loop, buffered, ready for the next seam.
    setNow(slot.gain.gain, 0);
    load(slot, "loop");
    slot.el.preload = "auto";
    slot.el.currentTime = 0;
    return;
  }
  // The seam was missed (timer never fired): move on at once.
  if (wanted) advance();
}

/** Where the music is, for the glints. */
function position(): Position | null {
  const slot = current;
  if (!slot?.part || slot.el.paused) return null;
  return { part: slot.part, time: slot.el.currentTime };
}

function save(): void {
  const slot = current;
  if (!slot?.part || !started) return;
  try {
    const saved: Saved = {
      part: slot.part,
      time: slot.el.currentTime,
      at: Date.now(),
    };
    window.sessionStorage.setItem(SAVE_KEY, JSON.stringify(saved));
  } catch {
    // Not persisted; a reload will start from the intro.
  }
}

/** Timers and glints that run only while music is playing. */
function onPlaying(): void {
  armBoundary();
  window.clearInterval(saveTimer);
  saveTimer = window.setInterval(save, SAVE_EVERY_MS);
  save();
  if (cue) startGlints(cue, position);
}

/** Loop position a reload should resume at, from the saved state. */
function resumePosition(saved: Saved, c: Cue): number {
  const L = c.loop.duration;
  let t = saved.time + Math.max(0, Date.now() - saved.at) / 1000;
  if (saved.part === "intro") t = Math.max(0, t - c.intro.duration);
  return ((t % L) + L) % L;
}

/**
 * Start or resume the music. Idempotent; cheap when already playing, so
 * it is safe on every gesture and every page load. Call it synchronously
 * from a gesture the first time.
 */
export function startMusic(): void {
  wanted = true;
  if (!ensureSlots() || !bus) return;
  void loadCue();

  if (pauseTimer !== undefined) {
    // Still fading out: turn round without pausing.
    window.clearTimeout(pauseTimer);
    pauseTimer = undefined;
    rampTo(bus.gain, 1, RESUME_FADE);
    onPlaying();
    return;
  }

  if (current?.part) {
    const slot = current;
    // Already playing (or starting): calling play() again inside a gesture
    // lets iOS accept a start that an earlier event could not.
    const resuming = slot.el.paused;
    if (resuming) setNow(bus.gain, 0);
    slot.el.play().then(
      () => {
        markStarted();
        if (!resuming || !wanted || current !== slot) return;
        rampTo(bus!.gain, 1, RESUME_FADE);
        onPlaying();
      },
      () => {},
    );
    return;
  }

  // First start on this page.
  const [first, spare] = slots;
  current = first;
  const saved = resumeFrom;
  resumeFrom = null;
  const attempt = ++attempts;
  // Refused (autoplay without a gesture, or a touch that did not count as
  // one): forget this start so the next gesture begins it afresh.
  const refused = (): void => {
    if (attempt !== attempts || !first.el.paused) return;
    attempts++;
    current = null;
    resumeFrom = saved;
    setNow(bus!.gain, 0);
    for (const fn of stateListeners) fn();
  };
  if (saved) {
    // A reload in the same tab: skip the intro, fade the loop in where it
    // would be now. It plays silently (bus at 0) until the seek lands.
    load(first, "loop");
    setNow(bus.gain, 0);
    setNow(first.gain.gain, 1);
    first.el.play().then(() => {
      markStarted();
    }, refused);
    void Promise.all([loadCue(), metadata(first.el)]).then(([c]) => {
      if (current !== first || attempt !== attempts) return;
      // No cue, no position to go to: begin at the beginning.
      if (!c) return playIntro(first, refused);
      const target = resumePosition(saved, c);
      first.el.addEventListener(
        "seeked",
        () => {
          if (!wanted || attempt !== attempts || current !== first) return;
          // A server without range requests cannot seek, and the loop's
          // head (Return's low drone) is no place to start: play the intro.
          if (Math.abs(first.el.currentTime - target) > 2)
            return playIntro(first, refused);
          rampTo(bus!.gain, 1, RELOAD_FADE);
          onPlaying();
        },
        { once: true },
      );
      first.el.currentTime = target;
    });
  } else {
    playIntro(first, refused);
  }
  // Let the spare element play once inside this gesture too, so iOS
  // allows it to start the loop later without one.
  load(spare, "loop");
  spare.el.play().then(
    () => {
      if (current !== spare) {
        spare.el.pause();
        spare.el.currentTime = 0;
      }
    },
    () => {},
  );
}

/** Play the intro from the top on `slot`. It fades in by itself: the
 * render starts from silence. */
function playIntro(slot: Slot, onRefused: () => void): void {
  load(slot, "intro");
  setNow(bus!.gain, 1);
  setNow(slot.gain.gain, 1);
  slot.el.play().then(() => {
    markStarted();
    if (wanted && current === slot) onPlaying();
  }, onRefused);
}

function metadata(el: HTMLAudioElement): Promise<void> {
  if (el.readyState >= 1) return Promise.resolve();
  return new Promise((ok) =>
    el.addEventListener("loadedmetadata", () => ok(), { once: true }),
  );
}

/** Fade out and pause, keeping the position. */
export function stopMusic(): void {
  wanted = false;
  window.clearTimeout(boundaryTimer);
  boundaryTimer = undefined;
  window.clearInterval(saveTimer);
  saveTimer = undefined;
  save();
  stopGlints(PAUSE_FADE);
  if (!bus || !current || pauseTimer !== undefined) return;
  rampTo(bus.gain, 0, PAUSE_FADE);
  pauseTimer = window.setTimeout(
    () => {
      pauseTimer = undefined;
      haltGlints();
      // Settle any crossfade in progress: keep only the current element.
      for (const slot of slots) {
        slot.el.pause();
        if (slot !== current) setNow(slot.gain.gain, 0);
      }
      if (current) setNow(current.gain.gain, 1);
    },
    PAUSE_FADE * 1000 + 50,
  );
}

/** True while the music is (or is fading) in. */
export function musicPlaying(): boolean {
  return wanted && !!current && !current.el.paused;
}

/** Whether the music has actually started playing on this page. */
export function musicStarted(): boolean {
  return started;
}

const stateListeners: (() => void)[] = [];

/** Call `fn` when the music first starts, or a start is refused. */
export function onMusicState(fn: () => void): void {
  stateListeners.push(fn);
}

function markStarted(): void {
  if (started) return;
  started = true;
  for (const fn of stateListeners) fn();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", save);
}

// The one AudioContext shared by the chimes, the live glints and the music
// player, created on demand (after a user gesture, in practice).
//
//   chimes, glints → master (0.55) → compressor → destination
//   music elements → their own gains → destination   (already mastered)

export interface AudioGraph {
  ctx: AudioContext;
  /** Live voices go here: 0.55 into the compressor, as in the prototype. */
  master: GainNode;
  /** The compressor itself, for sends that bypass the master level. */
  compressor: DynamicsCompressorNode;
}

let graph: AudioGraph | null = null;

export function getAudio(): AudioGraph | null {
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

  graph = { ctx, master, compressor };
  return graph;
}

/** The graph if it already exists; never creates one. */
export function peekAudio(): AudioGraph | null {
  return graph;
}

/** Move `param` from its current value to `to` along a straight line. */
export function rampTo(param: AudioParam, to: number, secs: number): void {
  const ctx = graph?.ctx;
  if (!ctx) return;
  const t = ctx.currentTime;
  // Plain cancel + set: cancelAndHoldAtTime is missing in some browsers.
  const from = param.value;
  param.cancelScheduledValues(t);
  param.setValueAtTime(from, t);
  param.linearRampToValueAtTime(to, t + Math.max(0.01, secs));
}

/** Jump `param` to `value` now, dropping any automation. */
export function setNow(param: AudioParam, value: number): void {
  const ctx = graph?.ctx;
  if (!ctx) return;
  param.cancelScheduledValues(ctx.currentTime);
  param.setValueAtTime(value, ctx.currentTime);
}

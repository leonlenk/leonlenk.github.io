// The site's background music: one pre-rendered piece, "Cavern of Light",
// played continuously on every page. The files in public/audio/ are
// committed assets produced by `pnpm music:render` (see tools/music/).
//
// The bed (drones, pads, strings, air, the cave) is baked into an intro
// (the once-only Void) and a loop (one Descent → Awe → Hover → Return
// cycle). The glints and Hover's dust stay live and random: the cue sheet
// tells src/scripts/glints.ts which movement is sounding and what it needs.

export interface Track {
  id: string;
  /** Played once per tab session, then the loop takes over. */
  intro: { webm: string; m4a: string };
  loop: { webm: string; m4a: string };
  /** JSON cue sheet (`Cue`) written by the render tool. */
  cue: string;
}

export const music: Track = {
  id: "cavern",
  intro: {
    webm: "/audio/cavern-intro.webm",
    m4a: "/audio/cavern-intro.m4a",
  },
  loop: {
    webm: "/audio/cavern-loop.webm",
    m4a: "/audio/cavern-loop.m4a",
  },
  cue: "/audio/cavern.json",
};

/** One movement as the live glint layer sees it. Times in seconds. */
export interface CueMovement {
  name: string;
  /** Start, relative to the start of its file. */
  start: number;
  length: number;
  /** Delay after `start` before the movement's voices enter. */
  entry: number;
  /** The movement's intensity; sets the glint rate. */
  I: number;
  /** Return: glints 1.6× sparser. */
  fadeOut: boolean;
  /** Hover: bursts of faint sparkles. */
  dust: boolean;
  /** Descent: the lit gems drift down the pool as the movement goes on. */
  slide: boolean;
  /** Note names, e.g. "D5". */
  glints: string[];
}

export interface CueSpan {
  start: number;
  end: number;
  movement: string;
  bass: string[];
  chord: string[];
  line?: string;
}

export interface CuePart {
  /** Musical length: where the next part begins. */
  duration: number;
  /** The file runs `overhang` seconds past `duration` for the crossfade. */
  fileDuration: number;
  movements: CueMovement[];
  spans: CueSpan[];
}

export interface Cue {
  version: number;
  track: string;
  settings: Record<string, number>;
  crossfade: number;
  overhang: number;
  intro: CuePart;
  loop: CuePart;
}

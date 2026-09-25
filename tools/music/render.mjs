#!/usr/bin/env node
// Offline render of the site's background music: `pnpm music:render`.
//
// Serves a tiny page to headless Chromium, which renders the piece in an
// OfflineAudioContext (48 kHz stereo) with the same master chain as the live
// prototype, and POSTs back 16-bit WAVs of the intro and the loop. Those are
// encoded with ffmpeg to Opus/WebM (~64 kbps) and AAC/M4A (~96 kbps) in
// public/audio/, next to a JSON cue sheet. Temporary files are deleted.
//
// Options (all optional):
//   --track <name>     output basename (default "cavern")
//   --engine <file>    engine script defining window.Cavern
//                      (default tools/music/cavern-engine.js)
//   --seed <n>         PRNG seed (default 1)
//   --<setting> <v>    override a setting: space light depth swell air pace
//   --out <dir>        output directory (default public/audio)
//
// Requires chromium-browser (or $CHROMIUM) and ffmpeg on PATH.

import { spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");

const SETTINGS = ["space", "light", "depth", "swell", "air", "pace"];
const args = {
  track: "cavern",
  seed: "1",
  out: "public/audio",
  engine: join(here, "cavern-engine.js"),
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  const key = argv[i].replace(/^--/, "");
  if (argv[i + 1] === undefined)
    throw new Error(`missing value for ${argv[i]}`);
  args[key] = argv[i + 1];
}
const settings = Object.fromEntries(
  SETTINGS.filter((k) => args[k] !== undefined).map((k) => [
    k,
    Number(args[k]),
  ]),
);
const seed = Number(args.seed);
const outDir = resolve(root, args.out);
const track = args.track;

// Crossfade the player uses at seams, and how far past each seam the files
// run so the outgoing element has real material to fade over.
const CROSSFADE = 2;
const OVERHANG = 3;
const TAIL = 15;

const tmp = mkdtempSync(join(tmpdir(), "music-render-"));
const began = Date.now();
let chromium;

function cleanup() {
  if (chromium) {
    try {
      process.kill(-chromium.pid);
    } catch {
      /* already gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
}

const page = `<!doctype html><meta charset="utf-8"><title>render</title>
<script src="/engine.js"></script><script src="/render-page.js"></script>`;

function readBody(req) {
  return new Promise((ok, fail) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", fail);
  });
}

const result = await new Promise((done, fail) => {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET") {
        const files = {
          "/": [page, "text/html"],
          "/engine.js": [readFileSync(args.engine), "text/javascript"],
          "/render-page.js": [
            readFileSync(join(here, "render-page.js")),
            "text/javascript",
          ],
          "/config.json": [
            JSON.stringify({ seed, settings, overhang: OVERHANG, tail: TAIL }),
            "application/json",
          ],
        };
        const hit = files[url.pathname];
        if (!hit) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": hit[1] }).end(hit[0]);
        return;
      }
      const body = await readBody(req);
      res.writeHead(204).end();
      if (url.pathname === "/log") console.log(JSON.parse(body).msg);
      else if (url.pathname === "/wav") {
        const name = url.searchParams.get("name");
        writeFileSync(join(tmp, `${name}.wav`), body);
        console.log(
          `received ${name}.wav (${(body.length / 1e6).toFixed(1)} MB)`,
        );
      } else if (url.pathname === "/error")
        fail(new Error(JSON.parse(body).msg));
      else if (url.pathname === "/done") {
        server.close();
        done(JSON.parse(body));
      }
    } catch (err) {
      fail(err);
    }
  });
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    chromium = spawn(
      process.env.CHROMIUM || "chromium-browser",
      [
        "--headless=new",
        `--user-data-dir=${join(tmp, "profile")}`,
        "--no-first-run",
        "--disable-gpu",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        `http://127.0.0.1:${port}/`,
      ],
      { stdio: "ignore", detached: true },
    );
    chromium.on("error", fail);
  });
}).catch((err) => {
  cleanup();
  throw err;
});

try {
  process.kill(-chromium.pid);
} catch {
  /* already gone */
}
chromium = undefined;

/* ---------- encode ---------- */

function ffmpeg(input, output, codecArgs) {
  const run = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      input,
      "-map_metadata",
      "-1",
      "-fflags",
      "+bitexact",
      "-flags:a",
      "+bitexact",
      ...codecArgs,
      output,
    ],
    { stdio: "inherit" },
  );
  if (run.status !== 0) throw new Error(`ffmpeg failed for ${output}`);
}

const hasFdk = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], {
  encoding: "utf8",
}).stdout.includes("libfdk_aac");
const outputs = [];
try {
  for (const part of ["intro", "loop"]) {
    const wav = join(tmp, `${part}.wav`);
    const webm = join(outDir, `${track}-${part}.webm`);
    const m4a = join(outDir, `${track}-${part}.m4a`);
    ffmpeg(wav, webm, [
      "-c:a",
      "libopus",
      "-b:a",
      "64k",
      "-vbr",
      "on",
      "-application",
      "audio",
      "-f",
      "webm",
    ]);
    ffmpeg(wav, m4a, [
      "-c:a",
      hasFdk ? "libfdk_aac" : "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
    ]);
    outputs.push(webm, m4a);
  }
} finally {
  cleanup();
}

/* ---------- cue sheet ---------- */

const RATE = 48000;
const round = (x) => Math.round(x * 1e4) / 1e4;
const { timeline, events, frames, peaks } = result;
const { MOVEMENTS, DEFAULTS } = loadEngine();

/** The movement data the live glint layer needs, relative to `origin`. */
function movement(entry, origin) {
  const m = MOVEMENTS[entry.index];
  const logged = events.find(
    (e) => e.movement && Math.abs(e.t - entry.start) < 1e-6,
  );
  return {
    name: entry.name,
    start: round(entry.start - origin),
    length: round(entry.length),
    // Seconds after the movement starts at which its voices enter.
    entry: round(logged?.at ?? 0),
    I: m.I,
    fadeOut: !!m.fadeOut,
    dust: !!m.dust,
    slide: !!m.slide,
    glints: m.glints,
  };
}

/** Sounding bass / chord / Descent line, as spans over [from, to). */
function spans(from, to) {
  const state = { movement: null, bass: [], chord: [], line: null };
  const changes = [];
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    if (e.t >= to) break;
    if (e.movement) {
      state.movement = e.movement;
      state.line = null;
    }
    if (e.bass) state.bass = e.bass;
    if (e.chord)
      state.chord = [...new Set(e.chord)].sort((a, b) => midi(a) - midi(b));
    if (e.line) state.line = e.line;
    // Everything before `from` collapses into the state carried in.
    const t = round(Math.max(e.t, from) - from);
    const snap = { ...state, ...(state.line ? {} : { line: undefined }) };
    if (changes.at(-1)?.start === t)
      changes[changes.length - 1] = { start: t, ...snap };
    else changes.push({ start: t, ...snap });
  }
  const same = (a, b) =>
    JSON.stringify({ ...a, start: 0 }) === JSON.stringify({ ...b, start: 0 });
  const merged = changes.filter((c, i) => i === 0 || !same(c, changes[i - 1]));
  const list = merged.map((c, i) => ({
    start: c.start,
    end: merged[i + 1]?.start ?? round(to - from),
    movement: c.movement,
    bass: c.bass,
    chord: c.chord,
    line: c.line,
  }));
  return list.filter((s) => s.end > s.start);
}

function midi(n) {
  const NOTE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  return 12 * (+n.slice(1) + 1) + NOTE[n[0]];
}

function loadEngine() {
  // Evaluate the engine against a stub window to read its tables.
  const window = {};
  new Function("window", readFileSync(args.engine, "utf8"))(window);
  return window.Cavern;
}

const dB = (x) => Math.round(20 * Math.log10(Math.max(x, 1e-9)) * 100) / 100;
const introStart = 0;
const loopStart = frames.loop[0] / RATE;
const cue = {
  version: 1,
  track,
  sampleRate: RATE,
  seed,
  settings: { ...DEFAULTS, ...settings },
  crossfade: CROSSFADE,
  overhang: OVERHANG,
  peakDbfs: { intro: dB(peaks.intro), loop: dB(peaks.loop) },
  intro: {
    duration: round((frames.intro[1] - frames.intro[0]) / RATE),
    fileDuration: round(
      (frames.intro[1] - frames.intro[0] + frames.overhang) / RATE,
    ),
    movements: [movement(timeline[0], introStart)],
    spans: spans(introStart, frames.intro[1] / RATE),
  },
  loop: {
    duration: round((frames.loop[1] - frames.loop[0]) / RATE),
    fileDuration: round(
      (frames.loop[1] - frames.loop[0] + frames.overhang) / RATE,
    ),
    movements: timeline.slice(5, 9).map((m) => movement(m, loopStart)),
    spans: spans(loopStart, frames.loop[1] / RATE),
  },
};

const cuePath = join(outDir, `${track}.json`);
writeFileSync(cuePath, JSON.stringify(cue, null, 2) + "\n");
outputs.push(cuePath);

/* ---------- report ---------- */

console.log(
  `\nrender ${result.renderSecs.toFixed(1)} s in Chromium; ${((Date.now() - began) / 1000).toFixed(1)} s total`,
);
console.log(
  `intro ${cue.intro.duration} s, loop ${cue.loop.duration} s (+${OVERHANG} s overhang each)`,
);
console.log(
  `peak: whole render ${dB(peaks.all)} dBFS, intro ${cue.peakDbfs.intro} dBFS, loop ${cue.peakDbfs.loop} dBFS`,
);
if (Math.max(peaks.intro, peaks.loop) > 10 ** (-1 / 20))
  console.warn("WARNING: peak above -1 dBFS. Not normalised; check the mix.");
for (const file of outputs)
  console.log(
    `${(statSync(file).size / 1024).toFixed(0).padStart(7)} KB  ${file.replace(root + "/", "")}`,
  );

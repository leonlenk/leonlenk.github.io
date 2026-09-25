// Browser side of `pnpm music:render`: renders the bed in an
// OfflineAudioContext, cuts the intro and loop, encodes them as 16-bit WAV
// and POSTs them (plus a JSON report) back to the local server.
/* global Cavern */

const RATE = 48000;
// Audio is scheduled this far ahead of each suspend point; must be at least
// CHUNK so that no event is processed after its time has been rendered.
const CHUNK = 5;
const LOOKAHEAD = 6;

async function post(path, body, type = "application/json") {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": type },
    body: type === "application/json" ? JSON.stringify(body) : body,
  });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
}

const log = (msg) => post("/log", { msg }).catch(() => {});

// The last part of each file's overhang fades out, so its cut-off end can
// never be heard even if a crossfade starts late.
const END_FADE = 0.75;

/** 16-bit PCM WAV of frames [from, to) of a stereo AudioBuffer. */
function wav(buffer, from, to) {
  const frames = to - from;
  const out = new DataView(new ArrayBuffer(44 + frames * 4));
  const str = (o, s) =>
    [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  out.setUint32(4, 36 + frames * 4, true);
  str(8, "WAVEfmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 2, true);
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 4, true);
  out.setUint16(32, 4, true);
  out.setUint16(34, 16, true);
  str(36, "data");
  out.setUint32(40, frames * 4, true);
  const l = buffer.getChannelData(0);
  const r = buffer.getChannelData(1);
  const fadeFrom = to - Math.round(END_FADE * RATE);
  let o = 44;
  for (let i = from; i < to; i++) {
    const fade =
      i < fadeFrom
        ? 1
        : 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeFrom)) / (to - fadeFrom));
    for (const s of [l[i] * fade, r[i] * fade]) {
      const v = Math.max(-1, Math.min(1, s));
      out.setInt16(o, Math.round(v < 0 ? v * 32768 : v * 32767), true);
      o += 2;
    }
  }
  return out.buffer;
}

function peak(buffer, from, to) {
  let p = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let i = from; i < to; i++) {
      const a = Math.abs(d[i]);
      if (a > p) p = a;
    }
  }
  return p;
}

async function main() {
  const cfg = await (await fetch("/config.json")).json();
  const { seed, settings, overhang, tail } = cfg;
  // Void, two cycles, and the third Descent as the tail's spill-over.
  const timeline = Cavern.plan({ seed, settings, count: 10 });
  const descent1 = timeline[1].start;
  const descent2 = timeline[5].start;
  const cycleEnd = timeline[9].start; // = end of the second Return
  const total = cycleEnd + Math.max(tail, overhang + 1);
  const length = Math.ceil(total * RATE);
  await log(
    `timeline ${timeline.map((m) => `${m.name}@${m.start.toFixed(2)}`).join(" ")}; rendering ${total.toFixed(1)} s`,
  );

  const ctx = new OfflineAudioContext({
    numberOfChannels: 2,
    length,
    sampleRate: RATE,
  });
  // The live page's master chain: master (0 → 0.55 over 3 s, as begin()
  // does) → compressor → destination.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 12;
  comp.ratio.value = 3;
  comp.attack.value = 0.01;
  comp.release.value = 0.4;
  comp.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = 0;
  master.connect(comp);
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.55, 3);

  const events = [];
  const engine = Cavern.create(ctx, master, {
    seed,
    settings,
    timeline,
    glints: false,
    log: (e) => events.push(e),
  });
  engine.advance(LOOKAHEAD);
  for (let t = CHUNK; t < total; t += CHUNK) {
    ctx.suspend(t).then(() => {
      engine.advance(t + LOOKAHEAD);
      if (t % 60 === 0) void log(`  ${t} s scheduled`);
      ctx.resume();
    });
  }
  const began = performance.now();
  const buffer = await ctx.startRendering();
  const renderSecs = (performance.now() - began) / 1000;
  await log(`rendered in ${renderSecs.toFixed(1)} s`);

  const frame = (t) => Math.round(t * RATE);
  const intro = [0, frame(descent1)];
  const loop = [frame(descent2), frame(cycleEnd)];
  const over = frame(overhang);
  const peaks = {
    all: peak(buffer, 0, buffer.length),
    intro: peak(buffer, intro[0], intro[1] + over),
    loop: peak(buffer, loop[0], loop[1] + over),
  };

  await post(
    "/wav?name=intro",
    wav(buffer, intro[0], intro[1] + over),
    "audio/wav",
  );
  await post(
    "/wav?name=loop",
    wav(buffer, loop[0], loop[1] + over),
    "audio/wav",
  );
  await post("/done", {
    renderSecs,
    total,
    timeline,
    events,
    frames: { intro, loop, overhang: over },
    peaks,
  });
}

main().catch((err) => post("/error", { msg: String(err?.stack || err) }));

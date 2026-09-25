import assert from "node:assert/strict";
import { test } from "node:test";
import { cueSheet, soundScene } from "./audio-harness.mjs";

const INTRO = cueSheet.intro.duration;
const LOOP = cueSheet.loop.duration;

async function started(opts) {
  const app = soundScene(opts);
  app.gesture("pointerdown");
  await app.settle();
  return app;
}

function curves(param) {
  return param.calls.filter((c) => c[0] === "curve");
}

function timersPending(app) {
  return app.clock.timers.size;
}

test("nothing loads before the first gesture", async () => {
  const app = soundScene();
  await app.settle();
  app.clock.advance(60_000);
  assert.equal(app.elements.length, 0);
  assert.equal(app.fetches.length, 0);
  app.audio.unlockAudio(); // e.g. Chrome's page-load call
  assert.equal(app.elements.length, 0);
  // The first gesture: play() is called synchronously, inside the event.
  app.gesture("pointerdown");
  const intro = app.elements.find((el) => el.src.includes("intro"));
  assert.ok(intro, "intro element");
  assert.equal(intro.plays, 1);
  assert.match(intro.src, /cavern-intro\.webm$/);
  assert.ok(app.elements.every((el) => el.preload !== "auto"));
});

test("falls back to m4a without WebM Opus", async () => {
  const app = await started({ webm: false });
  assert.match(app.elements[0].src, /cavern-intro\.m4a$/);
  assert.match(app.elements[1].src, /cavern-loop\.m4a$/);
});

test("the intro hands over to the loop with an equal-power crossfade", async () => {
  const app = await started();
  const [intro, spare] = app.elements.slice(-2);
  assert.match(intro.src, /intro/);
  assert.match(spare.src, /loop/);
  assert.equal(spare.paused, true); // blessed inside the gesture, then parked
  // One timer for the seam, armed from currentTime (plus the save interval).
  const seam = [...app.clock.timers.values()].filter((t) => !t.every);
  assert.equal(seam.length > 0, true);
  const boundary = seam.find(
    (t) => Math.abs(t.delay - (INTRO * 1000 - 20)) < 1,
  );
  assert.ok(boundary, "boundary timer at the intro's musical end");

  intro.currentTime = INTRO - 0.01;
  app.clock.advance(INTRO * 1000);
  await app.settle();
  assert.equal(spare.paused, false);
  assert.equal(spare.currentTime, 0);
  assert.equal(intro.paused, false); // still playing its overhang
  // Both gains got complementary curves: sin² + cos² = 1 throughout.
  const gains = app.gains();
  const [down] = curves(gains[0].gain);
  const [up] = curves(gains[1].gain);
  assert.ok(down && up);
  assert.equal(down[3], cueSheet.crossfade);
  for (let i = 0; i < up[1].length; i++)
    assert.ok(Math.abs(up[1][i] ** 2 + down[1][i] ** 2 - 1) < 1e-6);
  assert.ok(up[1][0] === 0 && down[1].at(-1) < 1e-6);
});

test("the loop ping-pongs between the two elements", async () => {
  const app = await started();
  const [a, b] = app.elements.slice(-2);
  a.currentTime = INTRO;
  app.clock.advance(INTRO * 1000);
  await app.settle();
  a.dispatchEvent(new Event("ended"));
  assert.match(a.src, /loop/); // parked on the loop for the next seam
  assert.equal(a.currentTime, 0);
  // Next seam at the loop's musical end, on b's clock.
  b.currentTime = LOOP - 0.01;
  app.clock.advance(LOOP * 1000);
  await app.settle();
  assert.equal(a.paused, false);
  assert.equal(a.currentTime, 0);
  assert.equal(a.plays >= 2, true);
});

test("navigation never restarts or ducks the music", async () => {
  const app = await started();
  const intro = app.elements.find((el) => /intro/.test(el.src));
  intro.currentTime = 7;
  const bus = app.bus();
  const busCalls = bus.gain.calls.length;
  const src = intro.src;
  // Astro page loads call unlockAudio(); gestures keep arriving too.
  for (let i = 0; i < 5; i++) {
    app.events.dispatchEvent(new Event("astro:page-load"));
    app.audio.unlockAudio();
    app.gesture("click");
  }
  await app.settle();
  assert.equal(intro.src, src);
  assert.equal(intro.currentTime, 7);
  assert.equal(bus.gain.calls.length, busCalls);
  assert.equal(app.elements.length, 2);
});

test("mode toggles fade out, pause with no timers left, and resume in place", async () => {
  const app = await started();
  const intro = app.elements.find((el) => /intro/.test(el.src));
  intro.currentTime = 12;
  app.audio.setSoundMode("chimes");
  const bus = app.bus();
  assert.deepEqual(bus.gain.calls.at(-1).slice(0, 2), ["ramp", 0]);
  app.clock.advance(1500);
  assert.equal(intro.paused, true);
  assert.equal(timersPending(app), 0);
  app.audio.setSoundMode("muted");
  app.clock.advance(5000);
  assert.equal(timersPending(app), 0);
  app.audio.setSoundMode("ambient");
  await app.settle();
  assert.equal(intro.paused, false);
  assert.equal(intro.currentTime, 12);
  assert.deepEqual(bus.gain.calls.at(-1).slice(0, 2), ["ramp", 1]);
});

test("a hidden tab fades and pauses; showing it resumes", async () => {
  const app = await started();
  const intro = app.elements.find((el) => /intro/.test(el.src));
  intro.currentTime = 3;
  app.document.hidden = true;
  app.events.dispatchEvent(new Event("visibilitychange"));
  app.clock.advance(3000);
  assert.equal(intro.paused, true);
  assert.equal(app.ctx.state, "suspended");
  assert.equal(timersPending(app), 0);
  const saved = JSON.parse(app.sessionStore.get("shards:music"));
  assert.deepEqual([saved.part, saved.time], ["intro", 3]);
  app.document.hidden = false;
  app.events.dispatchEvent(new Event("visibilitychange"));
  await app.settle();
  assert.equal(intro.paused, false);
  assert.equal(intro.currentTime, 3);
});

test("a reload skips the intro and fades the loop in where it would be", async () => {
  const at = 1_000_000 - 5000; // saved 5 s before the scene's clock
  const app = soundScene({
    session: {
      "shards:music": JSON.stringify({ part: "loop", time: LOOP - 2, at }),
    },
  });
  app.gesture("click");
  const loop = app.elements[0];
  assert.match(loop.src, /cavern-loop/);
  assert.ok(app.elements.every((el) => !/intro/.test(el.src)));
  loop.readyState = 1;
  loop.dispatchEvent(new Event("loadedmetadata"));
  await app.settle();
  assert.ok(Math.abs(loop.currentTime - 3) < 1e-6); // (L − 2 + 5) mod L
  loop.dispatchEvent(new Event("seeked"));
  const bus = app.bus();
  const last = bus.gain.calls.at(-1);
  assert.deepEqual(last.slice(0, 2), ["ramp", 1]);
  assert.ok(Math.abs(last[2] - app.ctx.currentTime - 3) < 1e-6);
});

test("glints run only while music plays and put the cave to sleep", async () => {
  const app = await started();
  const intro = app.elements.find((el) => /intro/.test(el.src));
  intro.currentTime = 1;
  // Void: the first glint comes 4–9 s in.
  app.clock.advance(9000);
  assert.ok(app.oscillators.length >= 5, "a glint struck");
  const cave = app.convolvers[0];
  assert.ok(cave, "cave built on the first glint");
  assert.equal(cave.buffer.getChannelData(0).length, 5 * app.ctx.sampleRate);
  const caveOut = [...cave.outputs][0];
  assert.equal(caveOut.outputs.size, 1); // awake
  app.audio.setSoundMode("chimes");
  app.clock.advance(1500);
  assert.equal(caveOut.outputs.size, 0); // asleep once paused
  assert.equal(timersPending(app), 0);
});

test("glints use five glass partials, three on phones", async () => {
  for (const [coarse, partials] of [
    [false, 5],
    [true, 3],
  ]) {
    // random() = 0.99: no answering glint, no resonance, first glint at 8.95 s.
    const app = await started({ coarse, random: () => 0.99 });
    const intro = app.elements[0];
    intro.currentTime = 0;
    const before = app.oscillators.length;
    app.clock.advance(9000);
    assert.equal(app.oscillators.length - before, partials);
  }
});

test("Hover gets dust bursts; Void does not", async () => {
  // random() = 0.5: glints every ~12 s, no answers or resonances, and a
  // dust burst is 8 two-partial ticks.
  const app = await started({ random: () => 0.5 });
  const [a, b] = app.elements;
  a.currentTime = 0;
  let before = app.oscillators.length;
  app.clock.advance(13_000);
  const voidCount = app.oscillators.length - before;
  assert.equal(voidCount, 5); // one glint, no dust
  // Hand over to the loop, then put the music in the middle of Hover.
  a.currentTime = INTRO;
  app.clock.advance(INTRO * 1000);
  await app.settle();
  const hover = cueSheet.loop.movements.find((m) => m.dust);
  b.currentTime = hover.start + hover.entry + 20;
  // Pausing and resuming makes the layer re-read where the music is.
  app.audio.setSoundMode("chimes");
  app.clock.advance(1500);
  app.audio.setSoundMode("ambient");
  await app.settle();
  before = app.oscillators.length;
  app.clock.advance(13_000);
  assert.ok(app.oscillators.length - before >= 16);
});

test("a returning visitor's music starts on load when autoplay is allowed", async () => {
  const app = soundScene({
    stored: { "shards:sound": "ambient" },
    state: "suspended",
  });
  await app.settle();
  assert.equal(app.ctx.state, "running");
  const intro = app.elements[0];
  assert.match(intro.src, /cavern-intro/);
  assert.equal(intro.paused, false);
  // A same-tab reload also resumes the loop, fading in over 3 s.
  const at = 1_000_000 - 1000;
  const reload = soundScene({
    stored: { "shards:sound": "ambient" },
    session: {
      "shards:music": JSON.stringify({ part: "loop", time: 50, at }),
    },
  });
  await reload.settle();
  const loop = reload.elements[0];
  assert.match(loop.src, /cavern-loop/);
  loop.readyState = 1;
  loop.dispatchEvent(new Event("loadedmetadata"));
  await reload.settle();
  assert.ok(Math.abs(loop.currentTime - 51) < 1e-6);
  loop.dispatchEvent(new Event("seeked"));
  assert.deepEqual(reload.bus().gain.calls.at(-1).slice(0, 2), ["ramp", 1]);
});

test("refused autoplay waits quietly for the first gesture", async () => {
  const app = soundScene({
    stored: { "shards:sound": "ambient" },
    state: "suspended",
    autoplay: "media",
  });
  await app.settle();
  app.clock.advance(2000);
  const [first] = app.elements;
  assert.ok(first.plays >= 1); // tried
  assert.ok(app.elements.every((el) => el.paused));
  app.gesture("touchstart");
  await app.settle();
  assert.equal(first.paused, false);
  assert.match(first.src, /cavern-intro/);
  // Started: further gestures are no longer listened for.
  const plays = first.plays;
  app.gesture("pointerdown");
  app.gesture("keydown");
  assert.equal(first.plays, plays);
});

test("a context that stays suspended plays nothing until the gesture", async () => {
  const app = soundScene({
    stored: { "shards:sound": "ambient" },
    state: "suspended",
    autoplay: "blocked",
  });
  await app.settle();
  app.clock.advance(5000);
  await app.settle();
  // No element may run silently ahead of a suspended graph.
  assert.ok(app.elements.every((el) => el.plays === 0));
  app.gesture("keydown");
  await app.settle();
  assert.equal(app.ctx.state, "running");
  assert.ok(app.elements.some((el) => !el.paused));
});

test("no autoplay for chimes-only, off, or a first visit", async () => {
  for (const stored of [
    { "shards:sound": "chimes" },
    { "shards:sound": "muted" },
    {},
  ]) {
    const app = soundScene({ stored, state: "suspended" });
    await app.settle();
    app.clock.advance(5000);
    assert.equal(app.elements.length, 0, JSON.stringify(stored));
  }
});

test("the first gesture remembers ambient, so the next visit may autoplay", async () => {
  const app = soundScene();
  app.gesture("click");
  assert.equal(app.storage.get("shards:sound"), "ambient");
});

test("hidden mid-crossfade: both elements pause, glints stop, context suspends", async () => {
  // random() = 0.5: the first glint strikes 6.5 s in, and keeps ringing.
  const app = await started({ random: () => 0.5 });
  const [intro, loop] = app.elements;
  app.clock.advance(7000);
  const glintOscillators = app.oscillators.slice();
  assert.ok(glintOscillators.length >= 5);
  // Reach the seam: the loop starts and the crossfade is under way.
  intro.currentTime = INTRO - 0.01;
  app.clock.advance(INTRO * 1000 - 7000);
  await app.settle();
  assert.equal(loop.paused, false);
  assert.equal(intro.paused, false);
  loop.currentTime = 0.8;
  app.document.hidden = true;
  app.events.dispatchEvent(new Event("visibilitychange"));
  app.clock.advance(1500);
  await app.settle();
  assert.ok(
    app.elements.every((el) => el.paused),
    "both elements paused",
  );
  assert.equal(app.ctx.state, "suspended");
  assert.equal(timersPending(app), 0);
  // Every glint voice was stopped outright, and the cave is gone.
  const now = app.ctx.currentTime;
  assert.ok(glintOscillators.every((o) => o.stops.some((t) => t <= now)));
  const cave = app.convolvers.at(-1);
  assert.equal(cave.outputs.size, 0);
  // Only the incoming element resumes, where it was; the other stays silent.
  app.document.hidden = false;
  app.events.dispatchEvent(new Event("visibilitychange"));
  await app.settle();
  assert.equal(loop.paused, false);
  assert.equal(loop.currentTime, 0.8);
  assert.equal(intro.paused, true);
  const [introGain, loopGain] = app.gains();
  assert.equal(introGain.gain.value, 0);
  assert.equal(loopGain.gain.value, 1);
});

test("a reload whose seek cannot land plays the intro, not the loop's head", async () => {
  const app = soundScene({
    session: {
      "shards:music": JSON.stringify({
        part: "loop",
        time: 100,
        at: 1_000_000,
      }),
    },
  });
  app.gesture("click");
  const first = app.elements[0];
  first.readyState = 1;
  first.dispatchEvent(new Event("loadedmetadata"));
  await app.settle();
  // A server without range requests: the seek snaps back to the start.
  first.currentTime = 0;
  first.dispatchEvent(new Event("seeked"));
  assert.match(first.src, /cavern-intro/);
  assert.equal(first.paused, false);
});

import { writeFileSync } from "node:fs";
// Build and serve the site, then run against an isolated Chromium instance:
// chromium --headless --remote-debugging-port=9444 --user-data-dir=/tmp/site-perf about:blank
// node scripts/check-loading.mjs [site URL] [DevTools URL]
import assert from "node:assert/strict";

const site = process.argv[2] ?? "http://127.0.0.1:4390";
const devtools = process.argv[3] ?? "http://127.0.0.1:9444";
// Create a dedicated tab; never navigate an existing user's tab.
const target = await (
  await fetch(`${devtools}/json/new?about:blank`, { method: "PUT" })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => {
  ws.onopen = resolve;
});
let sequence = 0;
const calls = new Map();
const errors = [];
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data);
  if (message.method === "Runtime.exceptionThrown")
    errors.push(message.params.exceptionDetails);
  if (!message.id) return;
  const pending = calls.get(message.id);
  calls.delete(message.id);
  if (message.error) pending.reject(message.error);
  else pending.resolve(message.result);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    calls.set(++sequence, { resolve, reject });
    ws.send(JSON.stringify({ id: sequence, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result?.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(expression) {
  const end = Date.now() + 15000;
  do {
    if (await evaluate(expression)) return;
    await wait(50);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${expression}`);
}

// Optional screenshots go to /tmp; network stalls are real intercepted requests.
const paused = [];
ws.addEventListener("message", ({ data }) => {
  const event = JSON.parse(data);
  if (event.method === "Fetch.requestPaused")
    paused.push(event.params.requestId);
});
const screenshot = async (name) =>
  writeFileSync(
    `/tmp/loading-${name}.png`,
    Buffer.from((await send("Page.captureScreenshot")).data, "base64"),
  );
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send("Network.setBlockedURLs", {
    urls: ["*.js", "*goatcounter*", "*gc.zgo.at*"],
  });
  await send("Page.navigate", { url: site });
  await wait(700);
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.startup-loading')).opacity`,
    ),
    "1",
  );
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.field')).visibility`,
    ),
    "hidden",
  );
  await screenshot("seed");
  await wait(3700);
  assert.equal(
    await evaluate(
      `document.documentElement.hasAttribute('data-field-pending')`,
    ),
    false,
  );
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('a.shard')).visibility`,
    ),
    "visible",
  );
  console.log("PASS delayed seed and failed-module fallback");
  await send("Network.setBlockedURLs", {
    urls: ["*goatcounter*", "*gc.zgo.at*"],
  });
  await send("Page.navigate", { url: site });
  await until(
    `document.querySelector('.field')?.dataset.state==='settled' && !document.querySelector('.field').hasAttribute('data-intro-animation')`,
  );
  await send("Fetch.enable", { patterns: [{ urlPattern: site + "/self/" }] });
  await evaluate(`document.querySelector('a.shard[href="/self/"]').click()`);
  await wait(800);
  assert.equal(
    await evaluate(`document.querySelector('.navigation-loading').hidden`),
    false,
  );
  await screenshot("seam");
  await wait(9700);
  assert.equal(
    await evaluate(`document.querySelector('.navigation-loading a').hidden`),
    false,
  );
  assert.equal(
    await evaluate(
      `document.querySelector('.navigation-loading').hasAttribute('data-stalled')`,
    ),
    true,
  );
  assert.ok(paused.length, "destination request intercepted");
  for (const requestId of paused)
    await send("Fetch.continueRequest", { requestId });
  await send("Fetch.disable");
  await until(`location.pathname==='/self/'`);
  assert.equal(
    await evaluate(`document.querySelector('.navigation-loading').hidden`),
    true,
  );
  console.log(
    "PASS slow navigation, bounded animation, recovery link and cleanup",
  );
  await send("Page.navigate", { url: site + "/art/learning_how_to_draw/" });
  await until(`!!document.querySelector('.video-loading')`);
  assert.equal(
    await evaluate(
      `performance.getEntriesByType('resource').some(r=>r.name.endsWith('.mp4'))`,
    ),
    false,
  );
  // Simulate media lifecycle states deterministically, without depending on
  // codecs or downloading the video during this UI regression test.
  await evaluate(
    `window.testVideo=document.querySelector('video');Object.defineProperty(testVideo,'paused',{configurable:true,value:false});testVideo.dispatchEvent(new Event('waiting'));testVideo.dispatchEvent(new Event('playing'))`,
  );
  await wait(400);
  assert.equal(
    await evaluate(`document.querySelector('.video-loading').hidden`),
    true,
  );
  await evaluate(`testVideo.dispatchEvent(new Event('waiting'))`);
  await wait(400);
  assert.equal(
    await evaluate(`document.querySelector('.video-loading').hidden`),
    false,
  );
  await evaluate(`testVideo.scrollIntoView({block:'center'})`);
  await screenshot("video");
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  assert.equal(
    await evaluate(
      `getComputedStyle(document.querySelector('.video-loading-stroke')).animationName`,
    ),
    "none",
  );
  await wait(11800);
  assert.equal(
    await evaluate(
      `document.querySelector('.video-loading').hasAttribute('data-stalled')`,
    ),
    true,
  );
  assert.equal(
    await evaluate(`document.querySelector('.video-loading a').hidden`),
    false,
  );
  await evaluate(`testVideo.dispatchEvent(new Event('waiting'))`);
  await wait(400);
  assert.equal(
    await evaluate(
      `document.querySelector('.video-loading').hasAttribute('data-stalled')`,
    ),
    true,
  );
  await evaluate(`testVideo.dispatchEvent(new Event('playing'))`);
  assert.equal(
    await evaluate(`document.querySelector('.video-loading').hidden`),
    true,
  );
  await evaluate(
    `testVideo.querySelector('source').dispatchEvent(new Event('error'))`,
  );
  assert.equal(
    await evaluate(`document.querySelector('.video-loading p').textContent`),
    "The video couldn’t load.",
  );
  await evaluate(
    `delete testVideo.paused;document.dispatchEvent(new Event('astro:page-load'))`,
  );
  assert.equal(
    await evaluate(`document.querySelectorAll('.video-loading-host').length`),
    1,
  );
  console.log(
    "PASS video delay, recovery, error, reduced motion and idempotent remount",
  );
  await send("Emulation.setScriptExecutionDisabled", { value: true });
  await send("Page.navigate", { url: site });
  await wait(700);
  // Query computed styles via CDP while page scripting is disabled.
  await send("DOM.enable");
  await send("CSS.enable");
  const { root } = await send("DOM.getDocument");
  const { nodeId } = await send("DOM.querySelector", {
    nodeId: root.nodeId,
    selector: ".startup-loading",
  });
  const { computedStyle } = await send("CSS.getComputedStyleForNode", {
    nodeId,
  });
  assert.equal(computedStyle.find((s) => s.name === "display").value, "none");
  assert.deepEqual(errors, []);
  console.log("PASS no-JS fallback and no browser exceptions");
} finally {
  ws.close();
  await fetch(`${devtools}/json/close/${target.id}`);
}

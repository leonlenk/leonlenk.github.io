// Build and serve the site, then run against an isolated Chromium instance:
// chromium --headless --remote-debugging-port=9441 --user-data-dir=/tmp/site-perf about:blank
// node scripts/check-navigation.mjs [site URL] [DevTools URL]
import assert from "node:assert/strict";

const site = process.argv[2] ?? "http://127.0.0.1:4387";
const devtools = process.argv[3] ?? "http://127.0.0.1:9441";
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
const homeReady = `location.pathname === '/' && document.querySelector('.field')?.dataset.state === 'settled' && !document.documentElement.hasAttribute('data-field-pending') && !document.querySelector('.field').hasAttribute('data-intro-animation')`;
async function click(selector, path) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await until(`location.pathname === ${JSON.stringify(path)}`);
  await wait(350);
}
async function digest() {
  return evaluate(`(async () => {
    const c = document.querySelector('.field-canvas');
    const bytes = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
  })()`);
}
async function roundTrip(cacheExpected) {
  const before = await digest();
  await click('a.shard[href="/self/"]', "/self/");
  await evaluate("performance.clearMarks()");
  await click(".wordmark", "/");
  await until(homeReady);
  assert.equal(
    await digest(),
    before,
    "return must preserve every static canvas pixel",
  );
  assert.equal(
    await evaluate(
      `performance.getEntriesByName('shardfield:layers-cached').length > 0`,
    ),
    cacheExpected,
  );
}
try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setBlockedURLs", {
    urls: ["*goatcounter*", "*gc.zgo.at*"],
  });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1.5,
    mobile: false,
  });
  await send("Page.navigate", { url: site });
  await until(homeReady);
  await roundTrip(true);
  console.log("PASS desktop cached return: pixel-identical");

  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 180,
    downloadThroughput: 1250000,
    uploadThroughput: 625000,
  });
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await evaluate(`window.navigationTiming = { click: performance.now() };
    document.addEventListener('astro:before-preparation', () => navigationTiming.prepare = performance.now(), {once:true});
    document.addEventListener('astro:before-swap', () => navigationTiming.swap = performance.now(), {once:true});`);
  await click('a.shard[href="/self/"]', "/self/");
  const timing = await evaluate("navigationTiming");
  assert.ok(
    timing.swap - timing.prepare >= 300,
    "preparation overlaps the animation",
  );
  assert.ok(timing.swap - timing.click >= 390, "swap waits for the expansion");
  console.log("PASS uncached navigation at 180 ms network latency", {
    preparationMs: Math.round(timing.prepare - timing.click),
    swapMs: Math.round(timing.swap - timing.click),
  });
  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await send("Network.setCacheDisabled", { cacheDisabled: false });
  await click(".wordmark", "/");
  await until(homeReady);

  await click('a.shard[href="/art/"]', "/art/");
  await click("a.card", "/art/learning_how_to_draw/");
  await evaluate("history.back()");
  await until("location.pathname === '/art/'");
  await wait(400);
  await evaluate("history.back()");
  await until(homeReady);
  console.log("PASS article navigation and browser Back");

  // Resize away from home: old-sized buffers must never be reused.
  await click('a.shard[href="/self/"]', "/self/");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await wait(250);
  await evaluate("performance.clearMarks()");
  await click(".wordmark", "/");
  await until(homeReady);
  assert.equal(
    await evaluate(
      "performance.getEntriesByName('shardfield:layers-cached').length",
    ),
    0,
  );
  assert.equal(
    await evaluate("document.querySelector('.field-canvas').width"),
    585,
  );
  assert.equal(
    await evaluate("document.documentElement.scrollWidth > innerWidth"),
    false,
  );
  await roundTrip(true);
  console.log("PASS resize invalidation and mobile cached return");

  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await send("Page.reload");
  await until(homeReady);
  await roundTrip(true);
  console.log("PASS reduced motion");

  await send("Emulation.setDeviceMetricsOverride", {
    width: 2560,
    height: 1440,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await wait(700);
  await until(homeReady);
  await roundTrip(false);
  console.log(
    "PASS oversized scene exceeds retention budget and rebuilds correctly",
  );
  assert.deepEqual(errors, [], "no browser exceptions");
} finally {
  ws.close();
  await fetch(`${devtools}/json/close/${target.id}`);
}

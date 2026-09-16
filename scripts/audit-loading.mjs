// Build and serve the site, then run against an isolated Chromium instance:
// chromium --headless --remote-debugging-port=9443 --user-data-dir=/tmp/site-perf about:blank
// node scripts/audit-loading.mjs [site URL] [DevTools URL]
import assert from "node:assert/strict";

const site = process.argv[2] ?? "http://127.0.0.1:4390";
const devtools = process.argv[3] ?? "http://127.0.0.1:9443";
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

try {
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Network.enable");
  await send("Network.setBlockedURLs", {
    urls: ["*goatcounter*", "*gc.zgo.at*"],
  });
  await send("Network.setCacheDisabled", { cacheDisabled: true });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 150,
    downloadThroughput: 200000,
    uploadThroughput: 93750,
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
    sessionStorage.clear();
    window.audit = {lcp:0, cls:0, longTasks:[], settled:0};
    let sessionStart=0, lastShift=0, sessionValue=0;
    new PerformanceObserver(l => l.getEntries().forEach(e => {audit.lcp=e.startTime; audit.lcpElement=e.element?.className})).observe({type:'largest-contentful-paint',buffered:true});
    new PerformanceObserver(l => l.getEntries().forEach(e => {
      if(e.hadRecentInput)return;
      if(e.startTime-lastShift>1000 || e.startTime-sessionStart>5000){sessionStart=e.startTime;sessionValue=0;}
      sessionValue+=e.value;lastShift=e.startTime;audit.cls=Math.max(audit.cls,sessionValue);
    })).observe({type:'layout-shift',buffered:true});
    new PerformanceObserver(l => l.getEntries().forEach(e => audit.longTasks.push({start:e.startTime,duration:e.duration}))).observe({type:'longtask',buffered:true});
    const timer=setInterval(()=>{const f=document.querySelector('.field');if(f?.dataset.state==='settled' && !f.hasAttribute('data-intro-animation')){audit.settled=performance.now();clearInterval(timer)}},50);
  `,
  });
  for (const path of ["/", "/art/", "/art/learning_how_to_draw/"]) {
    for (let run = 1; run <= 3; run++) {
      await send("Page.navigate", { url: site + path });
      await wait(8500);
      const result = await evaluate(
        `({...audit, fcp:performance.getEntriesByName('first-contentful-paint')[0]?.startTime, bytes:performance.getEntriesByType('resource').reduce((n,r)=>n+r.transferSize,0), resources:performance.getEntriesByType('resource').map(r=>({url:r.name,bytes:r.transferSize})), marks:performance.getEntriesByType('mark').map(m=>({name:m.name,time:m.startTime}))})`,
      );
      console.log(JSON.stringify({ path, run, ...result }));
    }
  }
  assert.deepEqual(errors, [], "no browser exceptions");
} finally {
  ws.close();
  await fetch(`${devtools}/json/close/${target.id}`);
}

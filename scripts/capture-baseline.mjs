import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

// Attach to an explicitly started, local disposable Chromium instance.
const origin = "http://127.0.0.1:9333";
const [page] = await (await fetch(`${origin}/json`)).json();
assert(page?.webSocketDebuggerUrl, "Start Chromium with --remote-debugging-port=9333");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener("open", resolve, { once: true }));
let sequence = 0;
const pending = new Map();
const errors = [];
socket.addEventListener("message", ({ data }) => {
  const message = JSON.parse(data);
  if (message.id) {
    const request = pending.get(message.id);
    if (request) {
      clearTimeout(request.timeout);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  }
  if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails);
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 10000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
const directory = "dist/baseline-evidence";
await mkdir(directory, { recursive: true });
try {
  await send("Runtime.enable");
  await send("Page.enable");
  const results = [];
  for (const [scenario, ticks] of [
    ["enemy-ledge", 30],
    ["thin-obstacle", 1],
    ["jump-fire", 12],
  ]) {
    await send("Page.navigate", { url: `http://127.0.0.1:8787/lab.html?scenario=${scenario}` });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      ready = await evaluate(
        'Boolean(document.querySelector("canvas") && document.querySelector("pre")?.textContent)',
      );
      if (ready) break;
      await delay(100);
    }
    assert(ready, "Lab did not load");
    await delay(1500);
    const state = await evaluate(
      `for(let i=0;i<${ticks};i++) document.querySelector('#step').click(); JSON.parse(document.querySelector('pre').textContent)`,
    );
    assert.equal(state.tick, ticks);
    if (scenario === "enemy-ledge") {
      assert(state.enemies[0].x > 200);
      assert.equal(state.enemies[0].y, 200);
    } else if (scenario === "thin-obstacle") {
      assert(state.projectiles[0].x > 115);
      assert.equal(state.objects[0].hp, 30);
    } else {
      assert(state.player.y < 328);
      assert(state.player.weapon.ammo < 30);
    }
    await delay(200);
    const screenshot = await send("Page.captureScreenshot", { format: "png" });
    const bytes = Buffer.from(screenshot.data, "base64");
    await writeFile(`${directory}/${scenario}.png`, bytes);
    results.push({
      scenario,
      ticks,
      state,
      screenshotSha256: createHash("sha256").update(bytes).digest("hex"),
    });
    await evaluate('document.querySelector("#reset").click()');
    assert.equal(await evaluate('JSON.parse(document.querySelector("pre").textContent).tick'), 0);
  }
  assert.deepEqual(errors, []);
  const browser = await (await fetch(`${origin}/json/version`)).json();
  delete browser.webSocketDebuggerUrl;
  await writeFile(
    `${directory}/report.json`,
    `${JSON.stringify({ schemaVersion: 1, package: "W00", recordedAt: new Date().toISOString(), commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), worktree: execFileSync("git", ["status", "--short"], { encoding: "utf8" }), runtime: process.version, browser, errors, results }, null, 2)}\n`,
  );
  console.log(`Captured and verified three local browser scenarios: ${directory}`);
} finally {
  socket.close();
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve("dist/client");
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error("Outside fixture root");
    response.setHeader("Content-Type", extname(path) === ".html" ? "text/html" : "text/javascript");
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
let browser;
const directory = "dist/controller-lab-evidence";
try {
  browser = await chromium.launch({
    executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/controller-lab.html`);
  await page.locator("canvas").waitFor();
  await page.waitForFunction(() => document.querySelector("#state").textContent.length > 0);
  const read = () => page.locator("#state").evaluate((el) => JSON.parse(el.textContent));
  const surface = page.locator("#game");
  await surface.focus();
  const initial = await read();
  await page.keyboard.down("ArrowRight");
  await page.keyboard.press("Enter");
  await page.keyboard.up("ArrowRight");
  assert.equal((await read()).actor.body.x, initial.actor.body.x + 768);
  await page.keyboard.press("Space"); // Released entirely between simulation samples.
  await page.keyboard.press("Enter");
  assert.equal((await read()).actor.body.y, initial.actor.body.y - 1375);
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  const jumpState = await read();
  await mkdir(directory, { recursive: true });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const screenshot = await page.screenshot({ path: `${directory}/course-jump.png` });
  const downloadPromise = page.waitForEvent("download");
  await page.locator("#export").click();
  const download = await downloadPromise;
  await download.saveAs(`${directory}/recording.json`);
  const recording = JSON.parse(await readFile(`${directory}/recording.json`, "utf8"));
  assert.equal(recording.commands.length, 2);
  assert.equal(recording.commands[1].jumpPressed, true);
  await page.locator("#reset").click();
  await page.locator("#import").setInputFiles(`${directory}/recording.json`);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("imported replay matches"),
  );
  assert.deepEqual((await read()).actor, jumpState.actor);
  await page.locator("#import").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...recording, finalState: "tampered" })),
  });
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("import rejected"),
  );
  assert.deepEqual((await read()).actor, jumpState.actor);
  await page.locator("#reset").click();
  await surface.focus();
  await page.keyboard.down("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal((await read()).actor.body.shapeId, 2);
  await page.keyboard.up("ArrowDown");
  await page.keyboard.press("Enter");
  assert.equal((await read()).actor.body.shapeId, 1);
  await page.locator("#scenario").selectOption("moving-support");
  await surface.focus();
  await page.keyboard.down("ArrowDown");
  await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  await page.keyboard.up("ArrowDown");
  assert.equal((await read()).actor.ignoredSupportId, 110);
  assert.equal((await read()).actor.body.supportId, null);
  await page.locator("#reset").click();
  const start = await read();
  for (let i = 0; i < 20; i++) await page.locator("#step").click();
  assert.equal((await read()).actor.body.x, start.actor.body.x + 20 * 256);
  await page.locator("#remove").click();
  await page.locator("#step").click();
  const removal = await read();
  assert.equal(removal.geometryRevision, 2);
  assert.equal(removal.actor.body.supportId, null);
  for (let i = 0; i < 40; i++) await page.locator("#step").click();
  assert.equal((await read()).actor.body.supportId, 100);
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  await page.locator("#reset").click();
  await page.locator("#run").click();
  await page.waitForFunction(
    () => JSON.parse(document.querySelector("#state").textContent).tick > 3,
  );
  await page.keyboard.down("ArrowRight");
  await page.locator("#scenario").focus(); // Real focus loss must clear held input and pause.
  await page.keyboard.up("ArrowRight");
  const paused = await read();
  await page.waitForTimeout(120);
  assert.equal((await read()).tick, paused.tick);
  assert.equal(await page.locator("#run").textContent(), "Run");
  await page.locator("#step").click();
  assert.equal((await read()).actor.body.vx, 0);
  await page.locator("#scenario").selectOption("crush");
  for (let i = 0; i < 65; i++) await page.locator("#step").click();
  const crushed = await read();
  assert.equal(crushed.stopped, "crushed");
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  await page.locator("#scenario").selectOption("enemy-ledge");
  await surface.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Enter");
  assert.equal((await read()).enemy.body.y, 230 * 256);
  assert((await read()).actor.body.y < 300 * 256);
  // Drive the actual lab step control without wall-clock pacing for a long patrol.
  await page.locator("#step").evaluate((button) => {
    for (let tick = 0; tick < 400; tick++) button.click();
  });
  const patrol = await read();
  assert(patrol.enemy.turns >= 2);
  assert.equal(patrol.enemy.body.supportId, 110);
  assert(patrol.navigation.spans.some((span) => span.supportIds.includes(110)));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: `${directory}/enemy-ledge.png` });
  await page.locator("#remove").click();
  await page.locator("#step").click();
  assert.equal((await read()).enemy.body.supportId, null);
  await page.locator("#step").evaluate((button) => {
    for (let tick = 0; tick < 40; tick++) button.click();
  });
  const landedEnemy = await read();
  assert.equal(landedEnemy.enemy.body.supportId, 100);
  assert.equal(landedEnemy.enemy.body.y, 300 * 256);
  assert.equal(landedEnemy.navigation.geometryRevision, 2);
  assert(landedEnemy.navigation.spans.every((span) => !span.supportIds.includes(110)));
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  const traversals = [];
  for (const [scenario, ticks] of [
    ["jump-link", 51],
    ["drop-link", 27],
  ]) {
    await page.locator("#scenario").selectOption(scenario);
    await page.locator("#traverse").click();
    await page.locator("#step").click();
    assert.equal((await read()).traversalStatus, "active");
    await page.locator("#step").evaluate((button) => {
      for (let i = 0; i < 9; i++) button.click();
    });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: `${directory}/${scenario}.png` });
    await page.locator("#step").evaluate((button, count) => {
      for (let i = 0; i < count; i++) button.click();
    }, ticks - 10);
    const finished = await read();
    assert.equal(finished.traversalStatus, "landed");
    assert.equal(finished.actor.body.supportId, 101);
    await page.locator("#replay").click();
    assert.match(await page.locator("#status").textContent(), /replay matches/);
    traversals.push(finished);
  }
  await page.locator("#scenario").selectOption("jump-link");
  await page.locator("#traverse").click();
  await page.locator("#step").evaluate((button) => {
    for (let i = 0; i < 10; i++) button.click();
  });
  const beforeCancellation = await read();
  await page.locator("#remove").click();
  await page.locator("#step").click();
  const cancelledTraversal = await read();
  assert.equal(cancelledTraversal.traversalStatus, "cancelled");
  assert.equal(cancelledTraversal.traversal, null);
  assert.equal(
    cancelledTraversal.actor.body.y,
    beforeCancellation.actor.body.y + beforeCancellation.actor.body.vy + 55,
  );
  await page.locator("#step").click();
  assert.notEqual((await read()).actor.body.y, cancelledTraversal.actor.body.y);
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  assert.deepEqual(errors, []);
  const report = {
    status: "pass",
    recordedAt: new Date().toISOString(),
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    browser: browser.version(),
    bundleSha256: createHash("sha256")
      .update(await readFile(`${root}/controller-lab.js`))
      .digest("hex"),
    screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
    checks: [
      "keyboard run",
      "between-tick jump tap",
      "local replay",
      "recording export",
      "recording import and tamper rejection",
      "crouch clearance",
      "one-way drop tap",
      "moving support carry",
      "geometry removal",
      "landing",
      "focus-loss pause and neutral input",
      "crush stop",
      "grounded patrol turns and independent player jump",
      "compiled navigation spans and removal revision",
      "authored jump/drop execution and replay",
      "mid-traversal cancellation continues gravity",
      "enemy support removal, gravity, landing and replay",
    ],
    traversals,
    cancelledTraversal,
    patrol,
    landedEnemy,
    jumpState,
    removal,
    crushed,
    scope:
      "Local Chromium engineering laboratory; no network, latency percentile, full gameplay or human feel acceptance",
  };
  await writeFile(`${directory}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      checks: report.checks,
      browser: report.browser,
      directory,
    }),
  );
} finally {
  if (browser) await browser.close();
  await new Promise((done) => server.close(done));
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve("dist/client"),
  output = "dist/combat-lab-evidence";
await mkdir(output, { recursive: true });
for (const file of ["report.json", "failure.json", "combat.png", "recording.json"])
  await rm(`${output}/${file}`, { force: true });
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
try {
  browser = await chromium.launch({ executablePath: process.env.EDGEFALL_CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1120, height: 1150 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/combat-lab.html`);
  await page.waitForFunction(() => Boolean(globalThis.combatLab));
  const read = () => page.evaluate(() => globalThis.combatLab.state());
  const surface = page.locator("#game");
  await surface.focus();
  const initial = await read();
  await page.keyboard.down("ArrowRight");
  await page.keyboard.press("KeyZ", { delay: 10 });
  await page.keyboard.press("Space", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.keyboard.up("ArrowRight");
  const first = await read();
  assert.equal(first.players[0].weapon.shotOrdinal, 1);
  assert(first.players[0].body.x > initial.players[0].body.x);
  assert(first.players[0].body.y < initial.players[0].body.y);
  assert.equal(first.events.filter((event) => event.kind === "shot").length, 1);
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  const downloaded = page.waitForEvent("download");
  await page.locator("#export").click();
  await (await downloaded).saveAs(`${output}/recording.json`);
  await page.locator("#reset").click();
  await page.locator("#import").setInputFiles(`${output}/recording.json`);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("imported replay matches"),
  );
  assert.deepEqual(await read(), first);
  const recording = JSON.parse(await readFile(`${output}/recording.json`, "utf8"));
  await page.locator("#import").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...recording, finalState: "tampered" })),
  });
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("import rejected"),
  );
  assert.deepEqual(await read(), first);
  await page.locator("#reset").click();
  await surface.focus();
  await page.keyboard.down("KeyZ");
  await surface.blur();
  await surface.focus();
  await page.keyboard.down("KeyZ"); // Browser auto-repeat cannot recreate cleared intent.
  await page.keyboard.press("Enter");
  await page.keyboard.up("KeyZ");
  assert.equal((await read()).players[0].weapon.shotOrdinal, 0);
  await page.locator("#reset").click();
  await surface.focus();
  await page.keyboard.press("KeyZ", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.keyboard.down("ArrowDown");
  await page.keyboard.press("Enter");
  await page.keyboard.up("ArrowDown");
  const crouched = await read();
  assert.equal(crouched.players[0].body.shapeId, 2);
  assert.equal(crouched.players[0].action.definitionId, 13);
  await page.keyboard.down("ArrowUp");
  await page.keyboard.press("Enter");
  await page.keyboard.up("ArrowUp");
  const up = await read();
  assert.equal(up.players[0].action.definitionId, 11);
  assert.equal(up.players[0].action.actionInstanceId, 1);
  assert.equal(up.players[0].action.stateStartTick, 1);
  assert.equal(up.players[0].weapon.shotOrdinal, 1);
  const scenarios = [];
  for (const scenario of ["range", "wall", "shield"]) {
    await page.locator("#scenario").selectOption(scenario);
    await page.locator("#players").selectOption("4");
    await page.locator("#reset").click();
    await page.locator("#assist").check();
    await surface.focus();
    await page.keyboard.down("KeyZ");
    for (let tick = 0; tick < 90; tick++) await page.keyboard.press("Enter");
    await page.keyboard.up("KeyZ");
    const state = await read();
    assert.equal(state.tick, 90);
    assert.equal(state.encounter.phase, scenario === "range" ? "complete" : "active");
    assert.equal(
      state.encounter.kills.reduce((sum, item) => sum + item.count, 0),
      scenario === "range" ? 2 : 0,
    );
    assert.equal(state.players[1].weapon.ammo, 132);
    await page.locator("#replay").click();
    assert.match(await page.locator("#status").textContent(), /replay matches/);
    assert.deepEqual(await read(), state);
    scenarios.push({ scenario, state });
  }
  // Inspect an active shot, authored sockets and the shield in one paused frame.
  await page.locator("#reset").click();
  await surface.focus();
  await page.keyboard.press("KeyZ", { delay: 10 });
  await page.keyboard.press("Enter");
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await page.screenshot({ path: `${output}/combat.png` });
  assert.deepEqual(errors, []);
  const report = {
    status: "pass",
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    recordedAt: new Date().toISOString(),
    browser: browser.version(),
    bundleSha256: createHash("sha256")
      .update(await readFile(`${root}/combat-lab.js`))
      .digest("hex"),
    tap: first,
    poseChange: { crouched, up },
    scenarios,
    scope:
      "Local Chromium keyboard/renderer, four deterministic input slots, firearm hit/ledger and recording replay proof; no network room, enemy attack, final media or full W05 acceptance",
  };
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: "pass",
      scenarios: scenarios.map((item) => ({
        scenario: item.scenario,
        phase: item.state.encounter.phase,
      })),
      output,
    }),
  );
} catch (error) {
  await writeFile(`${output}/failure.json`, JSON.stringify({ error: String(error) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  server.close();
}

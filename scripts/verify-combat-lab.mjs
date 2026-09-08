import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { verifyAreaLab } from "./lib/verify-area-lab.mjs";
import { verifyHmgLab } from "./lib/verify-hmg-lab.mjs";
import { verifyLaserLab } from "./lib/verify-laser-lab.mjs";
import { verifyOrdnanceLab } from "./lib/verify-ordnance-lab.mjs";
import { verifyPickupLab } from "./lib/verify-pickup-lab.mjs";
import { verifyRocketLab } from "./lib/verify-rocket-lab.mjs";
import { verifyShieldLab } from "./lib/verify-shield-lab.mjs";
import { verifySupportLab } from "./lib/verify-support-lab.mjs";
import { verifyTankLab } from "./lib/verify-tank-lab.mjs";

const root = resolve("dist/client"),
  output = "dist/combat-lab-evidence";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
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
  const foot = [];
  for (const mode of ["melee", "grenade"]) {
    await page.locator("#scenario").selectOption("range");
    await page.locator("#players").selectOption("1");
    await page.locator("#assist").uncheck();
    await page.locator("#reset").click();
    await surface.focus();
    if (mode === "melee") {
      await page.keyboard.down("ArrowRight");
      for (let tick = 0; tick < 45; tick++) await page.keyboard.press("Enter");
      await page.keyboard.up("ArrowRight");
      await page.keyboard.down("KeyZ");
      for (let tick = 0; tick < 6; tick++) await page.keyboard.press("Enter");
      await page.keyboard.up("KeyZ");
    } else {
      await page.keyboard.press("KeyC", { delay: 10 });
      await page.keyboard.press("Enter");
      assert.equal((await read()).players[0].grenadeStock, 9);
      for (let tick = 0; tick < 3; tick++) await page.keyboard.press("Enter");
      assert.equal((await read()).grenades.length, 0);
      await page.keyboard.press("Enter");
    }
    const active = await read();
    assert.equal(active.players[0].weapon.shotOrdinal, 0);
    if (mode === "melee") assert.deepEqual(active.strikes[0].hitIds, [20]);
    else assert.equal(active.grenades[0].spawnTick, 5);
    const path = `${output}/${mode}-active.json`;
    const download = page.waitForEvent("download");
    await page.locator("#export").click();
    await (await download).saveAs(path);
    assert.equal(JSON.parse(await readFile(path, "utf8")).format, 14);
    await page.locator("#reset").click();
    await page.locator("#import").setInputFiles(path);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("imported replay matches"),
    );
    assert.deepEqual(await read(), active);
    if (mode === "grenade") {
      await surface.focus();
      for (let tick = 5; tick < 95; tick++) await page.keyboard.press("Enter");
      const detonated = await read();
      assert.equal(detonated.grenades.length, 0);
      assert.equal(detonated.players[0].grenadeStock, 9);
      assert.equal(detonated.events.filter((event) => event.kind === "explosion").length, 1);
    }
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await page.screenshot({ path: `${output}/${mode}.png` });
    foot.push({ mode, active, final: await read() });
  }
  const shield = await verifyShieldLab(page, output);
  const area = await verifyAreaLab(page, output);
  const tank = await verifyTankLab(page, output);
  const ordnance = await verifyOrdnanceLab(page, output);
  const hmg = await verifyHmgLab(page, output);
  const support = await verifySupportLab(page, output);
  const rocket = await verifyRocketLab(page, output);
  const laser = await verifyLaserLab(page, output);
  const pickups = await verifyPickupLab(page, output);
  await page.locator("#scenario").selectOption("range");
  await page.locator("#players").selectOption("1");
  await page.locator("#assist").uncheck();
  await page.locator("#reset").click();
  await surface.focus();
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("KeyZ");
  const transitions = [],
    restoredPhases = [];
  let previousLife = "alive",
    lifeState;
  for (let tick = 1; tick <= 900; tick++) {
    await page.keyboard.press("Enter");
    lifeState = await read();
    const player = lifeState.players[0];
    if (player.life !== previousLife) {
      transitions.push({
        tick,
        life: player.life,
        lifeStartTick: player.lifeStartTick,
        lives: player.lives,
        health: player.health,
        protection: player.invulnerableTicks,
        weapon: player.weapon,
      });
      previousLife = player.life;
    }
    if (
      (player.life === "death" || player.life === "respawning") &&
      tick - player.lifeStartTick === 6 &&
      !restoredPhases.includes(player.life)
    ) {
      await page.keyboard.up("ArrowRight");
      await page.keyboard.up("KeyZ");
      const path = `${output}/life-${player.life === "death" ? "death" : "entry"}.json`;
      const download = page.waitForEvent("download");
      await page.locator("#export").click();
      await (await download).saveAs(path);
      await page.locator("#reset").click();
      await page.locator("#import").setInputFiles(path);
      await page.waitForFunction(() =>
        document.querySelector("#status").textContent.includes("imported replay matches"),
      );
      assert.deepEqual(
        await read(),
        lifeState,
        `Browser ${player.life} replay lost remaining delay or spent lives`,
      );
      restoredPhases.push(player.life);
      await surface.focus();
      await page.keyboard.down("ArrowRight");
      await page.keyboard.down("KeyZ");
    }
    if (player.life === "spectating") break;
  }
  await page.keyboard.up("ArrowRight");
  await page.keyboard.up("KeyZ");
  assert.equal(lifeState.players[0].life, "spectating");
  assert.equal(lifeState.players[0].lives, 0);
  assert.deepEqual(
    transitions.filter((p) => p.life === "death").map((p) => p.lives),
    [2, 1, 0],
  );
  assert.deepEqual(restoredPhases, ["death", "respawning"]);
  assert(
    transitions
      .filter((p) => p.life === "respawning")
      .every((p) => p.protection === 120 && p.weapon.id === "sidearm"),
  );
  await page.locator("#replay").click();
  assert.match(await page.locator("#status").textContent(), /replay matches/);
  assert.deepEqual(await read(), lifeState);
  await page.screenshot({ path: `${output}/life.png` });
  // Inspect an active shot, authored sockets and the shield in one paused frame.
  await page.locator("#scenario").selectOption("shield");
  await page.locator("#players").selectOption("4");
  await page.locator("#assist").check();
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
    foot,
    shield,
    area,
    tank,
    ordnance,
    hmg,
    support,
    rocket,
    laser,
    pickups,
    life: { transitions, restoredPhases, state: lifeState },
    scope:
      "Local Chromium keyboard/renderer, four input slots, gun/knife/grenade actions, active shield/rifle counterplay and exact broken-shield recording reconstruction, three fall deaths, protected entry and spectating; no network room, final media or full W05 acceptance",
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

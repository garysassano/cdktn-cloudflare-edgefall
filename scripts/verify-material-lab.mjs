import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { areaExposures } from "../src/game/combat/area-attack.ts";
import { beamExposures } from "../src/game/combat/beam.ts";
import { actionPose } from "../src/game/combat/timeline.ts";
import { SURFACE_MATERIAL_IDS } from "../src/game/content/materials.ts";
import { LASER_PROFILE } from "../src/game/content/weapons/laser.ts";
import {
  ROCKET_ATTACK,
  ROCKET_PROFILE,
  ROCKET_SHAPE,
} from "../src/game/content/weapons/rocket-launcher.ts";
import { canonical, stateHash } from "../src/game/core/canonical.ts";
import {
  AREA_PROFILES,
  COMBAT_ATTACKS,
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  GRENADE_PROFILE,
} from "../src/game/labs/combat-content.ts";
import {
  MATERIAL_LAB_WEAPONS,
  materialLabStage,
  replayMaterialLab,
} from "../src/game/labs/materials.ts";
import { worldRect, worldSocket } from "../src/game/physics/body.ts";
import { MATERIAL_TICKS, recordMaterialCombat } from "../test/fixtures/material-proof.ts";

const root = resolve("dist/client"),
  output = "dist/material-lab-evidence";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const report = {
  status: "running",
  scope:
    "Keyboard-driven local inspector with one/four-player calibration; this is not a network room, durable archive or deployed performance proof.",
  node: process.version,
  bundleSha256: sha256(await readFile(`${root}/material-lab.js`)),
  htmlSha256: sha256(await readFile(`${root}/material-lab.html`)),
  verifierSha256: sha256(await readFile("scripts/verify-material-lab.mjs")),
  cases: [],
  errors: [],
};
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error("Outside inspector root");
    response.setHeader("Content-Type", extname(path) === ".html" ? "text/html" : "text/javascript");
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));

// Compare actual Phaser objects after a render with authoritative geometry, including removal.
function expectedGeometry(fixture, tick) {
  const lab = fixture.states[tick],
    world = lab.world,
    shapes = [];
  const box = (key, rect) =>
    shapes.push({
      key,
      x: rect.x / 256,
      y: rect.y / 256,
      w: rect.w / 256,
      h: rect.h / 256,
      visible: true,
    });
  const stage = materialLabStage(lab);
  for (const target of stage.terrain) box(`terrain:${target.id}`, target.rect);
  for (const actor of world.players)
    if (actor.bodyPresence === "present")
      box(
        `player:${actor.playerId}`,
        worldRect(actor.body, COMBAT_SHAPES.get(actor.body.shapeId).rect, actor.facing),
      );
  for (const target of world.targets)
    if (target.health > 0)
      box(
        `target:${target.enemy.body.id}`,
        worldRect(
          target.enemy.body,
          COMBAT_SHAPES.get(target.enemy.body.shapeId).rect,
          target.enemy.facing,
        ),
      );
  for (const projectile of world.projectiles)
    box(
      `bullet:${projectile.id}`,
      worldRect(
        projectile.position,
        COMBAT_SHAPES.get(COMBAT_ATTACKS.get(projectile.definitionId).shapeId).rect,
        1,
      ),
    );
  for (const rocket of world.rockets)
    box(`rocket:${rocket.id}`, worldRect(rocket.position, ROCKET_SHAPE.rect, 1));
  for (const grenade of world.grenades)
    box(
      `grenade:${grenade.id}`,
      worldRect(grenade.body, COMBAT_SHAPES.get(grenade.body.shapeId).rect, 1),
    );
  for (const area of world.areas)
    for (const exposure of areaExposures(
      area,
      tick,
      AREA_PROFILES.get(area.definitionId),
      stage.terrain,
    ))
      box(`area:${area.id}:${exposure.lobe}`, exposure.rect);
  for (const beam of world.beams)
    for (const [index, exposure] of beamExposures(beam, LASER_PROFILE).entries())
      box(`beam:${beam.id}:${index}`, exposure.rect);
  for (const strike of world.strikes) {
    const actor = world.players.find((actor) => actor.playerId === strike.ownerId),
      shape = COMBAT_SHAPES.get(COMBAT_ATTACKS.get(strike.definitionId).shapeId);
    const pose = actionPose(
        COMBAT_CATALOG,
        actor.action.definitionId,
        tick - actor.action.stateStartTick,
      ),
      hand = pose.sockets.find((socket) => socket.name === "hand");
    box(
      `knife:${strike.id}`,
      worldRect(worldSocket(actor.body, hand.point, actor.facing), shape.rect, actor.facing),
    );
  }
  const circles = world.events
    .filter((event) => event.kind === "explosion")
    .map((event, id) => ({
      id,
      x: event.position.x / 256,
      y: event.position.y / 256,
      radius:
        (event.source?.definitionId === ROCKET_ATTACK.id
          ? ROCKET_PROFILE.blastRadius
          : GRENADE_PROFILE.radius) / 256,
      visible: true,
    }));
  const impacts = fixture.states.slice(Math.max(1, tick - 6), tick + 1).flatMap((state) =>
    state.world.events
      .filter((event) => event.kind === "impact" && event.impact)
      .map((event) => ({
        x: event.position.x / 256 - 1,
        y: event.position.y / 256 - 1,
        w: 2,
        h: 2,
        visible: true,
      })),
  );
  return { shapes: shapes.sort((a, b) => a.key.localeCompare(b.key)), circles, impacts };
}
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.EDGEFALL_CHROMIUM_PATH });
  report.chromium = browser.version();
  const page = await browser.newPage({ viewport: { width: 1120, height: 1250 } });
  page.on("pageerror", (error) => report.errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/material-lab.html`);
  await page.waitForFunction(() => globalThis.materialLab?.status().ready);
  const read = () => page.evaluate(() => globalThis.materialLab.state());
  const status = () => page.evaluate(() => globalThis.materialLab.status());
  const presented = async (tick) => {
    await page.waitForFunction(
      (tick) => globalThis.materialLab.status().presentedTick === tick,
      tick,
      { timeout: 5000 },
    );
    const current = await status();
    assert.equal(current.tick, tick);
    return current;
  };
  const surface = page.locator("#game");

  // Short taps survive a pointer Step; leaving the surface clears unconsumed input.
  await page.locator("#players").selectOption("2");
  await surface.focus();
  await page.keyboard.press("KeyZ");
  await page.locator("#step").click();
  assert((await read()).world.players.every((actor) => actor.weapon.shotOrdinal === 1));
  await page.locator("#reset").click();
  await surface.focus();
  await page.keyboard.down("KeyZ");
  await surface.blur();
  await surface.focus();
  await page.keyboard.down("KeyZ");
  await page.keyboard.press("Enter");
  await page.keyboard.up("KeyZ");
  assert((await read()).world.players.every((actor) => actor.weapon.shotOrdinal === 0));
  report.inputControls = {
    players: 2,
    pointerStepRetainsTap: true,
    blurClearsIntent: true,
    repeatDoesNotRecreateIntent: true,
  };

  for (const players of [1, 4])
    for (const targetMotion of ["stationary", "patrol"])
      for (const materialId of SURFACE_MATERIAL_IDS)
        for (const weapon of MATERIAL_LAB_WEAPONS) {
          const definition = { players, targetMotion, materialId, weapon },
            fixture = recordMaterialCombat(definition);
          const name = `${players}-${targetMotion}-${materialId}-${weapon}`;
          for (const [selector, value] of [
            ["#players", String(players)],
            ["#motion", targetMotion],
            ["#material", materialId],
            ["#weapon", weapon],
          ])
            await page.locator(selector).selectOption(value);
          await page.locator("#reset").click();
          assert.deepEqual(await read(), fixture.states[0]);
          await surface.focus();
          if (weapon === "grenade") await page.keyboard.down("ArrowDown");
          await page.keyboard.press(weapon === "grenade" ? "KeyC" : "KeyZ");
          const firstImpact = fixture.impacts[0]?.tick;
          const firstActive = fixture.states.find(
            (state) =>
              state.world.projectiles.length +
                state.world.areas.length +
                state.world.beams.length +
                state.world.rockets.length +
                state.world.strikes.length +
                state.world.grenades.length >
              0,
          )?.world.tick;
          const destruction = fixture.states.find((state) => state.world.props[0].health === 0)
            ?.world.tick;
          const boundaries = [
            ...new Set(
              [
                1,
                5,
                12,
                18,
                30,
                60,
                90,
                95,
                MATERIAL_TICKS,
                firstImpact,
                firstActive,
                destruction,
              ].filter((tick) => tick !== undefined),
            ),
          ].sort((a, b) => a - b);
          let currentTick = 0;
          const geometryBoundaries = [],
            screenshots = [];
          for (const tick of boundaries) {
            while (currentTick < tick) {
              const ticks = Math.min(30, tick - currentTick);
              await page.evaluate((ticks) => globalThis.materialLab.advance(ticks), ticks);
              currentTick += ticks;
            }
            const actual = await presented(tick),
              expected = expectedGeometry(fixture, tick);
            assert.equal(actual.error, "", `${name} tick ${tick}`);
            assert.equal(actual.hash, stateHash(fixture.states[tick]), `${name} tick ${tick}`);
            assert.deepEqual(
              actual.shapes
                .filter((shape) => !shape.key.startsWith("impact:"))
                .sort((a, b) => a.key.localeCompare(b.key)),
              expected.shapes,
              `${name} shapes ${tick}`,
            );
            assert.deepEqual(actual.circles, expected.circles, `${name} blast ${tick}`);
            assert.deepEqual(
              actual.shapes
                .filter((shape) => shape.key.startsWith("impact:"))
                .map(({ key, ...shape }) => shape),
              expected.impacts,
              `${name} impact markers ${tick}`,
            );
            geometryBoundaries.push({
              tick,
              hash: actual.hash,
              rectangles: actual.shapes.length,
              blasts: actual.circles.length,
            });
            if (
              (players === 1 &&
                targetMotion === "stationary" &&
                [firstActive, firstImpact].includes(tick)) ||
              (players === 4 && targetMotion === "stationary" && tick === destruction)
            ) {
              const file = `${name}-${tick}.png`,
                bytes = await page
                  .locator("#game canvas")
                  .screenshot({ path: `${output}/${file}` });
              screenshots.push({ file, sha256: sha256(bytes), tick });
            }
          }
          if (weapon === "grenade") await page.keyboard.up("ArrowDown");
          const final = await read();
          assert.deepEqual(final, fixture.state);
          assert.deepEqual(
            (await status()).hashes,
            fixture.states.map(stateHash),
            `${name} all boundaries`,
          );
          await page.locator("#replay").click();
          assert.equal((await status()).error, "Replay matches");
          const download = page.waitForEvent("download");
          await page.locator("#export").click();
          const file = `${name}.recording.json`;
          await (await download).saveAs(`${output}/${file}`);
          const bytes = await readFile(`${output}/${file}`),
            recording = JSON.parse(bytes);
          assert.equal(canonical(replayMaterialLab(recording)), canonical(fixture.state));
          await page.locator("#reset").click();
          await page.locator("#import").setInputFiles(`${output}/${file}`);
          await page.waitForFunction(
            () => globalThis.materialLab.status().error === "Imported replay matches",
          );
          assert.deepEqual(await read(), final);
          assert.deepEqual((await status()).hashes, fixture.states.map(stateHash));
          await presented(MATERIAL_TICKS);
          report.cases.push({
            definition,
            ticks: MATERIAL_TICKS,
            finalHash: stateHash(final),
            traceHash: stateHash(fixture.states.map(stateHash)),
            geometryBoundaries,
            screenshots,
            recording: {
              file,
              sha256: sha256(bytes),
              contentFingerprint: recording.contentFingerprint,
            },
          });
        }
  const before = await read(),
    recording = await page.evaluate(() => globalThis.materialLab.recording());
  for (const [name, changed] of [
    ["state", { ...recording, finalState: "tampered" }],
    ["fingerprint", { ...recording, contentFingerprint: "00000000" }],
  ]) {
    await page.locator("#import").setInputFiles({
      name: `invalid-${name}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(changed)),
    });
    await page.waitForFunction(() => globalThis.materialLab.status().error.startsWith("Error:"));
    assert.deepEqual(await read(), before);
  }
  report.importRejectionPreservesWorld = true;
  await page.locator("#reset").click();
  await presented(0);
  await page.screenshot({ path: `${output}/inspector.png`, fullPage: true });
  assert.deepEqual(report.errors, []);
  assert.equal(report.cases.length, 128);
  report.status = "pass";
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `Material inspector passed: ${report.cases.length} keyboard recordings, ${report.cases.reduce((sum, item) => sum + item.geometryBoundaries.length, 0)} rendered boundaries.`,
  );
} catch (error) {
  report.status = "fail";
  report.failure = String(error);
  await writeFile(`${output}/failure.json`, `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

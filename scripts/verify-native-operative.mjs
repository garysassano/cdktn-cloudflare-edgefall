import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { verifyDeathBodyLab } from "./lib/verify-death-body-lab.mjs";

const root = resolve("dist/client"),
  output = "dist/native-operative-evidence";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const file = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!file.startsWith(`${root}/`)) throw new Error("Outside fixture");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".png": "image/png",
        ".json": "application/json",
      }[extname(file)] ?? "application/octet-stream",
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const atlas = JSON.parse(await readFile(`${root}/assets/art/hero/operative.atlas.json`, "utf8"));
const sourceImage = await sharp(`${root}/assets/art/hero/operative.png`)
  .raw()
  .toBuffer({ resolveWithObject: true });
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.EDGEFALL_CHROMIUM_PATH });
  const page = await browser.newPage({ viewport: { width: 1240, height: 1180 } }),
    errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(`${base}/combat-lab.html`);
  await page.locator("#native-operative").check();
  await page.locator("#player-overlays").uncheck();
  const read = async () => {
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await page.waitForFunction(() => {
      const lab = globalThis.combatLab,
        actor = lab?.state().players[0],
        frame = lab?.nativeFrames()[0];
      return (
        actor &&
        (actor.deathBody === "removed" || actor.life === "spectating"
          ? frame === null
          : frame?.tick === lab.state().tick)
      );
    });
    return page.evaluate(() => ({
      state: globalThis.combatLab.state(),
      frames: globalThis.combatLab.nativeFrames(),
    }));
  };
  const surface = page.locator("#game"),
    canvas = surface.locator("canvas");
  const captures = [];
  const recordings = [];
  const checkRecording = async (file) => {
    const before = await read(),
      download = page.waitForEvent("download");
    await page.locator("#export").click();
    await (await download).saveAs(`${output}/${file}`);
    await page.locator("#reset").click();
    await page.locator("#import").setInputFiles(`${output}/${file}`);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("imported replay matches"),
    );
    assert.deepEqual(await read(), before);
    recordings.push({
      file,
      tick: before.state.tick,
      legs: before.frames[0]?.legsFrame ?? null,
      upper: before.frames[0]?.upperFrame ?? null,
      motion: before.frames[0]?.motion ?? null,
      body: before.frames[0]?.fullBodyFrame ?? null,
    });
    await surface.focus();
  };
  // Compare every opaque native pixel to the actual browser canvas in both
  // directions. Metadata-only assertions would miss an incorrect Phaser origin.
  const checkRenderedPixels = async (label) => {
    const { frames } = await read(),
      drawing = frames[0];
    const shot = await canvas.screenshot({ path: `${output}/${label}.png` });
    const actual = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const scale = actual.info.width / 384;
    assert(Number.isInteger(scale));
    const composed = Buffer.alloc(64 * 64 * 4);
    for (const id of [drawing.legsFrame, drawing.upperFrame, drawing.fullBodyFrame].filter(
      Boolean,
    )) {
      const f = atlas.frames[id].frame;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const from = ((f.y + y) * sourceImage.info.width + f.x + x) * 4;
          if (sourceImage.data[from + 3])
            sourceImage.data.copy(composed, (y * 64 + x) * 4, from, from + 4);
        }
    }
    let pixels = 0;
    for (let y = 0; y < 48; y++)
      for (let x = 0; x < 64; x++) {
        const from = (y * 64 + x) * 4;
        if (!composed[from + 3]) continue;
        const worldX = drawing.x + (drawing.flipX ? 24 - 1 - x : x - 24),
          worldY = drawing.y + y - 48;
        const to = (worldY * scale * actual.info.width + worldX * scale) * 4;
        assert.equal(
          actual.data.subarray(to, to + 4).toString("hex"),
          composed.subarray(from, from + 4).toString("hex"),
          `${label} pixel ${x},${y}`,
        );
        pixels++;
      }
    captures.push({ label, pixels, ...drawing });
  };
  await checkRenderedPixels("standing-right");
  await surface.focus();
  await page.keyboard.down("ArrowLeft");
  await page.keyboard.press("Enter");
  await page.keyboard.up("ArrowLeft");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await checkRenderedPixels("standing-left");
  await page.locator("#reset").click();
  await surface.focus();
  await page.keyboard.down("ArrowRight");
  await page.keyboard.down("KeyZ");
  const run = [],
    seen = new Set();
  for (let tick = 1; tick <= 24; tick++) {
    await page.keyboard.press("Enter");
    const { state, frames } = await read(),
      frame = frames[0],
      player = state.players[0];
    assert(/legs-(run|start)-/.test(frame.legsFrame));
    run.push({
      tick,
      legs: frame.legsFrame,
      upper: frame.upperFrame,
      motion: frame.motion,
      contact: frame.contact,
      action: player.action.kind,
      actionStart: player.action.stateStartTick,
      shots: player.weapon.shotOrdinal,
    });
    if (frame.legsFrame.includes("legs-run-") && !seen.has(frame.legsFrame)) {
      seen.add(frame.legsFrame);
      await canvas.screenshot({ path: `${output}/run-${seen.size - 1}.png` });
    }
    if (tick === 2 || tick === 3)
      await canvas.screenshot({ path: `${output}/recoil-${tick === 2 ? "kick" : "settle"}.png` });
  }
  await page.keyboard.up("ArrowRight");
  await page.keyboard.up("KeyZ");
  assert.equal(seen.size, 8);
  assert(
    new Set(run.filter((frame) => frame.action === "fire").map((frame) => frame.legs)).size > 1,
  );
  assert(run.at(-1).shots > 1);
  assert.equal(
    new Set(run.map((sample) => sample.motion.runStartTick)).size,
    1,
    "Shots restarted run phase",
  );
  assert.equal(
    new Set(run.filter((sample) => sample.action === "fire").map((sample) => sample.upper)).size,
    3,
    "Recoil drawings did not advance",
  );
  const contacts = new Map();
  for (const sample of run)
    if (sample.contact && (sample.tick - sample.motion.runStartTick) % 2 === 0) {
      const key = `${Math.floor((sample.tick - sample.motion.runStartTick) / 16)}/${sample.contact.foot}`;
      if (contacts.has(key))
        assert.equal(
          sample.contact.x,
          contacts.get(key),
          "Authored contact slipped at exposure boundary",
        );
      contacts.set(key, sample.contact.x);
    }
  await checkRecording("run-recording.json");
  const transitions = [];
  await page.locator("#reset").click();
  await surface.focus();
  const stepMotion = async () => {
    await page.keyboard.press("Enter");
    const value = await read();
    transitions.push({
      tick: value.state.tick,
      legs: value.frames[0].legsFrame,
      upper: value.frames[0].upperFrame,
      transition: value.frames[0].motion.transition,
    });
    return value;
  };
  await page.keyboard.down("ArrowRight");
  await page.keyboard.press("KeyZ");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-start-brace");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-start-drive");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-run-0");
  await page.keyboard.up("ArrowRight");
  await page.keyboard.down("ArrowLeft");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-reverse-pivot");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-reverse-drive");
  await page.keyboard.up("ArrowLeft");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-stop-brake");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-stop-settle");
  await page.keyboard.down("ArrowDown");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-crouch-mid");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-crouch");
  await page.keyboard.up("ArrowDown");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-crouch-mid");
  assert.equal((await stepMotion()).frames[0].legsFrame, "p1/legs-idle");
  await page.keyboard.press("Space");
  let falling = await stepMotion();
  assert.equal(falling.frames[0].legsFrame, "p1/legs-rise");
  while (falling.state.players[0].locomotion === "airborne" && falling.state.tick < 120)
    falling = await stepMotion();
  assert.equal(falling.frames[0].legsFrame, "p1/legs-land-compress");
  await canvas.screenshot({ path: `${output}/landing.png` });
  const landedY = falling.state.players[0].body.y,
    shots = falling.state.players[0].weapon.shotOrdinal;
  await page.keyboard.press("Space");
  await page.keyboard.press("KeyZ");
  const interrupted = await stepMotion();
  assert(interrupted.state.players[0].body.y < landedY);
  assert.equal(interrupted.frames[0].legsFrame, "p1/legs-rise");
  assert.equal(interrupted.state.players[0].weapon.shotOrdinal, shots + 1);
  await checkRecording("motion-recording.json");
  const poses = [];
  for (const [name, aim, jump, upper, legs] of [
    ["crouch", "ArrowDown", false, "upper-crouch", "legs-crouch-mid"],
    ["up", "ArrowUp", false, "upper-up", "legs-idle"],
    ["air-down", "ArrowDown", true, "upper-down", "legs-rise"],
  ]) {
    await page.locator("#reset").click();
    await surface.focus();
    if (jump) {
      await page.keyboard.press("Space");
      await page.keyboard.press("Enter");
    }
    await page.keyboard.down(aim);
    await page.keyboard.press("KeyZ");
    await page.keyboard.press("Enter");
    const value = await read(),
      frame = value.frames[0],
      shot = value.state.events.find((event) => event.kind === "shot");
    assert.equal(frame.upperFrame, `p1/${upper}`);
    assert.equal(frame.legsFrame, `p1/${legs}`);
    assert(shot, "Missing shot release for socket check");
    assert(Math.abs(frame.muzzle.x - shot.position.x / 256) <= 0.5);
    assert(Math.abs(frame.muzzle.y - shot.position.y / 256) <= 0.5);
    await page.keyboard.up(aim);
    await canvas.screenshot({ path: `${output}/${name}.png` });
    poses.push({ name, frame, shot: shot.position });
  }
  // The real recording format restores the same accepted tick and presentation.
  await checkRecording("recording.json");
  await page.locator("#player-overlays").check();
  await canvas.screenshot({ path: `${output}/air-down-debug.png` });
  await page.locator("#player-overlays").uncheck();
  const actions = [];
  for (const mode of ["run", "air", "crouch"]) {
    await page.locator("#reset").click();
    await surface.focus();
    await page.keyboard.down(mode === "crouch" ? "ArrowDown" : "ArrowRight");
    if (mode === "air") await page.keyboard.press("Space");
    await page.keyboard.press("KeyC");
    const samples = [];
    for (let age = 0; age < 20; age++) {
      await page.keyboard.press("Enter");
      const value = await read(),
        frame = value.frames[0],
        player = value.state.players[0];
      assert(/upper-(grenade-|action-ready)/.test(frame.upperFrame));
      assert.equal(frame.fullBodyFrame, null);
      const release = value.state.events.find((event) => event.kind === "throw");
      if (release) {
        assert.equal(age, 4);
        assert(Math.abs(frame.hand.x - release.position.x / 256) <= 0.5);
        assert(Math.abs(frame.hand.y - release.position.y / 256) <= 0.5);
        await canvas.screenshot({ path: `${output}/grenade-${mode}-release.png` });
      }
      samples.push({
        age,
        tick: value.state.tick,
        upper: frame.upperFrame,
        legs: frame.legsFrame,
        hand: frame.hand,
        release: release?.position ?? null,
        locomotion: player.locomotion,
      });
    }
    await page.keyboard.up(mode === "crouch" ? "ArrowDown" : "ArrowRight");
    assert.equal(samples.filter((sample) => sample.release).length, 1);
    if (mode === "run") assert(new Set(samples.map((sample) => sample.legs)).size > 6);
    if (mode === "air") assert(samples.every((sample) => sample.locomotion === "airborne"));
    actions.push({ kind: `grenade-${mode}`, samples });
    await checkRecording(`grenade-${mode}-recording.json`);
  }
  for (const crouch of [false, true]) {
    await page.locator("#reset").click();
    await surface.focus();
    await page.keyboard.down("ArrowRight");
    let close = await read();
    while (
      close.state.targets[0].enemy.body.x - close.state.players[0].body.x > 22 * 256 &&
      close.state.tick < 100
    ) {
      await page.keyboard.press("Enter");
      close = await read();
    }
    await page.keyboard.up("ArrowRight");
    if (crouch) await page.keyboard.down("ArrowDown");
    await page.keyboard.press("KeyZ");
    const samples = [];
    for (let age = 0; age < 18; age++) {
      await page.keyboard.press("Enter");
      const value = await read(),
        frame = value.frames[0];
      assert.equal(value.state.players[0].action.kind, "melee");
      assert(/upper-(melee-|action-ready)/.test(frame.upperFrame));
      assert.equal(frame.fullBodyFrame, null);
      if (value.state.strikes.length) assert(frame.upperFrame.includes("melee-strike"));
      if (age === 5)
        await canvas.screenshot({
          path: `${output}/knife-${crouch ? "crouch" : "stand"}-active.png`,
        });
      if (age === 7) await checkRecording(`knife-${crouch ? "crouch" : "stand"}-recording.json`);
      samples.push({
        age,
        tick: value.state.tick,
        upper: frame.upperFrame,
        legs: frame.legsFrame,
        hand: frame.hand,
        active: value.state.strikes.length > 0,
      });
    }
    if (crouch) await page.keyboard.up("ArrowDown");
    assert.equal(samples.filter((sample) => sample.active).length, 4);
    actions.push({ kind: crouch ? "knife-crouch" : "knife-stand", samples });
  }
  await page.locator("#scenario").selectOption("rifle");
  await surface.focus();
  let living = await read();
  while (living.state.players[0].life === "alive" && living.state.tick < 250) {
    await page.keyboard.press("Enter");
    living = await read();
  }
  assert.equal(living.state.players[0].life, "death");
  const lifeSamples = [],
    deadFrames = new Set(),
    entryFrames = new Set();
  while (living.state.players[0].life !== "alive" && living.state.tick < 350) {
    const actor = living.state.players[0],
      frame = living.frames[0],
      age = living.state.tick - actor.lifeStartTick;
    assert.equal(frame.upperFrame, null);
    assert.equal(frame.legsFrame, null);
    assert.equal(frame.muzzle, null);
    (actor.life === "death" ? deadFrames : entryFrames).add(frame.fullBodyFrame);
    lifeSamples.push({ tick: living.state.tick, life: actor.life, age, body: frame.fullBodyFrame });
    if (actor.life === "death" && age === 24) {
      await checkRenderedPixels("death-still");
      await checkRecording("death-recording.json");
    }
    if (actor.life === "respawning" && age === 9) await checkRenderedPixels("reentry-ready");
    if (actor.life === "respawning" && age === 11) {
      await page.keyboard.press("Space");
      await page.keyboard.press("KeyZ");
    }
    await surface.focus();
    await page.keyboard.press("Enter");
    living = await read();
  }
  assert.equal(deadFrames.size, 8);
  assert.equal(entryFrames.size, 4);
  assert.equal(living.state.players[0].life, "alive");
  assert.equal(living.state.players[0].locomotion, "airborne");
  assert.equal(living.state.players[0].weapon.shotOrdinal, 1);
  assert.equal(living.frames[0].fullBodyFrame, null);
  actions.push({ kind: "death-reentry", samples: lifeSamples, resumedTick: living.state.tick });
  await checkRecording("reentry-recording.json");
  const deathBodies = await verifyDeathBodyLab(page, read, checkRenderedPixels, checkRecording);
  await page.locator("#scenario").selectOption("range");

  await page.locator("#players").selectOption("4");
  await page.waitForFunction(() => globalThis.combatLab.nativeFrames().length === 4);
  assert.equal((await read()).frames[1], null, "Undrawn HMG must keep engineering fallback");
  await canvas.screenshot({ path: `${output}/four-slots.png` });
  await page.goto(`${base}/art-review.html#native`);
  await page.waitForFunction(() => document.querySelector("#native").dataset.ready === "true");
  assert.equal(await page.locator("#native-cards figure").count(), 4);
  const reviewedFrames = new Set();
  for (let tick = 0; tick < 16; tick++) {
    reviewedFrames.add(await page.locator("#native").getAttribute("data-legs"));
    await page.locator("#native-step").click();
  }
  assert.equal(reviewedFrames.size, 8);
  const reviewedClips = [];
  for (const clip of atlas.meta.edgefall.clips.filter((clip) => clip.id !== "legs.run")) {
    await page.locator("#native-body").selectOption("");
    const control =
      clip.channel === "upper"
        ? "#native-upper"
        : clip.channel === "full-body"
          ? "#native-body"
          : "#native-legs";
    if (clip.channel === "upper")
      await page
        .locator("#native-legs")
        .selectOption(
          clip.id.includes("crouch")
            ? "legs-crouch"
            : clip.id.includes(".run.")
              ? "run-loop"
              : "legs-idle",
        );
    await page.locator(control).selectOption(`clip:${clip.id}`);
    await page.locator("#native-reset").click();
    const frames = [];
    for (const exposure of clip.exposures)
      for (let i = 0; i < exposure.ticks; i++) {
        const frame = await page
          .locator("#native")
          .getAttribute(
            clip.channel === "upper"
              ? "data-upper"
              : clip.channel === "full-body"
                ? "data-body"
                : "data-legs",
          );
        assert.equal(frame, exposure.frame);
        if (
          i === 0 &&
          (/upper\.(grenade|melee|idle|run|land)/.test(clip.id) || clip.channel === "full-body")
        ) {
          await page.locator("#native-roots").uncheck();
          await page
            .locator("#native-cards")
            .screenshot({ path: `${output}/${clip.id}-${frame}.png` });
        }
        frames.push(frame);
        await page.locator("#native-step").click();
      }
    const secondCycle = [];
    if (clip.mode === "loop")
      for (
        let age = 0;
        age < Math.min(frames.length, Math.max(5, clip.exposures[0].ticks + 1));
        age++
      ) {
        const frame = await page
          .locator("#native")
          .getAttribute(clip.channel === "upper" ? "data-upper" : "data-legs");
        assert.equal(frame, frames[age], "Continuous clip inherited the one-shot review hold");
        secondCycle.push(frame);
        await page.locator("#native-step").click();
      }
    reviewedClips.push({ id: clip.id, frames, secondCycle });
  }
  await page.locator("#native-body").selectOption("");
  await page.locator("#native-upper").selectOption("upper-horizontal");
  await page.locator("#native-legs").selectOption("run-loop");
  await page.locator("#native-reset").click();
  for (const color of ["#000000", "#ffffff", "#808080", "#00ffff", "#ff00ff"]) {
    await page.locator("#native-background").selectOption(color);
    assert.equal(
      await page
        .locator(".native-canvas")
        .first()
        .evaluate((el) => el.style.backgroundColor),
      `rgb(${color
        .slice(1)
        .match(/../g)
        .map((n) => Number.parseInt(n, 16))
        .join(", ")})`,
    );
  }
  await page.locator("#native-background").selectOption("#101820");
  await page.locator("#native-roots").uncheck();
  await page.locator("#native-cards").screenshot({ path: `${output}/palettes-4x.png` });
  await page.locator("#native-zoom").selectOption("1");
  assert.equal(
    await page
      .locator(".native-canvas")
      .first()
      .evaluate((el) => el.getBoundingClientRect().width),
    64,
  );
  await page.locator("#native-cards").screenshot({ path: `${output}/palettes-1x.png` });
  await page.locator("#native-speed").selectOption("0.25");
  const start = Number(await page.locator("#native").getAttribute("data-tick"));
  await page.locator("#native-play").click();
  await page.waitForFunction(
    (startTick) => Number(document.querySelector("#native").dataset.tick) > startTick + 3,
    start,
  );
  await page.locator("#native-play").click();
  assert.deepEqual(errors, []);
  const footage = [];
  for (const speed of [1, 0.25]) {
    const context = await browser.newContext({
      viewport: { width: 768, height: 432 },
      recordVideo: { dir: `${output}/video`, size: { width: 768, height: 432 } },
    });
    const motion = await context.newPage();
    motion.on("pageerror", (error) => errors.push(String(error)));
    await motion.goto(`${base}/combat-lab.html`);
    await motion.locator("#native-operative").check();
    await motion.locator("#player-overlays").uncheck();
    await motion.locator("#speed").selectOption(String(speed));
    await motion.locator("#game").focus();
    await motion.keyboard.down("ArrowRight");
    await motion.keyboard.down("KeyZ");
    await motion.locator("#run").click();
    await motion.addStyleTag({
      content:
        "body{margin:0;padding:0}body>*:not(#game){visibility:hidden}#game{position:fixed;top:0;left:0;width:768px;outline:0}",
    });
    const endTick = speed === 1 ? 240 : 64;
    let held = "ArrowRight";
    for (let boundary = 24; boundary < endTick; boundary += 24) {
      await motion.waitForFunction((tick) => globalThis.combatLab.state().tick >= tick, boundary);
      await motion.keyboard.up(held);
      held = held === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
      await motion.keyboard.down(held);
    }
    await motion.waitForFunction((tick) => globalThis.combatLab.state().tick >= tick, endTick);
    await motion.keyboard.up(held);
    await motion.keyboard.up("KeyZ");
    const final = await motion.evaluate(() => globalThis.combatLab.state());
    assert.equal(final.players[0].life, "alive");
    assert(final.players[0].weapon.shotOrdinal > 1);
    const video = motion.video();
    await context.close();
    const file = `run-fire-${speed === 1 ? "normal" : "quarter"}.webm`;
    await video.saveAs(`${output}/${file}`);
    footage.push({
      file,
      speed,
      endTick: final.tick,
      shots: final.players[0].weapon.shotOrdinal,
      scope:
        "Real-time local inspector capture, repeated run/reverse/fire; no audio or network. Playwright video cadence is distinct from 60 Hz simulation.",
    });
  }
  for (const speed of [1, 0.25]) {
    const context = await browser.newContext({
      viewport: { width: 768, height: 432 },
      recordVideo: { dir: `${output}/video`, size: { width: 768, height: 432 } },
    });
    const movie = await context.newPage();
    movie.on("pageerror", (error) => errors.push(String(error)));
    await movie.goto(`${base}/combat-lab.html`);
    await movie.locator("#native-operative").check();
    await movie.locator("#player-overlays").uncheck();
    await movie.locator("#speed").selectOption(String(speed));
    await movie.addStyleTag({
      content:
        "body{margin:0;padding:0}body>*:not(#game){visibility:hidden}#game{position:fixed;top:0;left:0;width:768px;outline:0}",
    });
    const toggle = () => movie.locator("#run").evaluate((button) => button.click());
    const reset = async (scenario) => {
      await movie.locator("#scenario").evaluate((select, value) => {
        select.value = value;
        select.dispatchEvent(new Event("change"));
      }, scenario);
      await movie.locator("#game").focus();
    };
    const segments = [];
    await movie.locator("#game").focus();
    await movie.keyboard.down("ArrowRight");
    await movie.keyboard.press("KeyC");
    await toggle();
    await movie.waitForFunction(() => globalThis.combatLab.state().tick >= 25);
    await toggle();
    await movie.keyboard.up("ArrowRight");
    let world = await movie.evaluate(() => globalThis.combatLab.state());
    assert.equal(world.players[0].grenadeStock, 9);
    segments.push({ scenario: "range", action: "moving grenade", endTick: world.tick });
    await reset("range");
    await movie.keyboard.down("ArrowRight");
    await toggle();
    await movie.waitForFunction(() => {
      const world = globalThis.combatLab.state();
      return world.targets[0].enemy.body.x - world.players[0].body.x <= 22 * 256;
    });
    await movie.keyboard.up("ArrowRight");
    await movie.keyboard.press("KeyZ");
    await movie.waitForFunction(
      () => globalThis.combatLab.state().players[0].action.kind === "melee",
    );
    await movie.waitForFunction(
      () => globalThis.combatLab.state().players[0].action.kind === "ready",
    );
    await toggle();
    world = await movie.evaluate(() => globalThis.combatLab.state());
    assert.equal(world.players[0].weapon.shotOrdinal, 0);
    segments.push({ scenario: "range", action: "contextual knife", endTick: world.tick });
    await reset("rifle");
    await toggle();
    await movie.waitForFunction(() => globalThis.combatLab.state().players[0].life === "death");
    const diedAt = await movie.evaluate(
      () => globalThis.combatLab.state().players[0].lifeStartTick,
    );
    await movie.waitForFunction(
      () => globalThis.combatLab.state().players[0].life === "respawning",
    );
    await movie.waitForFunction(() => globalThis.combatLab.state().players[0].life === "alive");
    await toggle();
    world = await movie.evaluate(() => globalThis.combatLab.state());
    segments.push({
      scenario: "rifle",
      action: "death and reentry",
      deathStartTick: diedAt,
      endTick: world.tick,
    });
    const video = movie.video();
    await context.close();
    const file = `actions-${speed === 1 ? "normal" : "quarter"}.webm`;
    await video.saveAs(`${output}/${file}`);
    footage.push({
      file,
      speed,
      segments,
      scope:
        "Real-time local combat captures with explicit scenario resets between moving throw, contextual knife and enemy-caused death/reentry. No audio or network. Playwright captures 25 fps.",
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    `${output}/report.json`,
    `${JSON.stringify(
      {
        status: "pass",
        baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        browser: browser.version(),
        sourceSha256: atlas.meta.edgefall.sourceSha256,
        bundleSha256: createHash("sha256")
          .update(await readFile(`${root}/combat-lab.js`))
          .digest("hex"),
        captures,
        run,
        poses,
        transitions,
        actions,
        deathBodies,
        recordings,
        reviewedClips,
        replayMatches: true,
        paletteVariants: 4,
        reviewedRunFrames: 8,
        reviewBackgrounds: 5,
        footage,
        errors,
        humanReview: "pending",
        scope:
          "Native source and local rendering candidate. Pixel-exact facing/root checks, independent run/fire and cardinal muzzle release, local replay and palette review; real grenade/knife hand timing and full-body death/reentry priority; final animation quality, vehicle acting, other weapons/audio and multiplayer footage remain open.",
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify({
      status: "pass",
      output,
      runFrames: 8,
      poses: poses.length,
      humanReview: "pending",
    }),
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

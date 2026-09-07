import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

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
    await page.waitForFunction(
      () => globalThis.combatLab?.nativeFrames()[0]?.tick === globalThis.combatLab.state().tick,
    );
    return page.evaluate(() => ({
      state: globalThis.combatLab.state(),
      frames: globalThis.combatLab.nativeFrames(),
    }));
  };
  const surface = page.locator("#game"),
    canvas = surface.locator("canvas");
  const captures = [];
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
    for (const id of [drawing.legsFrame, drawing.upperFrame]) {
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
    assert(frame.legsFrame.includes("legs-run-"));
    run.push({
      tick,
      legs: frame.legsFrame,
      action: player.action.kind,
      actionStart: player.action.stateStartTick,
      shots: player.weapon.shotOrdinal,
    });
    if (!seen.has(frame.legsFrame)) {
      seen.add(frame.legsFrame);
      await canvas.screenshot({ path: `${output}/run-${seen.size - 1}.png` });
    }
  }
  await page.keyboard.up("ArrowRight");
  await page.keyboard.up("KeyZ");
  assert.equal(seen.size, 8);
  assert(
    new Set(run.filter((frame) => frame.action === "fire").map((frame) => frame.legs)).size > 1,
  );
  assert(run.at(-1).shots > 1);
  const poses = [];
  for (const [name, aim, jump, upper, legs] of [
    ["crouch", "ArrowDown", false, "upper-crouch", "legs-crouch"],
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
  const before = await read(),
    download = page.waitForEvent("download");
  await page.locator("#export").click();
  await (await download).saveAs(`${output}/recording.json`);
  await page.locator("#reset").click();
  await page.locator("#import").setInputFiles(`${output}/recording.json`);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("imported replay matches"),
  );
  assert.deepEqual(await read(), before);
  await page.locator("#player-overlays").check();
  await canvas.screenshot({ path: `${output}/air-down-debug.png` });
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
        replayMatches: true,
        paletteVariants: 4,
        reviewedRunFrames: 8,
        reviewBackgrounds: 5,
        footage,
        errors,
        humanReview: "pending",
        scope:
          "Native source and local rendering candidate. Pixel-exact facing/root checks, independent run/fire and cardinal muzzle release, local replay and palette review; final animation quality, other actions/weapons/audio and multiplayer footage remain open.",
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

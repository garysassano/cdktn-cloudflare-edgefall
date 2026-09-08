import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { canonical } from "../src/game/core/canonical.ts";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.ts";
import {
  CAST_ART,
  advanceCastMotion,
  initialCastMotion,
  tankPresentation,
} from "../src/shared/animation/cast.ts";
import { tankFeedback } from "../src/shared/animation/tank-feedback.ts";

const root = resolve("dist/client"),
  output = "dist/tank-feedback-evidence",
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  boundaries = [0, 12, 36, 37, 39, 43, 67, 109, 110, 112, 116, 120, 140, 150, 182, 183, 195];
await mkdir(output, { recursive: true });
const states = [createCombatLab("tank", 4)],
  motions = [initialCastMotion(states[0])],
  commands = [];
for (let tick = 1; tick <= 196; tick++) {
  const input = states[tick - 1].players.map(() => ({
    held: 0,
    jumpPressed: false,
    firePressed: false,
    grenadePressed: false,
    interactPressed: tick === 1,
    specialPressed: false,
  }));
  const next = stepCombatLab(states[tick - 1], input);
  commands.push(input);
  states.push(next);
  motions.push(advanceCastMotion(states[tick - 1], next, motions[tick - 1]));
}
const recording = (tick) => ({
  format: 16,
  scenario: "tank",
  players: 4,
  commands: commands.slice(0, tick),
  finalState: canonical(states[tick]),
});
await writeFile(`${output}/recording.json`, `${JSON.stringify(recording(196), null, 2)}\n`);
const atlases = new Map(),
  images = new Map();
for (const asset of [...CAST_ART, { id: "operative", directory: "hero" }]) {
  const path = `${root}/assets/art/${asset.directory}/${asset.id}`;
  atlases.set(asset.id, JSON.parse(await readFile(`${path}.atlas.json`, "utf8")));
  images.set(
    asset.id,
    await sharp(`${path}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  );
}
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error("Outside fixture root");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".json": "application/json",
        ".png": "image/png",
        ".ogg": "audio/ogg",
      }[extname(path)] ?? "application/octet-stream",
    );
    response.end(await readFile(path));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const report = {
  scope:
    "Four-player accepted input replay, native hull pixels, critical HUD without collision overlays, normal/quarter-speed recordings and checkpoint import without historical sound. Engineering modulation of existing media; human art/audio acceptance and network audio remain open.",
  bundleSha256: hash(await readFile(`${root}/combat-lab.js`)),
  browserAudioOutput:
    "Chromium --disable-audio-output; decoded sample playback and MediaRecorder are active, physical output is unverified.",
  captures: [],
  movies: [],
};
const browser = await chromium.launch({
  executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
  args: ["--disable-audio-output"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 1300 } }),
    errors = [];
  report.browser = browser.version();
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/combat-lab.html?cast=1`);
  await page.waitForFunction(() => Boolean(globalThis.combatLab?.castFrames().length));
  await page.locator("#native-operative").check();
  await page.locator("#player-overlays").uncheck();
  await page.locator("#cast-overlays").uncheck();
  await page.locator("#cast-audio").check();
  await page.waitForFunction(() => globalThis.combatLab.audio().ready);
  const importTick = async (tick) => {
    await page.locator("#import").setInputFiles({
      name: `damage-${tick}.json`,
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(recording(tick))),
    });
    await page.waitForFunction(
      (tick) =>
        globalThis.combatLab.state().tick === tick &&
        document.querySelector("#status").textContent.includes("imported replay matches"),
      tick,
    );
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    const actual = await page.evaluate(() => ({
      state: globalThis.combatLab.state(),
      frames: globalThis.combatLab.castFrames(),
      hero: globalThis.combatLab.nativeFrames(),
      audio: globalThis.combatLab.audio(),
    }));
    assert.equal(canonical(actual.state), canonical(states[tick]));
    assert.deepEqual(actual.audio.cues, [], "Import replayed historical damage");
    return actual;
  };
  for (const tick of boundaries) {
    const actual = await importTick(tick),
      tank = states[tick].tanks[3],
      feedback = tankFeedback(tank, tick);
    const expectedFrames = states[tick].tanks.flatMap((tank, index) =>
      tankPresentation(
        tank,
        tick,
        atlases.get("kestrel"),
        motions[tick].tanks[index],
        states[tick].players.find(
          (player) => player.playerId === (tank.occupantId ?? tank.reservedBy),
        )?.slot ?? 0,
      ),
    );
    assert.deepEqual(
      actual.frames.filter((frame) => frame.texture === "kestrel"),
      expectedFrames,
    );
    const file = `damage-${tick}.png`,
      png = await page.locator("#game canvas").screenshot({ path: `${output}/${file}` }),
      bitmap = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      scale = bitmap.info.width / 384,
      expected = Buffer.alloc(384 * 216 * 4);
    assert(Number.isInteger(scale));
    // Independent atlas composition checks the pixels rendered by Phaser, including fill-vs-multiply reset.
    const layers = [...actual.frames];
    for (const hero of actual.hero.filter(Boolean))
      for (const frame of [hero.legsFrame, hero.upperFrame, hero.fullBodyFrame].filter(Boolean))
        layers.push({ ...hero, texture: "operative", frame });
    for (const drawing of layers) {
      const atlas = atlases.get(drawing.texture),
        image = images.get(drawing.texture),
        frame = atlas.frames[drawing.frame].frame,
        [rootX, rootY] = atlas.meta.edgefall.root;
      for (let y = 0; y < frame.h; y++)
        for (let x = 0; x < frame.w; x++) {
          const from = ((frame.y + y) * image.info.width + frame.x + x) * 4,
            worldX = drawing.x + (drawing.flipX ? rootX - 1 - x : x - rootX),
            worldY = drawing.y + y - rootY;
          if (!image.data[from + 3] || worldX < 0 || worldX >= 384 || worldY < 0 || worldY >= 216)
            continue;
          const to = (worldY * 384 + worldX) * 4;
          image.data.copy(expected, to, from, from + 4);
          if (drawing.tint !== undefined)
            for (let channel = 0; channel < 3; channel++) {
              const color = (drawing.tint >> (16 - channel * 8)) & 255;
              expected[to + channel] = drawing.tintFill
                ? color
                : Math.round((image.data[from + channel] * color) / 255);
            }
        }
    }
    let pixels = 0;
    for (let y = 176; y < 200; y++)
      for (let x = 204; x < 253; x++) {
        const from = (y * 384 + x) * 4;
        if (!expected[from + 3]) continue;
        if (
          actual.state.events.some(
            (event) =>
              ["impact", "muzzle-blocked", "explosion"].includes(event.kind) &&
              Math.abs(x - event.position.x / 256) <= 4 &&
              Math.abs(y - event.position.y / 256) <= 4,
          )
        )
          continue;
        if (
          actual.state.projectiles.some((projectile) => {
            const ax = projectile.position.x / 256,
              ay = projectile.position.y / 256,
              bx = ax - projectile.velocity.x / 256,
              by = ay - projectile.velocity.y / 256;
            return (
              x >= Math.min(ax, bx) - 2 &&
              x <= Math.max(ax, bx) + 2 &&
              y >= Math.min(ay, by) - 2 &&
              y <= Math.max(ay, by) + 2
            );
          })
        )
          continue;
        const to = ((y * scale + 1) * bitmap.info.width + x * scale + 1) * 4;
        for (let channel = 0; channel < 4; channel++)
          assert(
            Math.abs(bitmap.data[to + channel] - expected[from + channel]) <= 1,
            `Tick ${tick}: wrong rendered hull pixel ${x},${y}, channel ${channel}`,
          );
        pixels++;
      }
    assert(pixels > 150, "Missing rendered hull coverage");
    const warningPixel = (135 * scale * bitmap.info.width + 202 * scale) * 4;
    const warning = bitmap.data.subarray(warningPixel, warningPixel + 3).toString("hex");
    assert.equal(
      warning,
      feedback.critical ? (feedback.warningBright ? "ffdb75" : "ff785d") : "0b1018",
      `Tick ${tick}: missing or stale critical HUD`,
    );
    report.captures.push({
      tick,
      feedback,
      pixels,
      warning,
      file,
      bytes: png.length,
      sha256: hash(png),
    });
  }
  for (const speed of ["1", "0.25"]) {
    await importTick(196);
    await page.locator("#speed").selectOption(speed);
    await page.evaluate(() => globalThis.combatLab.startVideoCapture());
    await page.locator("#play-recording").click();
    await page.waitForFunction(
      () => globalThis.combatLab.state().tick === 196 && !globalThis.combatLab.running(),
      undefined,
      { timeout: 30000 },
    );
    const final = await page.evaluate(async () => ({
      state: globalThis.combatLab.state(),
      audio: globalThis.combatLab.audio(),
      bytes: [
        ...new Uint8Array(await (await globalThis.combatLab.stopAudioCapture()).arrayBuffer()),
      ],
    }));
    assert.equal(canonical(final.state), canonical(states[196]));
    assert.deepEqual(
      final.audio.cues.filter((cue) => cue.kind === "tank-hit").map((cue) => cue.tick),
      [37, 110, 183],
    );
    assert.equal(final.audio.cues.filter((cue) => cue.kind === "eject").length, 1);
    assert.equal(final.audio.criticalDropped, 0);
    const file = speed === "1" ? "damage-normal.webm" : "damage-quarter.webm",
      bytes = Buffer.from(final.bytes);
    await writeFile(`${output}/${file}`, bytes);
    report.movies.push({
      speed: Number(speed),
      tick: final.state.tick,
      audio: final.audio,
      file,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  }
  assert.deepEqual(errors, []);
  report.status = "pass";
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      captures: report.captures.length,
      pixels: report.captures.reduce((sum, capture) => sum + capture.pixels, 0),
      movies: report.movies.length,
      bundleSha256: report.bundleSha256,
    }),
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

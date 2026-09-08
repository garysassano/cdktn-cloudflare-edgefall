import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { areaExposures } from "../src/game/combat/area-attack.ts";
import { canonical } from "../src/game/core/canonical.ts";
import { Held } from "../src/game/input/types.ts";
import { combatTerrain, createCombatLab, stepCombatLab } from "../src/game/labs/combat.ts";
import { AREA_PROFILES } from "../src/game/labs/combat-content.ts";
import { operativePresentation } from "../src/shared/animation/operative.ts";
import {
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../src/shared/animation/operative-motion.ts";

const airStudy = process.argv.includes("--air"),
  output = airStudy ? "dist/operative-air-evidence" : "dist/operative-aim-evidence",
  root = resolve("dist/client"),
  hash = (b) => createHash("sha256").update(b).digest("hex");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const atlas = JSON.parse(await readFile(`${root}/assets/art/hero/operative.atlas.json`, "utf8"));
const image = await sharp(`${root}/assets/art/hero/operative.png`)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const changed = Object.keys(atlas.meta.edgefall.drawings).filter((id) =>
  (airStudy
    ? /^legs-(launch|rise|apex|fall|impact)-|^upper-impact-/
    : /^upper-(up|down)(-|$)|^upper-(shotgun|flame)-(up|down)(-|$)|^upper-hmg-(15|16|20[0-5])(-|$)/
  ).test(id),
);
assert.equal(changed.length, airStudy ? 28 : 34);
const scenes = ["range", "hmg", "shotgun", "flame"].flatMap((scenario) =>
  [-1, 1].map((facing) => ({
    scenario,
    facing,
    // The flame fixture contains a live rifleman. End its visual study before
    // his next burst rather than changing enemy rules or granting invulnerability.
    ticks: airStudy ? 120 : scenario === "flame" ? 72 : 180,
    id: `${scenario}-${facing < 0 ? "left" : "right"}`,
  })),
);
const keysFor = (scene, t) =>
  t === 1
    ? scene.facing < 0
      ? ["ArrowLeft"]
      : []
    : airStudy
      ? [...(t === 2 || t === 62 ? ["Space"] : []), ...(t >= 62 && t <= 116 ? ["KeyZ"] : [])]
      : [
          "KeyZ",
          ...(t <= 34 || (t >= 66 && t <= 91) || t >= 152 ? ["ArrowUp"] : []),
          ...((t >= 36 && t <= 65) || (t >= 100 && t <= 111) || (t >= 123 && t <= 151)
            ? ["ArrowDown"]
            : []),
          ...(t === 36 || t === 123 ? ["Space"] : []),
          ...(t >= 92 && t <= 99 ? [scene.facing < 0 ? "ArrowLeft" : "ArrowRight"] : []),
        ];
const command = (wanted, held) => ({
  held: [...wanted].reduce(
    (n, k) =>
      n |
      ({
        ArrowRight: Held.Right,
        ArrowLeft: Held.Left,
        ArrowUp: Held.Up,
        ArrowDown: Held.Down,
        KeyZ: Held.Fire,
      }[k] ?? 0),
    0,
  ),
  jumpPressed: wanted.has("Space") && !held.has("Space"),
  firePressed: wanted.has("KeyZ") && !held.has("KeyZ"),
  grenadePressed: false,
  specialPressed: false,
  interactPressed: false,
});
const server = createServer(async (req, res) => {
  try {
    const p = resolve(root, `.${new URL(req.url, "http://localhost").pathname}`);
    if (!p.startsWith(`${root}/`)) throw Error("Outside fixture");
    res.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".png": "image/png",
        ".json": "application/json",
        ".ogg": "audio/ogg",
      }[extname(p)] ?? "application/octet-stream",
    );
    res.end(await readFile(p));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const report = {
  status: "running",
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceSha256: atlas.meta.edgefall.sourceSha256,
  clientSha256: hash(await readFile(`${root}/combat-lab.js`)),
  changed,
  study: airStudy ? "air-and-landing" : "aim-and-recoil",
  runs: [],
  captures: [],
  videos: [],
  scope: airStudy
    ? "Input-only neutral and firing jumps, airborne phases and heavy landing in the actual local browser renderer. Light landing, ceiling, coyote, buffered jump and cancellation physics have separate targeted tests. This is not human style/listening approval or continuous mission acceptance."
    : "Input-only firearm aim and recoil in the actual local browser renderer. This comparison is separate from continuous mission footage and does not establish human style or listening approval.",
  browserAudioOutput:
    "Chromium --disable-audio-output; WebAudio and MediaRecorder active. No physical-device output claim.",
};
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
    args: ["--disable-audio-output"],
  });
  report.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1240, height: 1180 } }),
    errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`http://127.0.0.1:${server.address().port}/combat-lab.html`);
  await page.locator("#native-operative").check();
  await page.locator("#player-overlays").uncheck();
  await page.locator("#cast-audio").check();
  await page.waitForFunction(() => globalThis.combatLab.audio().ready);
  const canvas = page.locator("#game canvas"),
    read = async () => {
      await page.evaluate(
        () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
      );
      return page.evaluate(() => ({
        state: globalThis.combatLab.state(),
        frames: globalThis.combatLab.nativeFrames(),
        audio: globalThis.combatLab.audio(),
      }));
    };
  const pixelCheck = async (label, observed) => {
    const shot = await canvas.screenshot({ path: `${output}/${label}.png` }),
      actual = await sharp(shot).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      scale = actual.info.width / 384,
      drawing = observed.frames[0];
    assert(Number.isInteger(scale));
    const expected = Buffer.alloc(64 * 64 * 4);
    for (const id of [drawing.legsFrame, drawing.upperFrame]) {
      const f = atlas.frames[id].frame;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const from = ((f.y + y) * image.info.width + f.x + x) * 4;
          if (image.data[from + 3]) image.data.copy(expected, (y * 64 + x) * 4, from, from + 4);
        }
    }
    let pixels = 0,
      occluded = 0;
    const areas = observed.state.areas.flatMap((area) =>
      areaExposures(
        area,
        observed.state.tick,
        AREA_PROFILES.get(area.definitionId),
        combatTerrain(observed.state.scenario, observed.state.tick, observed.state.props),
      ).map((exposure) => exposure.rect),
    );
    for (let y = 0; y < 64; y++)
      for (let x = 0; x < 64; x++) {
        const from = (y * 64 + x) * 4;
        if (!expected[from + 3]) continue;
        const wx = drawing.x + (drawing.flipX ? 23 - x : x - 24),
          wy = drawing.y + y - 48;
        if (wx < 0 || wx >= 384 || wy < 0 || wy >= 200) continue;
        // Inspector projectile trails and area exposures intentionally overlay the sprite.
        // Check every remaining opaque source pixel, recording the excluded count.
        if (
          areas.some(
            (r) =>
              wx >= r.x / 256 - 1 &&
              wx <= (r.x + r.w) / 256 + 1 &&
              wy >= r.y / 256 - 1 &&
              wy <= (r.y + r.h) / 256 + 1,
          ) ||
          observed.state.projectiles.some((p) => {
            const ax = p.position.x / 256,
              ay = p.position.y / 256,
              bx = ax - p.velocity.x / 256,
              by = ay - p.velocity.y / 256;
            return (
              wx >= Math.min(ax, bx) - 2 &&
              wx <= Math.max(ax, bx) + 2 &&
              wy >= Math.min(ay, by) - 2 &&
              wy <= Math.max(ay, by) + 2
            );
          })
        ) {
          occluded++;
          continue;
        }
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const to = ((wy * scale + dy) * actual.info.width + wx * scale + dx) * 4;
            assert.equal(
              actual.data.subarray(to, to + 4).toString("hex"),
              expected.subarray(from, from + 4).toString("hex"),
              `${label}: pixel ${x},${y}`,
            );
          }
        pixels++;
      }
    assert(pixels > 250);
    report.captures.push({
      label,
      tick: observed.state.tick,
      upper: drawing.upperFrame,
      legs: drawing.legsFrame,
      pixels,
      occluded,
      sha256: hash(shot),
    });
  };
  for (const scene of scenes) {
    await page.locator("#scenario").selectOption(scene.scenario);
    await page.locator("#players").selectOption("1");
    await page.locator("#reset").click();
    await page.locator("#game").focus();
    let state = createCombatLab(scene.scenario, 1),
      motion = initialOperativeMotion(state.players[0], 0);
    const held = new Set(),
      seen = new Set(),
      trace = [],
      releases = [];
    for (let t = 1; t <= scene.ticks; t++) {
      const wanted = new Set(keysFor(scene, t)),
        input = command(wanted, held);
      for (const k of held)
        if (!wanted.has(k)) {
          await page.keyboard.up(k);
          held.delete(k);
        }
      for (const k of wanted)
        if (!held.has(k)) {
          await page.keyboard.down(k);
          held.add(k);
        }
      const next = stepCombatLab(state, [input]);
      motion = advanceOperativeMotion(state.players[0], next.players[0], motion, t, atlas);
      state = next;
      const frame = operativePresentation(state.players[0], t, atlas, motion);
      await page.keyboard.press("Enter");
      const observed = await read();
      assert.deepEqual(observed.state, state, `${scene.id}: world ${t}`);
      assert.deepEqual(observed.frames[0], frame, `${scene.id}: drawing ${t}`);
      for (const event of state.events.filter(
        (e) => e.kind === "shot" && e.ownerId === state.players[0].playerId,
      )) {
        assert.equal(frame.muzzle.x, Math.round(event.position.x / 256));
        assert.equal(frame.muzzle.y, Math.round(event.position.y / 256));
        releases.push({ tick: t, timelineId: frame.timelineId, muzzle: frame.muzzle });
      }
      assert.equal(state.players[0].life, "alive", `${scene.id}: actor died at ${t}`);
      for (const frameName of [frame.upperFrame, ...(airStudy ? [frame.legsFrame] : [])]) {
        const id = frameName.slice(3);
        if (changed.includes(id) && !seen.has(id)) {
          await pixelCheck(`${scene.id}-${id}`, observed);
          seen.add(id);
        }
      }
      trace.push({ tick: t, worldSha256: hash(canonical(state)), frame });
    }
    for (const k of held) await page.keyboard.up(k);
    const before = await read(),
      recording = await page.evaluate(() => globalThis.combatLab.recording());
    await writeFile(
      `${output}/${scene.id}.recording.json`,
      `${JSON.stringify(recording, null, 2)}\n`,
    );
    await writeFile(`${output}/${scene.id}.trace.json`, `${JSON.stringify(trace, null, 2)}\n`);
    await page.locator("#reset").click();
    await page.locator("#import").setInputFiles(`${output}/${scene.id}.recording.json`);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("imported replay matches"),
    );
    const restored = await read();
    assert.deepEqual(restored.state, before.state);
    assert.deepEqual(restored.frames, before.frames);
    report.runs.push({ ...scene, releases, seen: [...seen].sort(), restored: true });
    console.log(
      JSON.stringify({
        scene: scene.id,
        boundaries: scene.ticks,
        seen: seen.size,
        releases: releases.length,
      }),
    );
    if (scene.facing > 0 && !process.argv.includes("--no-videos"))
      for (const speed of [1, 0.25]) {
        await page.locator("#speed").selectOption(String(speed));
        await page.evaluate(() => globalThis.combatLab.startVideoCapture());
        await page.locator("#play-recording").click();
        await page.waitForFunction(
          () => document.querySelector("#status").textContent.includes("playback complete"),
          {},
          { timeout: 30000 },
        );
        const after = await read();
        assert.deepEqual(after.state, before.state);
        assert.deepEqual(after.frames, before.frames);
        assert.equal(after.audio.dropped, 0);
        const bytes = await page.evaluate(async () =>
            Array.from(
              new Uint8Array(await (await globalThis.combatLab.stopAudioCapture()).arrayBuffer()),
            ),
          ),
          name = `${scene.scenario}-${speed === 1 ? "normal" : "quarter"}`,
          webm = `${output}/${name}.webm`,
          mp4 = `${output}/${name}.mp4`;
        await writeFile(webm, Buffer.from(bytes));
        execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-y",
            "-i",
            webm,
            "-vf",
            "scale=1536:864:flags=neighbor",
            "-c:v",
            "libx264",
            "-preset",
            "fast",
            "-crf",
            "16",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            mp4,
          ],
          { timeout: 30000 },
        );
        const audit = spawnSync(
            "ffmpeg",
            [
              "-hide_banner",
              "-nostats",
              "-i",
              mp4,
              "-af",
              "astats=reset=0",
              "-vn",
              "-f",
              "null",
              "-",
            ],
            { encoding: "utf8" },
          ),
          peakDb = [...audit.stderr.matchAll(/Peak level dB: ([-.\d]+)/g)].map((m) => Number(m[1]));
        assert.equal(audit.status, 0);
        assert.equal(peakDb.length, 3);
        assert(peakDb.every((v) => v < 20 * Math.log10(0.99)));
        const duration = Number(
          execFileSync(
            "ffprobe",
            ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", mp4],
            { encoding: "utf8" },
          ),
        );
        assert(Math.abs(duration - scene.ticks / 60 / speed) < 1);
        report.videos.push({
          name,
          speed,
          duration,
          peakDb,
          sha256: hash(await readFile(mp4)),
          audio: after.audio,
        });
      }
  }
  for (const facing of [-1, 1]) {
    const seen = new Set(report.runs.filter((r) => r.facing === facing).flatMap((r) => r.seen));
    assert.deepEqual(
      [...seen].sort(),
      changed.toSorted(),
      `Missing changed drawings facing ${facing}`,
    );
  }
  assert.deepEqual(errors, []);
  report.status = "pass";
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      runs: report.runs.length,
      captures: report.captures.length,
      videos: report.videos.length,
    }),
  );
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

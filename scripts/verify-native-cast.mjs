import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { Held } from "../src/game/input/types.ts";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.ts";
import { GRENADE_PROFILE } from "../src/game/labs/combat-content.ts";
import {
  CAST_ART,
  advanceCastMotion,
  enemyPresentation,
  initialCastMotion,
  tankPresentation,
} from "../src/shared/animation/cast.ts";
import { combatAudioCues, operativeFootfalls } from "../src/shared/animation/combat-audio.ts";
import {
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../src/shared/animation/operative-motion.ts";

import { kestrelProofKeys } from "../test/fixtures/kestrel-proof.ts";

const root = resolve("dist/client"),
  output = "dist/native-cast-evidence";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
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
// Review sheets keep every source pixel and show all unique drawings on light and dark grounds.
for (const asset of CAST_ART) {
  const atlas = atlases.get(asset.id),
    image = images.get(asset.id),
    variant = asset.id === "kestrel" ? "p1" : "base",
    frames = Object.entries(atlas.frames).filter(([name]) => name.startsWith(`${variant}/`)),
    size = frames[0][1].sourceSize.w,
    cell = size + 8,
    width = cell * 8,
    height = Math.ceil(frames.length / 8) * (cell + 12);
  for (const [theme, background, color] of [
    ["dark", "#0b1018", "#edf2f7"],
    ["light", "#e4ecf0", "#131b27"],
  ]) {
    const layers = [],
      labels = [];
    for (const [i, [name, metadata]] of frames.entries()) {
      const left = (i % 8) * cell + 4,
        top = Math.floor(i / 8) * (cell + 12) + 4;
      layers.push({
        input: await sharp(image.data, { raw: image.info })
          .extract({ left: metadata.frame.x, top: metadata.frame.y, width: size, height: size })
          .png()
          .toBuffer(),
        left,
        top,
      });
      labels.push(
        `<text x="${left}" y="${top + size + 9}">${name.split("/")[1].replace(/^(watch|breakwater|kestrel)-/, "")}</text>`,
      );
    }
    layers.push({
      input: Buffer.from(
        `<svg width="${width}" height="${height}"><g fill="${color}" font-family="monospace" font-size="8">${labels.join("")}</g></svg>`,
      ),
      left: 0,
      top: 0,
    });
    const png = await sharp({ create: { width, height, channels: 4, background } })
      .composite(layers)
      .png()
      .toBuffer();
    await writeFile(`${output}/${asset.id}-${theme}-1x.png`, png);
    await sharp(png)
      .resize(width * 4, height * 4, { kernel: "nearest" })
      .png()
      .toFile(`${output}/${asset.id}-${theme}-4x.png`);
  }
}
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error("Outside fixture");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".png": "image/png",
        ".json": "application/json",
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
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const report = {
  status: "pass",
  sourceSha256: atlases.get("kestrel").meta.edgefall.sourceSha256,
  clientSha256: hash(await readFile(`${root}/combat-lab.js`)),
  captures: [],
  runs: [],
  videos: [],
  scope:
    "Original cast and licensed sound mix in separate local diagnostic scenes. Not the continuous W06 mission benchmark or a human approval.",
  browserAudioOutput:
    "Chromium --disable-audio-output; WebAudio and MediaRecorder are active. Physical-device output remains unverified.",
};
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
    args: ["--disable-audio-output"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } }),
    errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/combat-lab.html?cast=1`);
  await page.waitForFunction(() => globalThis.combatLab?.castFrames().length > 0);
  await page.locator("#cast-audio").check();
  await page.waitForFunction(() => globalThis.combatLab.audio().ready);
  assert.equal(await page.locator("#audio-status").textContent(), "Sound ready");
  const read = async () => {
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    return page.evaluate(() => ({
      state: globalThis.combatLab.state(),
      frames: globalThis.combatLab.castFrames(),
      hero: globalThis.combatLab.nativeFrames(),
      audio: globalThis.combatLab.audio(),
    }));
  };
  const canvas = page.locator("#game canvas");
  const pixelCheck = async (label) => {
    const world = await read(),
      png = await canvas.screenshot({ path: `${output}/${label}.png` }),
      actual = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
      expected = Buffer.alloc(384 * 216 * 4),
      scale = actual.info.width / 384;
    assert(Number.isInteger(scale));
    const layers = [...world.frames];
    for (const hero of world.hero.filter(Boolean))
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
          if (!image.data[from + 3] || worldX < 0 || worldX >= 384 || worldY < 0 || worldY >= 200)
            continue;
          image.data.copy(expected, (worldY * 384 + worldX) * 4, from, from + 4);
        }
    }
    let pixels = 0;
    for (let y = 0; y < 200; y++)
      for (let x = 0; x < 384; x++) {
        if (
          world.state.events.some((e) => {
            if (e.kind !== "impact" && e.kind !== "muzzle-blocked" && e.kind !== "explosion")
              return false;
            const radius = e.kind === "explosion" ? GRENADE_PROFILE.radius / 256 + 1 : 4;
            return (
              Math.abs(x - e.position.x / 256) <= radius &&
              Math.abs(y - e.position.y / 256) <= radius
            );
          })
        )
          continue;
        // The inspector deliberately draws live projectiles over sprites. Their swept
        // diagnostic lines are checked by the combat harness, not as source-art pixels.
        if (
          world.state.projectiles.some((p) => {
            const ax = p.position.x / 256,
              ay = p.position.y / 256,
              bx = ax - p.velocity.x / 256,
              by = ay - p.velocity.y / 256;
            return (
              x >= Math.min(ax, bx) - 2 &&
              x <= Math.max(ax, bx) + 2 &&
              y >= Math.min(ay, by) - 2 &&
              y <= Math.max(ay, by) + 2
            );
          })
        )
          continue;
        const from = (y * 384 + x) * 4;
        if (!expected[from + 3]) continue;
        for (let dy = 0; dy < scale; dy++)
          for (let dx = 0; dx < scale; dx++) {
            const to = ((y * scale + dy) * actual.info.width + x * scale + dx) * 4;
            assert.equal(
              actual.data.subarray(to, to + 4).toString("hex"),
              expected.subarray(from, from + 4).toString("hex"),
              `${label}: native world pixel ${x},${y}`,
            );
          }
        pixels++;
      }
    assert(pixels > 500);
    report.captures.push({ label, tick: world.state.tick, pixels, frames: world.frames });
  };
  const expectedFrames = (state, motion) => [
    ...state.tanks.flatMap((tank) =>
      tankPresentation(
        tank,
        state.tick,
        atlases.get("kestrel"),
        motion.tanks.find((c) => c.id === tank.body.id),
        state.players.find((p) => p.playerId === (tank.occupantId ?? tank.reservedBy))?.slot ?? 0,
      ),
    ),
    ...state.targets
      .map((target) =>
        enemyPresentation(
          target,
          state,
          atlases.get(target.guard || target.shield ? "breakwater" : "quay-watch"),
          motion.enemies.find((c) => c.id === target.enemy.body.id).strideQ,
        ),
      )
      .filter(Boolean),
  ];
  const cases = [
    {
      id: "rifle",
      scenario: "rifle",
      players: 1,
      ticks: 84,
      keys: () => ["ArrowDown"],
      captures: [0, 24, 31],
    },
    {
      id: "guard",
      scenario: "guard",
      players: 1,
      ticks: 131,
      keys: (t) => [
        ...(t <= 5 || t >= 57 ? ["ArrowDown"] : ["ArrowRight"]),
        ...(t === 1 ? ["KeyC"] : []),
        ...(t === 24 ? ["Space"] : []),
      ],
      captures: [0, 34, 95],
      video: true,
    },
    {
      id: "tank",
      scenario: "tank",
      players: 1,
      ticks: 120,
      keys: (t) => [
        ...(t === 1 || t === 90 ? ["KeyE"] : []),
        ...(t >= 13 && t <= 26 ? ["ArrowRight"] : []),
        ...(t >= 15 && t <= 21 ? ["ArrowUp"] : []),
        ...(t === 15 ? ["Space"] : []),
        ...(t >= 60 && t <= 74 ? ["KeyZ"] : []),
      ],
      captures: [0, 1, 3, 5, 7, 8, 9, 10, 12, 21, 90, 91, 92, 93, 94, 95, 96, 97],
      video: true,
    },
    {
      id: "four-players",
      scenario: "range",
      players: 4,
      ticks: 120,
      keys: (t) => [...(t <= 24 ? ["ArrowRight"] : []), ...(t <= 80 ? ["KeyZ"] : [])],
      captures: [],
      assist: true,
    },
  ];
  cases.push(
    ...[false, true].map((mirror) => ({
      id: `kestrel-${mirror ? "left" : "right"}`,
      scenario: "tank",
      players: 1,
      ticks: 180,
      keys: (t) => kestrelProofKeys(t, mirror),
      captures: [],
      video: true,
      study: true,
    })),
  );
  for (const scene of cases) {
    await page.locator("#scenario").selectOption(scene.scenario);
    await page.locator("#players").selectOption(String(scene.players));
    await page.locator("#assist").setChecked(Boolean(scene.assist));
    await page.locator("#reset").click();
    await page.locator("#game").focus();
    let state = createCombatLab(scene.scenario, scene.players),
      motion = initialCastMotion(state),
      heroMotion = state.players.map((p) => initialOperativeMotion(p, state.tick));
    const held = new Set(),
      cues = [],
      trace = [],
      seen = new Set(),
      releases = [];
    if (scene.captures.includes(0)) await pixelCheck(`${scene.id}-0`);
    for (let tick = 1; tick <= scene.ticks; tick++) {
      const wanted = new Set(scene.keys(tick)),
        pressed = new Set([...wanted].filter((k) => !held.has(k)));
      for (const key of held)
        if (!wanted.has(key)) {
          await page.keyboard.up(key);
          held.delete(key);
        }
      for (const key of wanted)
        if (!held.has(key)) {
          await page.keyboard.down(key);
          held.add(key);
        }
      const mask = [...wanted].reduce(
          (n, key) =>
            n |
            ({
              ArrowRight: Held.Right,
              ArrowLeft: Held.Left,
              ArrowUp: Held.Up,
              ArrowDown: Held.Down,
              KeyZ: Held.Fire,
            }[key] ?? 0),
          0,
        ),
        inputs = state.players.map((_, slot) => ({
          held: slot === 0 ? mask : scene.assist ? Held.Fire : 0,
          jumpPressed: slot === 0 && pressed.has("Space"),
          firePressed: slot === 0 && pressed.has("KeyZ"),
          grenadePressed: slot === 0 && pressed.has("KeyC"),
          interactPressed: slot === 0 && pressed.has("KeyE"),
        })),
        next = stepCombatLab(state, inputs);
      motion = advanceCastMotion(state, next, motion);
      heroMotion = next.players.map((p, i) =>
        advanceOperativeMotion(
          state.players[i],
          p,
          heroMotion[i],
          next.tick,
          atlases.get("operative"),
        ),
      );
      cues.push(
        ...combatAudioCues(state, next, operativeFootfalls(heroMotion, atlases.get("operative"))),
      );
      state = next;
      await page.keyboard.press("Enter");
      const observed = await read();
      assert.deepEqual(observed.state, state, `${scene.id}: Node/browser world at ${tick}`);
      assert.deepEqual(
        observed.frames,
        expectedFrames(state, motion),
        `${scene.id}: accepted cast frames at ${tick}`,
      );
      assert.deepEqual(observed.audio.cues, cues, `${scene.id}: sound intents at ${tick}`);
      assert.equal(observed.audio.dropped, 0);
      assert(observed.audio.activeVoices <= observed.audio.voiceBudget);
      for (const event of state.events.filter(
        (e) => e.kind === "shot" && e.source?.definitionId === 16,
      )) {
        const tank = state.tanks.find((t) => t.occupantId === event.ownerId);
        assert(tank);
        const turret = expectedFrames(state, motion).find(
          (f) => f.frame === `p1/kestrel-turret-${tank.heading}`,
        );
        assert(turret);
        const muzzle =
          atlases.get("kestrel").meta.edgefall.drawings[`kestrel-turret-${tank.heading}`].sockets
            .muzzle;
        assert.deepEqual(event.position, {
          x: tank.body.x + muzzle[0] * 256,
          y: tank.body.y + muzzle[1] * 256,
        });
        releases.push({ tick, heading: tank.heading, position: event.position });
      }
      const fresh = observed.frames.some((f) => f.texture === "kestrel" && !seen.has(f.frame));
      for (const frame of observed.frames.filter((f) => f.texture === "kestrel"))
        seen.add(frame.frame);
      trace.push({
        tick,
        motion,
        frames: observed.frames,
        events: state.events,
        cues: cues.filter((c) => c.tick === tick),
      });
      if (scene.captures.includes(tick) || (scene.study && fresh))
        await pixelCheck(`${scene.id}-${tick}`);
    }
    for (const key of held) await page.keyboard.up(key);
    const before = await read(),
      recording = await page.evaluate(() => globalThis.combatLab.recording());
    await writeFile(
      `${output}/${scene.id}-recording.json`,
      `${JSON.stringify(recording, null, 2)}\n`,
    );
    await writeFile(`${output}/${scene.id}-trace.json`, `${JSON.stringify(trace, null, 2)}\n`);
    await page.locator("#replay").click();
    const restored = await read();
    assert.deepEqual(restored.state, before.state);
    assert.deepEqual(restored.frames, before.frames);
    assert.deepEqual(restored.audio.cues, []);
    assert.equal(restored.audio.activeVoices, 0);
    await page.locator("#reset").click();
    await page.locator("#import").setInputFiles(`${output}/${scene.id}-recording.json`);
    await page.waitForFunction(() =>
      document.querySelector("#status").textContent.includes("imported replay matches"),
    );
    const imported = await read();
    assert.deepEqual(imported.state, before.state);
    assert.deepEqual(imported.frames, before.frames);
    assert.deepEqual(imported.audio.cues, []);
    report.runs.push({
      id: scene.id,
      ticks: scene.ticks,
      players: scene.players,
      cues: cues.length,
      kinds: [...new Set(cues.map((c) => c.kind))].sort(),
      restored: true,
      seen: [...seen].sort(),
      releases,
    });
    if (scene.video)
      for (const [label, speed, debug] of [
        ["clean-normal", "1", false],
        ["debug-normal", "1", true],
        ["clean-quarter", "0.25", false],
      ]) {
        await page.locator("#speed").selectOption(speed);
        await page.locator("#player-overlays").setChecked(debug);
        await page.locator("#cast-overlays").setChecked(debug);
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
        assert.deepEqual(after.audio.cues, cues);
        assert.equal(after.audio.dropped, 0);
        const bytes = await page.evaluate(async () =>
            Array.from(
              new Uint8Array(await (await globalThis.combatLab.stopAudioCapture()).arrayBuffer()),
            ),
          ),
          name = `${scene.id}-${label}`,
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
            "-af",
            "aresample=async=1:first_pts=0",
            "-b:a",
            "128k",
            "-movflags",
            "+faststart",
            mp4,
          ],
          { timeout: 30000 },
        );
        const pcm = execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            webm,
            "-vn",
            "-af",
            "aresample=async=1:first_pts=0",
            "-f",
            "f32le",
            "-ac",
            "1",
            "-ar",
            "48000",
            "pipe:1",
          ],
          { maxBuffer: 10_000_000, timeout: 10000 },
        );
        let peak = 0,
          sum = 0;
        for (let i = 0; i < pcm.length; i += 4) {
          const sample = pcm.readFloatLE(i);
          peak = Math.max(peak, Math.abs(sample));
          sum += sample * sample;
        }
        const rms = Math.sqrt(sum / (pcm.length / 4));
        assert(peak < 0.99 && rms > 0.0001, `${name}: clipped or silent capture`);
        const metadata = JSON.parse(
          execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-show_entries",
              "stream=codec_type,duration,nb_frames,avg_frame_rate:format=duration",
              "-of",
              "json",
              mp4,
            ],
            { encoding: "utf8" },
          ),
        );
        const duration = Number(metadata.format.duration),
          expectedSeconds = scene.ticks / 60 / Number(speed);
        assert(
          duration >= expectedSeconds - 0.1 && duration <= expectedSeconds + 1,
          `${name}: incorrect presentation speed`,
        );
        const stereo = [];
        for (const path of [webm, mp4]) {
          const audit = spawnSync(
            "ffmpeg",
            [
              "-hide_banner",
              "-nostats",
              "-i",
              path,
              "-af",
              "astats=reset=0",
              "-vn",
              "-f",
              "null",
              "-",
            ],
            { encoding: "utf8", timeout: 10000 },
          );
          assert.equal(audit.status, 0);
          const peakDb = [...audit.stderr.matchAll(/Peak level dB: ([-.\d]+)/g)].map((m) =>
            Number(m[1]),
          );
          assert.equal(peakDb.length, 3);
          assert(peakDb.every((v) => v < 20 * Math.log10(0.99)));
          stereo.push({ file: path.split("/").at(-1), peakDb });
        }
        report.videos.push({
          stereo,
          audio: after.audio,
          name,
          ticks: scene.ticks,
          speed: Number(speed),
          debug,
          cues: cues.length,
          peak,
          rms,
          audioSeconds: pcm.length / 4 / 48000,
          expectedSeconds,
          metadata,
        });
      }
    await page.locator("#speed").selectOption("1");
    await page.locator("#player-overlays").uncheck();
    await page.locator("#cast-overlays").uncheck();
    console.log(
      JSON.stringify({ scene: scene.id, ticks: scene.ticks, cues: cues.length, status: "pass" }),
    );
  }
  await page.locator("#cast-audio").uncheck();
  assert.equal((await read()).audio.activeVoices, 0);
  assert.deepEqual(errors, []);
  report.browser = await browser.version();
  report.files = [];
  const { readdir } = await import("node:fs/promises");
  for (const name of (await readdir(output)).sort()) {
    const bytes = await readFile(`${output}/${name}`);
    report.files.push({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: "pass",
      runs: report.runs.length,
      videos: report.videos.length,
      pixelChecks: report.captures.length,
      humanReview: "pending",
    }),
  );
} finally {
  await browser?.close();
  server.close();
}

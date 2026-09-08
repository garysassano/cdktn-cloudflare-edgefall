import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { canonical } from "../src/game/core/canonical.ts";
import { createBreakwater, stepBreakwater } from "../src/game/missions/breakwater.ts";
import {
  advanceBreakwaterVisual,
  initialBreakwaterVisual,
} from "../src/shared/animation/breakwater.ts";
import { EFFECT_POSTROLL } from "../src/shared/animation/combat-effects.ts";
import { runBreakwaterProof } from "../test/fixtures/breakwater-proof.ts";
import { AUDIO_EXPORT, exportBreakwaterVideo } from "./lib/export-breakwater-video.mjs";
import { verifyMissionAudio } from "./lib/verify-mission-audio.mjs";

const playerCount = Number(
  process.argv.find((arg) => arg.startsWith("--players="))?.split("=")[1] ?? 1,
);
assert([1, 2, 4].includes(playerCount));
const prefix = playerCount === 1 ? "solo" : `coop-${playerCount}`;
const root = resolve("dist/client"),
  output =
    playerCount === 1 ? "dist/breakwater-evidence" : `dist/breakwater-${playerCount}-evidence`,
  captures = new Map(
    playerCount === 1
      ? [
          [0, "apron"],
          [702, "grenade"],
          [915, "shotgun"],
          [1365, "flame"],
          [1525, "boarding"],
          [1596, "tank-jump"],
          [1970, "ejection"],
          [2040, "aperture"],
          [2949, "victory"],
        ]
      : [[0, "apron"]],
  ),
  expected = new Map(),
  hashes = [],
  visualHashes = [],
  hash = (text) => createHash("sha256").update(text).digest("hex");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
let visual = initialBreakwaterVisual(),
  beforeWorld;
const proof = runBreakwaterProof((state) => {
  if (beforeWorld) visual = advanceBreakwaterVisual(visual, beforeWorld, state);
  beforeWorld = state;
  visualHashes.push(hash(canonical(visual)));
  hashes.push(hash(canonical(state)));
  if (playerCount !== 1) {
    const queue = (label, delay = 0) => {
      if (![...captures.values()].includes(label)) captures.set(state.combat.tick + delay, label);
    };
    if (state.combat.grenades.length) queue("grenade", 3);
    if (state.combat.areas.some((a) => a.definitionId === 10)) queue("shotgun", 3);
    if (state.combat.areas.some((a) => a.definitionId === 11)) queue("flame", 4);
    if (state.combat.players[0].vehicleId !== null) queue("boarding", 8);
    if (!state.combat.tanks[0].body.grounded) queue("tank-jump");
    if (state.combat.tanks[0].armor === 0) queue("ejection", 4);
    if (state.boss.phase === "recovery") queue("aperture", 25);
    if (state.phase === "victory") queue("victory");
  }
  if (captures.has(state.combat.tick)) expected.set(state.combat.tick, state);
}, playerCount);
assert.equal(proof.state.phase, "victory");
assert.equal(hashes.length, proof.recording.commands.length + 1);
await writeFile(`${output}/${prefix}.recording.json`, `${JSON.stringify(proof.recording)}\n`);
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error("Outside client");
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
await new Promise((done) => server.listen(0, "127.0.0.1", done));
let browser;
const errors = [],
  report = {
    scope: `Continuous local ${playerCount}-player mission with native art, finite effects and authored sample-based music. Network integration, final sound design and human W06 approval are pending.`,
    browserAudioOutput:
      "Chromium --disable-audio-output; WebAudio rendering and MediaRecorder remain active. Physical-device output is not verified.",
    contentHash: proof.state.contentHash,
    players: playerCount,
    clientSha256: hash(await readFile(`${root}/benchmark.js`)),
    ticks: proof.state.combat.tick,
    simulationSeconds: proof.state.combat.tick / 60,
    seed: proof.state.seed,
    outcome: proof.state.phase,
    landmarks: proof.landmarks,
    boundaryHashes: hashes,
    visualHashes,
    presentationPostrollTicks: EFFECT_POSTROLL,
    screenshots: [],
    videos: [],
    checks: [],
  };
try {
  browser = await chromium.launch({
    executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
    args: ["--disable-audio-output"],
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}/benchmark.html`);
  await page.waitForFunction(() => globalThis.breakwater?.frames().hero.length > 0);
  await page.locator("#players").selectOption(String(playerCount));
  await page.locator("#reset").click();
  const paint = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  for (const [tick, label] of [...captures].sort((a, b) => a[0] - b[0])) {
    const current = await page.evaluate(() => globalThis.breakwater.state().combat.tick);
    const states = await page.evaluate(
      (rows) => {
        const results = [];
        for (const row of rows) {
          globalThis.breakwater.advance(row);
          results.push({
            state: globalThis.breakwater.state(),
            visual: globalThis.breakwater.visual(),
          });
        }
        return results;
      },
      proof.recording.commands.slice(current, tick),
    );
    for (const { state, visual } of states) {
      assert.equal(
        hash(canonical(state)),
        hashes[state.combat.tick],
        `Browser boundary ${state.combat.tick}`,
      );
      assert.equal(
        hash(canonical(visual)),
        visualHashes[state.combat.tick],
        `Browser visual boundary ${state.combat.tick}`,
      );
    }
    const state = await page.evaluate(() => globalThis.breakwater.state());
    assert.equal(canonical(state), canonical(expected.get(tick)));
    await paint();
    for (const debug of [false, true]) {
      await page.locator("#debug").setChecked(debug);
      await paint();
      const name = `${String(tick).padStart(4, "0")}-${label}-${debug ? "debug" : "clean"}.png`,
        bytes = await page.locator("#game canvas").screenshot({ path: `${output}/${name}` }),
        image = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      assert.equal(image.info.width, 768);
      assert.equal(image.info.height, 432);
      for (let y = 0; y < 432; y += 2)
        for (let x = 0; x < 768; x += 2)
          for (const [dx, dy] of [
            [1, 0],
            [0, 1],
            [1, 1],
          ]) {
            const a = (y * 768 + x) * 4,
              b = ((y + dy) * 768 + x + dx) * 4;
            assert(
              image.data.subarray(a, a + 4).equals(image.data.subarray(b, b + 4)),
              `Non-native pixel at ${x},${y} in ${name}`,
            );
          }
      report.screenshots.push({ name, tick, debug, sha256: hash(bytes) });
    }
    console.log(`Verified mission boundary ${tick}: ${label}`);
  }
  assert.deepEqual(await page.evaluate(() => globalThis.breakwater.recording()), proof.recording);
  await page.locator("#check-recording").click();
  assert.match(await page.locator("#status").textContent(), /Replay matches/);
  assert.equal(
    hash(canonical(await page.evaluate(() => globalThis.breakwater.visual()))),
    visualHashes.at(-1),
  );
  report.checks.push(
    `All ${proof.state.combat.tick} accepted simulation and visual boundaries match Node; complete replay restores the victory state.`,
  );
  // Playback identity belongs to the recording even if the next-run selectors were edited.
  await page.locator("#players").selectOption(playerCount === 4 ? "1" : "4");
  await page.locator("#seed").fill("123");
  await page.locator("#play-recording").click();
  assert.equal(await page.locator("#players").inputValue(), String(playerCount));
  assert.equal(await page.locator("#seed").inputValue(), String(proof.state.seed));
  await page.locator("#run").click();
  report.checks.push("Playback retains recording player count and seed after selector edits.");
  for (const count of [2, 4]) {
    await page.locator("#players").selectOption(String(count));
    await page.locator("#seed").fill("123");
    await page.locator("#reset").click();
    let state = createBreakwater(count, 123);
    const rows = Array.from({ length: 100 }, (_, tick) =>
      Array.from({ length: count }, (_, slot) => ({
        held: 2 | 16,
        firePressed: tick % 8 === 0,
        jumpPressed: tick === 10 + slot * 5,
        grenadePressed: tick === 70 + slot * 3,
        interactPressed: false,
      })),
    );
    for (const row of rows) state = stepBreakwater(state, row);
    await page.evaluate((rows) => {
      for (const row of rows) globalThis.breakwater.advance(row);
    }, rows);
    assert.equal(
      canonical(await page.evaluate(() => globalThis.breakwater.state())),
      canonical(state),
    );
    await paint();
    assert.equal((await page.evaluate(() => globalThis.breakwater.frames().hero)).length, count);
    report.checks.push(
      `Additional ${count}-slot reset with seed 123 matches Node after 100 boundaries.`,
    );
  }
  // Real input: a short tap survives until the next accepted boundary, and blur clears held intent.
  await page.locator("#players").selectOption("1");
  await page.locator("#reset").click();
  await page.locator("#game").focus();
  await page.keyboard.press("Space");
  await page.locator("#step").click();
  assert((await page.evaluate(() => globalThis.breakwater.state().combat.players[0].body.vy)) < 0);
  await page.keyboard.down("KeyD");
  await page.locator("#seed").focus();
  await page.locator("#step").click();
  assert.equal(
    await page.evaluate(() => globalThis.breakwater.recording().commands.at(-1)[0].held),
    0,
  );
  await page.keyboard.up("KeyD");
  report.checks.push("Real keyboard short-tap jump and focus-loss clearing pass.");
  // A newly attached or replaced pad must be standard-mapped and return to neutral.
  await page.locator("#game").focus();
  await page.evaluate(() => {
    globalThis.probePad = null;
    Object.defineProperty(navigator, "getGamepads", {
      configurable: true,
      value: () => [globalThis.probePad, null, null, null],
    });
  });
  const pad = async (id, mapping, axis, pressed) => {
    await page.evaluate(
      ({ id, mapping, axis, pressed }) => {
        globalThis.probePad =
          id === null
            ? null
            : {
                id,
                index: 0,
                connected: true,
                mapping,
                axes: [axis, 0],
                buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) })),
              };
      },
      { id, mapping, axis, pressed },
    );
    await paint();
  };
  const inputStep = async () => {
    await page.locator("#step").click();
    return page.evaluate(() => globalThis.breakwater.recording().commands.at(-1)[0]);
  };
  await pad("first", "standard", 1, [2]);
  assert.equal((await inputStep()).held, 0, "Attached held pad bypassed neutral barrier");
  await pad("first", "standard", 0, []);
  await pad("first", "standard", 1, [2]);
  assert.equal((await inputStep()).held, 2 | 16);
  await pad(null, "", 0, []);
  assert.equal((await inputStep()).held, 0, "Disconnected pad retained held input");
  await pad("second", "standard", 1, [2]);
  assert.equal((await inputStep()).held, 0, "Replacement pad bypassed neutral barrier");
  await pad("second", "standard", 0, []);
  await pad("second", "standard", 1, [2]);
  assert.equal((await inputStep()).held, 2 | 16);
  await pad("raw", "", 0, []);
  await pad("raw", "", 1, [2]);
  assert.equal((await inputStep()).held, 0, "Unknown mapping emitted standard-layout input");
  await page.evaluate(() => {
    delete navigator.getGamepads;
    delete globalThis.probePad;
  });
  report.checks.push(
    "Injected gamepad attach/replacement neutral barriers, disconnect clearing and unknown-mapping rejection pass; physical controllers remain unverified.",
  );
  if (playerCount === 1) {
    const audioProof = await verifyMissionAudio(page);
    report.checks.push(...audioProof.checks);
    report.musicLoops = audioProof.loops;
  }
  await page.locator("#import").setInputFiles(`${output}/${prefix}.recording.json`);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("Imported replay matches"),
  );
  assert.equal(
    canonical(await page.evaluate(() => globalThis.breakwater.state())),
    proof.recording.finalState,
  );
  report.checks.push("File import reconstructs the full mission and rejects no valid input.");
  // Videos run on actual RAF boundaries with the WebAudio destination in the captured stream.
  if (!process.argv.includes("--no-video")) {
    await page.locator("#sound").check();
    await page.waitForFunction(() => globalThis.breakwater.audio().ready);
    const modes = process.argv.includes("--all-videos")
      ? [1, 0.25].flatMap((speed) =>
          [false, true].flatMap((debug) => [true, false].map((music) => [speed, debug, music])),
        )
      : [
          [1, false, true],
          [1, true, true],
          [0.25, false, true],
        ];
    for (const [speed, debug, music] of modes) {
      const name = `${prefix}-${debug ? "debug" : "clean"}-${speed === 1 ? "normal" : "quarter"}${music ? "" : "-music-off"}`;
      await page.locator("#speed").selectOption(String(speed));
      await page.locator("#debug").setChecked(debug);
      await page.locator("#music").setChecked(music);
      await page.locator("#play-recording").click();
      await page.evaluate(() => globalThis.breakwater.startCapture());
      const start = Date.now(),
        beforeTiming = await page.evaluate(() => globalThis.breakwater.timing()),
        beforeAudio = await page.evaluate(() => globalThis.breakwater.audio());
      await page.waitForFunction(() => !globalThis.breakwater.running(), {}, { timeout: 260000 });
      assert.equal(
        canonical(await page.evaluate(() => globalThis.breakwater.state())),
        proof.recording.finalState,
      );
      const afterTiming = await page.evaluate(() => globalThis.breakwater.timing());
      const audio = await page.evaluate(() => globalThis.breakwater.audio());
      assert.equal(audio.music.voices, 0, "Terminal music voices did not stop");
      assert(
        audio.decodedBytes + audio.music.decodedBytes <= 32 * 1024 * 1024,
        "Decoded encounter audio budget exceeded",
      );
      if (music)
        assert.deepEqual(
          audio.music.transitions.map((t) => t.phase),
          ["breakwater-quay", "lock-engine"],
        );
      else assert.equal(audio.music.transitions.length, 0);
      await page.waitForTimeout(400);
      const capture = await page.evaluate(async () => {
        const blob = await globalThis.breakwater.stopCapture();
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        return {
          mimeType: blob.type,
          bytes: blob.size,
          base64: dataUrl.slice(dataUrl.lastIndexOf(",") + 1),
        };
      });
      await writeFile(`${output}/${name}.webm`, Buffer.from(capture.base64, "base64"));
      exportBreakwaterVideo(`${output}/${name}`);
      const media = JSON.parse(
        execFileSync(
          "ffprobe",
          ["-v", "error", "-show_streams", "-show_format", "-of", "json", `${output}/${name}.mp4`],
          { encoding: "utf8" },
        ),
      );
      assert(media.streams.some((s) => s.codec_type === "video"));
      assert(media.streams.some((s) => s.codec_type === "audio"));
      const pcm = execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-i",
          `${output}/${name}.webm`,
          "-vn",
          "-ac",
          "1",
          "-ar",
          "48000",
          "-f",
          "f32le",
          "pipe:1",
        ],
        { maxBuffer: 80_000_000 },
      );
      let peak = 0,
        energy = 0;
      for (let offset = 0; offset < pcm.length; offset += 4) {
        const sample = pcm.readFloatLE(offset);
        peak = Math.max(peak, Math.abs(sample));
        energy += sample * sample;
      }
      const rms = Math.sqrt(energy / (pcm.length / 4));
      assert(peak < 0.99 && rms > 0.0001, "Clipped or silent browser capture");
      const clocks = {
        wallMs: afterTiming.wallMs - beforeTiming.wallMs,
        monotonicMs: afterTiming.monotonicNow - beforeTiming.monotonicNow,
        acceptedClockMs: afterTiming.monotonicMs - beforeTiming.monotonicMs,
        renderedFrames: afterTiming.frames - beforeTiming.frames,
        rendererMs: afterTiming.rendererMs - beforeTiming.rendererMs,
        maximumFrameMs: afterTiming.maxFrameMs,
        videoSeconds: Number(media.format.duration),
        audioCues: audio.cues.length,
        audioDropped: audio.dropped,
        maximumAudioVoices: audio.maxActiveVoices,
        audioVoiceBudget: audio.voiceBudget,
        audioState: audio.state,
        audioSeconds: audio.contextSeconds - beforeAudio.contextSeconds,
        maxStalledAudioTicks: audio.maxStalledAudioTicks,
        droppedExamples: audio.droppedExamples,
        music: audio.music,
        decodedAudioBytes: audio.decodedBytes + audio.music.decodedBytes,
        capturedAudioPeak: peak,
        capturedAudioRms: rms,
      };
      console.log(JSON.stringify({ capture: name, clocks }));
      await writeFile(`${output}/${name}-clocks.json`, `${JSON.stringify(clocks, null, 2)}\n`);
      assert.equal(audio.dropped, 0, "Capture lost sample voices");
      assert(
        Math.abs(clocks.audioSeconds - clocks.monotonicMs / 1000) < 0.2,
        "Audio clock diverged from browser playback",
      );
      assert(
        Math.abs(
          Number(media.format.duration) - (proof.state.combat.tick + EFFECT_POSTROLL) / 60 / speed,
        ) < 2,
      );
      report.videos.push({
        name,
        speed,
        debug,
        music,
        audioExport: AUDIO_EXPORT,
        mimeType: capture.mimeType,
        wallMs: Date.now() - start,
        duration: Number(media.format.duration),
        bytes: capture.bytes,
        clocks,
      });
      console.log(`Captured ${name}: ${media.format.duration} seconds`);
    }
  }
  assert.deepEqual(errors, []);
  report.status = "pass";
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      ticks: report.ticks,
      screenshots: report.screenshots.length,
      videos: report.videos.length,
      checks: report.checks,
    }),
  );
} catch (error) {
  report.status = "failed";
  report.failure = String(error);
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

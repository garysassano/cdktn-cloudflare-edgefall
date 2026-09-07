import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Isolate host/browser audio time without the game, Phaser or MediaRecorder.
const mode = process.argv[2] ?? "muted";
assert(["muted", "unmuted", "disabled-output"].includes(mode), "Unknown audio probe mode");
const durationMs = 50_000;
const bytes = Array.from(await readFile("public/assets/audio/rivet-shot.ogg"));
const browser = await chromium.launch({
  executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
  ...(mode === "unmuted" ? { ignoreDefaultArgs: ["--mute-audio"] } : {}),
  ...(mode === "disabled-output" ? { args: ["--disable-audio-output"] } : {}),
});
try {
  const page = await browser.newPage();
  await page.setContent("<button>Start audio clock probe</button>");
  await page.evaluate((bytes) => {
    document.querySelector("button").onclick = async () => {
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(new Uint8Array(bytes).buffer);
      const source = context.createBufferSource();
      const gain = context.createGain();
      source.buffer = buffer;
      source.loop = true;
      gain.gain.value = 0.001;
      source.connect(gain).connect(context.destination);
      await context.resume();
      source.start();
      globalThis.audioClockProbe = {
        context,
        source,
        monotonic: performance.now(),
        wall: Date.now(),
        audio: context.currentTime,
      };
    };
  }, bytes);
  await page.click("button");
  await page.waitForFunction(() => Boolean(globalThis.audioClockProbe));
  await page.waitForTimeout(durationMs);
  const clocks = await page.evaluate(async () => {
    const { context, source, monotonic, wall, audio } = globalThis.audioClockProbe;
    const result = {
      monotonicMs: performance.now() - monotonic,
      wallMs: Date.now() - wall,
      audioSeconds: context.currentTime - audio,
      state: context.state,
      sampleRate: context.sampleRate,
    };
    source.stop();
    await context.close();
    return result;
  });
  const driftSeconds = clocks.audioSeconds - clocks.monotonicMs / 1000;
  const report = {
    mode,
    browser: browser.version(),
    durationMs,
    ...clocks,
    driftSeconds,
    status: Math.abs(driftSeconds) < 0.2 && clocks.state === "running" ? "pass" : "failed",
    scope:
      "Looped licensed sample and AudioContext only; no game, recorder or physical-device acceptance.",
  };
  await mkdir("dist/browser-audio-probe", { recursive: true });
  await writeFile(`dist/browser-audio-probe/${mode}.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  if (report.status !== "pass") process.exitCode = 1;
} finally {
  await browser.close();
}

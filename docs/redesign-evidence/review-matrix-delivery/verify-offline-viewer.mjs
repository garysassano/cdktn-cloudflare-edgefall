import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

// Run from the repository after downloading every draft asset into one directory.
assert(process.argv[2] && process.argv[3], "Pass the download directory and output directory");
const directory = resolve(process.argv[2]),
  output = resolve(process.argv[3]),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  manifestBytes = await readFile(`${directory}/artifacts.json`),
  manifest = JSON.parse(manifestBytes),
  viewerBytes = await readFile(`${directory}/review.html`),
  viewerUrl = pathToFileURL(`${directory}/review.html`).href;
assert.equal(manifest.release.tag, "w06-review-v2-kestrel");
assert.equal(
  hash(viewerBytes),
  manifest.artifacts.find((artifact) => artifact.path === "review.html").sha256,
);
await mkdir(output, { recursive: true });
let browser;
const errors = [],
  networkRequests = [],
  checked = [];
try {
  browser = await chromium.launch({
    ...(process.env.EDGEFALL_CHROMIUM_PATH
      ? { executablePath: process.env.EDGEFALL_CHROMIUM_PATH }
      : {}),
    headless: true,
    args: ["--disable-audio-output"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1080 } });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!/^(file|data|blob):/.test(request.url())) networkRequests.push(request.url());
  });
  await page.goto(viewerUrl);
  for (const run of manifest.runs) {
    for (const movie of run.movies) {
      for (const [id, value] of Object.entries({
        players: run.players,
        speed: movie.speed,
        debug: movie.debug,
        music: movie.music,
        reduced: movie.reduced,
      }))
        await page.locator(`#${id}`).selectOption(String(value));
      await page.waitForFunction(
        (name) => {
          const video = document.getElementById("movie");
          return video.readyState >= 1 && video.currentSrc.endsWith(`/${name}.mp4`);
        },
        movie.name,
        { timeout: 15000 },
      );
      const metadata = await page.locator("#movie").evaluate((video) => ({
        width: video.videoWidth,
        height: video.videoHeight,
        duration: video.duration,
      }));
      assert.equal(metadata.width, 384, movie.name);
      assert.equal(metadata.height, 216, movie.name);
      assert(Math.abs(metadata.duration - movie.duration) < 0.2, movie.name);
      assert.equal(await page.locator("#error").isHidden(), true);
      assert.equal(await page.locator("#open-movie").getAttribute("href"), `${movie.name}.mp4`);
      assert.equal(await page.locator("#open-raw").getAttribute("href"), `${movie.name}.webm`);
      assert.equal(await page.locator("#chapters button").count(), run.chapters.length);
      if (movie.speed === 1 && !movie.debug && movie.music && !movie.reduced) {
        for (const chapter of run.chapters) {
          await page.getByRole("button", { name: chapter.label, exact: true }).click();
          const expected = Math.max(0, Math.min(metadata.duration - 0.05, chapter.tick / 60 - 1));
          await page.waitForFunction((position) => {
            const video = document.getElementById("movie");
            return !video.seeking && Math.abs(video.currentTime - position) < 0.05;
          }, expected);
        }
      }
      checked.push({ name: movie.name, ...metadata });
    }
  }
  assert.equal(checked.length, 48);
  await page.waitForFunction(() => {
    const image = document.querySelector("img");
    return image.complete && image.naturalWidth === 1200;
  });
  for (const [id, value] of Object.entries({
    players: 4,
    speed: 1,
    debug: false,
    music: true,
    reduced: false,
  }))
    await page.locator(`#${id}`).selectOption(String(value));
  await page.waitForFunction(() => {
    const video = document.getElementById("movie");
    return video.readyState >= 1 && video.currentSrc.endsWith("/coop-4-clean-normal.mp4");
  });
  await page.getByRole("button", { name: "Tank jump", exact: true }).click();
  await page.waitForFunction(() => !document.getElementById("movie").seeking);
  const beforePlay = await page.locator("#movie").evaluate((video) => video.currentTime);
  await page.locator("#movie").evaluate(async (video) => {
    video.muted = true;
    await video.play();
  });
  await page.waitForFunction(
    (before) => document.getElementById("movie").currentTime > before + 0.3,
    beforePlay,
  );
  await page.locator("#movie").evaluate((video) => video.pause());
  await page.screenshot({ path: `${output}/desktop.png` });
  await page.setViewportSize({ width: 400, height: 900 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: `${output}/mobile.png` });
  assert.deepEqual(errors, []);
  assert.deepEqual(networkRequests, []);
  const report = {
    status: "pass",
    manifestSha256: hash(manifestBytes),
    viewerSha256: hash(viewerBytes),
    locationProtocol: "file:",
    downloadedAssets: true,
    browserVersion: browser.version(),
    views: checked,
    sceneJumps: manifest.runs.reduce((sum, run) => sum + run.chapters.length, 0),
    pageErrors: errors,
    networkRequests,
    checks: [
      "All 48 selections load downloaded MP4s with the expected native dimensions and duration",
      "MP4/raw WebM links match the selected view",
      "Nine scene jumps per party reach their expected positions",
      "Muted playback advances from the downloaded movie",
      "The native weapon image loads and the 400-pixel viewport has no document overflow",
    ],
    scope:
      "Direct file URL review of downloaded assets. Human style/listening, physical audio output, controller feel and online play remain separate checks.",
  };
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      views: checked.length,
      sceneJumps: report.sceneJumps,
      locationProtocol: report.locationProtocol,
      networkRequests: networkRequests.length,
    }),
  );
} finally {
  await browser?.close();
}

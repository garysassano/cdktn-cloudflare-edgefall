import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { chromium } from "@playwright/test";

const root = resolve("dist/client"),
  output = "dist/art-review-evidence";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, "http://localhost").pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error("Outside fixture root");
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".png": "image/png",
        ".json": "application/json",
        ".txt": "text/plain",
      }[extname(path)] ?? "application/octet-stream",
    );
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 1120 } }),
    errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const sources = JSON.parse(await readFile(`${root}/art-review/report.json`, "utf8"));
  await page.goto(`http://127.0.0.1:${server.address().port}/art-review.html`);
  const captures = [];
  for (const [index, study] of sources.studies.entries()) {
    await page.locator("#study").selectOption(String(index));
    await page.waitForFunction(
      (id) =>
        document.documentElement.dataset.reviewStudy === id &&
        document.querySelector("#sheet").complete,
      study.id,
    );
    await page.locator("#sheet").evaluate((image) => image.decode());
    assert.match(await page.locator("#status").textContent(), /Production import rejected/);
    assert.equal(
      await page.locator("#sheet").evaluate((image) => image.naturalWidth),
      study.image.width,
    );
    assert(
      (await page.locator("#metrics").textContent()).includes(
        study.image.alpha.partial.toLocaleString(),
      ),
    );
    for (const background of ["#000000", "#ffffff", "#808080", "#00ffff", "#ff00ff"]) {
      await page.locator("#background").selectOption(background);
      const actual = await page
        .locator("#viewport")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const rgb = background
        .slice(1)
        .match(/../g)
        .map((hex) => Number.parseInt(hex, 16));
      assert.equal(actual, `rgb(${rgb.join(", ")})`);
    }
    await page.locator("#background").selectOption("#00ffff");
    await page.locator("#zoom").selectOption("native");
    assert.equal(
      await page.locator("#sheet").evaluate((image) => image.getBoundingClientRect().width),
      study.requested.nativeWidth,
    );
    assert.match(await page.locator("#caption").textContent(), /Resampled concept preview/);
    await page.screenshot({ path: `${output}/${study.id}-logical-preview.png`, fullPage: true });
    await page.locator("#zoom").selectOption("0.5");
    await page.locator("#show-grid").check();
    assert(await page.locator("#grid").isVisible());
    await page.screenshot({ path: `${output}/${study.id}-cyan.png`, fullPage: true });
    const prompt = await page.locator("#source a").getAttribute("href");
    assert((await page.request.get(new URL(prompt, page.url()).href)).ok());
    captures.push({
      id: study.id,
      actual: [study.image.width, study.image.height],
      alpha: study.image.alpha,
      backgrounds: 5,
      logicalPreviewWidth: study.requested.nativeWidth,
      importAllowed: false,
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
        bundleSha256: createHash("sha256")
          .update(await readFile(`${root}/art-review.js`))
          .digest("hex"),
        sourceIndexSha256: sources.sourceIndexSha256,
        captures,
        errors,
        scope:
          "Actual browser controls and source diagnostics only. Native frames, animation, sockets, audio, gameplay footage and human acceptance remain unfinished.",
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ status: "pass", studies: captures.length, directory: output }));
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}

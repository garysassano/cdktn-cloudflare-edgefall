import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { tankTerrainProof } from "../test/fixtures/tank-terrain-proof.js";

const require = createRequire(import.meta.url);
const workerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire("miniflare");
const output = "dist/tank-terrain-proof";
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const bundles = {};
async function bundle(name, options) {
  const result = await build({ ...options, bundle: true, write: false, metafile: true });
  const bytes = result.outputFiles[0].contents;
  const sources = [];
  for (const path of Object.keys(result.metafile.inputs).sort()) {
    const data = path === "<stdin>" ? Buffer.from(options.stdin.contents) : await readFile(path);
    sources.push({ path, bytes: data.length, sha256: hash(data) });
  }
  bundles[name] = { sha256: hash(bytes), sources };
  await writeFile(`${output}/${name}.js`, bytes);
  return result.outputFiles[0].text;
}
const browserSource = await bundle("browser", {
  entryPoints: ["test/fixtures/tank-terrain-proof.ts"],
  format: "iife",
  globalName: "EdgefallTankTerrain",
  platform: "browser",
  target: "es2022",
});
const workerSource = await bundle("worker", {
  stdin: {
    resolveDir: process.cwd(),
    contents: `import { tankTerrainProof } from './test/fixtures/tank-terrain-proof.ts';
export default { fetch(request) {
  return new URL(request.url).pathname === '/proof'
    ? Response.json(tankTerrainProof()) : Response.json({ status: 'ok' });
} };`,
  },
  platform: "neutral",
  format: "esm",
});
await writeFile(
  `${output}/execution.json`,
  `${JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      bundles,
      verifierSha256: hash(await readFile(import.meta.filename)),
    },
    null,
    2,
  )}\n`,
);
let worker, browser;
let phase = "Node";
try {
  const expected = tankTerrainProof();
  phase = "workerd";
  worker = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: workerSource,
      compatibilityDate: "2026-08-30",
      port: 0,
      log: new Log(LogLevel.ERROR),
    }),
  );
  const origin = (await worker.ready).origin;
  const response = await fetch(`${origin}/proof`, { signal: AbortSignal.timeout(30_000) });
  assert(response.ok, `Terrain Worker: ${response.status}`);
  assert.deepEqual(await response.json(), expected, "workerd terrain differs from Node");
  phase = "Chromium";
  browser = await chromium.launch({
    executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.addScriptTag({ content: browserSource });
  assert.deepEqual(
    await page.evaluate("EdgefallTankTerrain.tankTerrainProof()"),
    expected,
    "Chromium terrain differs from Node",
  );
  const summary = expected.map(({ observations, ...record }) => record);
  const report = {
    status: "pass",
    recordedAt: new Date().toISOString(),
    bundles,
    runtimes: {
      node: process.version,
      browser: browser.version(),
      wrangler: require("wrangler/package.json").version,
      worker: "local workerd",
    },
    cases: summary,
    resultSha256: hash(JSON.stringify(expected)),
    scope:
      "Pure full combat-step terrain and seat lifecycle in Node, Chromium and local workerd. JSON state reconstruction plus eight subsequent steps at five boundaries per case. No socket impairment, database recovery, rendered footage or deployed timing claim.",
  };
  await writeFile(`${output}/traces.json`, `${JSON.stringify(expected)}\n`);
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: report.status,
      cases: summary.length,
      ticks: summary.reduce((sum, record) => sum + record.ticks, 0),
      checkpoints: summary.reduce((sum, record) => sum + record.checkpoints.length, 0),
      directory: output,
    }),
  );
} catch (error) {
  await writeFile(
    `${output}/failure.json`,
    `${JSON.stringify({ phase, error: String(error) }, null, 2)}\n`,
  );
  throw error;
} finally {
  await browser?.close();
  await worker?.dispose();
}

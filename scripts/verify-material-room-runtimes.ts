import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { materialRoomContract } from "../test/fixtures/material-room-contract.js";
import { verifyStoredMaterials } from "./lib/verify-stored-materials.js";

const output = "dist/material-room-runtime-proof",
  requestTimeoutMs = 60_000,
  require = createRequire(import.meta.url),
  workerRequire = createRequire(require.resolve("wrangler/package.json")),
  { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire("miniflare");
await mkdir(output, { recursive: true });
for (const name of ["report.json", "failure.json"]) await rm(`${output}/${name}`, { force: true });
const browserBundle = await build({
  entryPoints: ["test/fixtures/material-room-contract.ts"],
  bundle: true,
  format: "iife",
  globalName: "EdgefallMaterialRoomProof",
  write: false,
  metafile: true,
  platform: "browser",
  target: "es2022",
});
const workerBundle = await build({
  entryPoints: ["test/fixtures/material-room-storage-worker.ts"],
  bundle: true,
  format: "esm",
  external: ["cloudflare:workers"],
  platform: "neutral",
  write: false,
  metafile: true,
});
const javascript = browserBundle.outputFiles[0]?.text,
  script = workerBundle.outputFiles[0]?.text;
assert(javascript && script, "Missing material proof bundles");
await writeFile(`${output}/browser.js`, javascript);
await writeFile(`${output}/worker.js`, script);
const sources = [];
for (const path of [
  ...new Set([
    ...Object.keys(browserBundle.metafile.inputs),
    ...Object.keys(workerBundle.metafile.inputs),
    "scripts/verify-material-room-runtimes.ts",
    "scripts/lib/verify-stored-materials.ts",
  ]),
].sort())
  sources.push({
    path,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  });
const directory = await mkdtemp(join(tmpdir(), "edgefall-material-room-"));
const create = () =>
  new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-08-30",
      durableObjects: { STORES: { className: "MaterialRoomStorageProof", useSQLite: true } },
      resourcePersistencePath: directory,
      log: new Log(LogLevel.ERROR),
    }),
  );
let runtime = create(),
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const origin = async () => {
  const url: URL = await runtime.ready;
  url.hostname = "127.0.0.1";
  return url.origin;
};
let phase = "startup";
try {
  const base = await origin();
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
    fixture: "material-room-proof",
  });
  browser = await chromium.launch({ executablePath: process.env.EDGEFALL_CHROMIUM_PATH });
  const page = await browser.newPage(),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${base}/health`);
  await page.addScriptTag({ content: javascript });
  const groups = [];
  for (const players of [1, 4]) {
    phase = `Node material rooms, ${players} players`;
    const nodeStarted = performance.now(),
      expected = await materialRoomContract(players),
      nodeMs = Math.round(performance.now() - nodeStarted);
    console.log(`${phase}: ${expected.cases.length} cases passed`);
    phase = `workerd material rooms, ${players} players`;
    const workerdStarted = performance.now(),
      response = await fetch(`${base}/proof/${players}`, {
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    assert(response.ok, `${phase}: ${await response.clone().text()}`);
    assert.deepEqual(await response.json(), expected, "workerd differs from Node");
    const workerdMs = Math.round(performance.now() - workerdStarted);
    console.log(`${phase}: ${expected.cases.length} cases passed`);
    phase = `Chromium material rooms, ${players} players`;
    const chromiumStarted = performance.now();
    assert.deepEqual(
      await page.evaluate(
        (players) =>
          (
            globalThis as unknown as {
              EdgefallMaterialRoomProof: { materialRoomContract: typeof materialRoomContract };
            }
          ).EdgefallMaterialRoomProof.materialRoomContract(players),
        players,
      ),
      expected,
      "Chromium differs from Node",
    );
    const chromiumMs = Math.round(performance.now() - chromiumStarted);
    assert.deepEqual(errors, []);
    console.log(`${phase}: ${expected.cases.length} cases passed`);
    groups.push({
      players,
      durationsMs: { node: nodeMs, workerd: workerdMs, chromium: chromiumMs },
      resultSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
      ...expected,
    });
  }
  phase = "material SQLite recovery";
  const storage = await verifyStoredMaterials(origin, async () => {
    await runtime.dispose();
    runtime = create();
  });
  const report = {
    schemaVersion: 1,
    status: "pass",
    recordedAt: new Date().toISOString(),
    baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runtimes: {
      node: process.version,
      chromium: browser.version(),
      wrangler: (require("wrangler/package.json") as { version: string }).version,
      worker: "owned local workerd; no deployment",
    },
    requestTimeoutMs,
    sources,
    browserBundleSha256: createHash("sha256").update(javascript).digest("hex"),
    workerBundleSha256: createHash("sha256").update(script).digest("hex"),
    groups,
    storage,
    scope:
      "Registered material scenarios, admitted duplicate inputs, public snapshots/events and exact archive/journal parity in three runtimes plus cold SQLite recovery. Browser networking, deployed tracing and timing are separate checks.",
  };
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      status: "pass",
      cases: groups.reduce((sum, group) => sum + group.cases.length, 0),
      storageBoundaries: storage.boundaryCount,
      rollbackChecks: storage.rollbackChecks,
      output,
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
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { contractProof } from "../test/fixtures/contract-proof.js";

const require = createRequire(import.meta.url);
const output = "dist/contract-runtime-proof";
await mkdir(output, { recursive: true });
const bundle = await build({
  entryPoints: ["test/fixtures/contract-proof.ts"],
  bundle: true,
  format: "iife",
  globalName: "EdgefallContractProof",
  write: false,
  metafile: true,
  platform: "browser",
  target: "es2022",
});
const javascript = bundle.outputFiles[0]?.text;
assert(javascript, "Missing browser proof bundle");
await writeFile(`${output}/browser.js`, javascript);
const source = createHash("sha256");
for (const path of Object.keys(bundle.metafile.inputs).sort()) {
  source
    .update(path)
    .update("\0")
    .update(await readFile(path))
    .update("\0");
}
const expected = contractProof();
const port = 8790;
let occupied = false;
try {
  await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
  occupied = true;
} catch {
  /* An unused local port is required for this owned test process. */
}
assert(!occupied, `Port ${port} is occupied; refusing to test an unrelated server`);
const server = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--local",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--config",
    "e2e/contracts.wrangler.jsonc",
  ],
  { stdio: ["ignore", "pipe", "pipe"], detached: true },
);
let serverLog = "";
for (const stream of [server.stdout, server.stderr])
  stream.on("data", (chunk: Buffer) => {
    serverLog = (serverLog + chunk.toString()).slice(-16_384);
  });
const exited = new Promise<void>((resolve) => {
  server.once("exit", () => resolve());
  server.once("error", () => resolve());
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Local conformance worker exited: ${serverLog}`);
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) }))
        .ok;
    } catch {
      /* Bounded startup polling. */
    }
    if (ready) break;
    await delay(200);
  }
  assert(ready, `Local conformance worker did not start: ${serverLog}`);
  const response = await fetch(`http://127.0.0.1:${port}/contract-proof`, {
    signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, "workerd contract proof failed");
  assert.deepEqual(await response.json(), expected, "workerd differs from Node");
  browser = await chromium.launch({
    executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
    headless: true,
  });
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addScriptTag({ content: javascript });
  assert.deepEqual(
    await page.evaluate("EdgefallContractProof.contractProof()"),
    expected,
    "Chromium differs from Node",
  );
  assert.deepEqual(errors, []);
  const report = {
    schemaVersion: 1,
    package: "W01/W03",
    recordedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceSha256: source.digest("hex"),
    browserBundleSha256: createHash("sha256").update(javascript).digest("hex"),
    resultSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
    runtimes: {
      node: process.version,
      chromium: browser.version(),
      wrangler: (require("wrangler/package.json") as { version: string }).version,
      worker: "local workerd; no deployed service",
    },
    snapshotBytes: expected.snapshots.map((snapshot) => ({
      name: snapshot.name,
      bytes: snapshot.hex.length / 2,
    })),
    appliedTicks: expected.trace.map((tick) => tick.input.serverTick),
    collisionSeeds: expected.collision.samples.length,
    movement: expected.movement,
    controller: expected.controller,
    controllerBoundaries: {
      cases: expected.controllerBoundaries.cases.map((entry) => entry.name),
      traceHash: expected.controllerBoundaries.traceHash,
    },
    restoredController: {
      restoredAfterTick: 599,
      traceHash: expected.restoredController.traceHash,
    },
    spatial: {
      fixed: expected.spatial.fixed,
      moving: expected.spatial.moving,
      bodies: expected.spatial.bodies,
      referenceHash: expected.spatial.referenceHash,
      cells: expected.spatial.cells.map(({ outcomes: _outcomes, ...summary }) => summary),
    },
    indexedMovement: expected.indexedMovement.map((result) => ({
      cellPixels: result.cellPixels,
      ticks: result.ticks,
      traceHash: result.traceHash,
    })),
    movingCases: {
      seeds: expected.movingCases.outcomes.length,
      complete: expected.movingCases.complete,
      crushed: expected.movingCases.crushed,
      traceHash: expected.movingCases.traceHash,
    },
    restoredMovement: expected.restoredMovement.map((restored) => ({
      restoredAfterTick: restored.restoredAfterTick,
      traceHash: restored.traceHash,
    })),
    collisionResults: {
      solidHits: expected.collision.samples.filter((sample) => sample.solid?.kind === "hit").length,
      initialOverlaps: expected.collision.samples.filter(
        (sample) => sample.solid?.kind === "overlap",
      ).length,
      oneWayHits: expected.collision.samples.filter((sample) => sample.oneWay !== null).length,
    },
    status: "pass",
    scope:
      "snapshot bytes/state, input traces, 256 seeded sweep results and a 1200-tick gravity/platform movement fixture; no integrated controller, renderer, full gameplay replay or remote timer claim",
  };
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  if (server.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* Child may already have exited. */
    }
    await Promise.race([exited, delay(5000)]);
    if (server.exitCode === null && server.signalCode === null) {
      try {
        process.kill(-server.pid, "SIGKILL");
      } catch {
        /* Already gone. */
      }
    }
  }
}

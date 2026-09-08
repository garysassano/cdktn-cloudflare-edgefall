import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { contractProof } from "../test/fixtures/contract-proof.js";

const require = createRequire(import.meta.url);
const output = "dist/contract-runtime-proof";
// Bounds the complete cross-domain conformance suite, including archive replay, not a room tick.
const WORKERD_REQUEST_TIMEOUT_MS = 60_000;
await mkdir(output, { recursive: true });
for (const name of ["report.json", "failure.json"]) await rm(`${output}/${name}`, { force: true });
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
assert(
  !Object.keys(bundle.metafile.inputs).some(
    (path) => path.includes("ajv") || path.endsWith(".ldtk") || path.includes("scripts/lib/ldtk"),
  ),
  "Build-only editor parser leaked into runtime",
);
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
const durationsMs = { node: 0, workerdRequest: 0, chromium: 0 };
const nodeStarted = performance.now();
const expected = await contractProof();
durationsMs.node = Math.round(performance.now() - nodeStarted);
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
let phase = "worker startup";
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
  phase = "workerd contract workload";
  const workerdStarted = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/contract-proof`, {
    signal: AbortSignal.timeout(WORKERD_REQUEST_TIMEOUT_MS),
  });
  assert(response.ok, "workerd contract proof failed");
  assert.deepEqual(await response.json(), expected, "workerd differs from Node");
  durationsMs.workerdRequest = Math.round(performance.now() - workerdStarted);
  phase = "Chromium contract workload";
  browser = await chromium.launch({
    executablePath: process.env.EDGEFALL_CHROMIUM_PATH,
    headless: true,
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/health`);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addScriptTag({ content: javascript });
  const chromiumStarted = performance.now();
  assert.deepEqual(
    await page.evaluate("EdgefallContractProof.contractProof()"),
    expected,
    "Chromium differs from Node",
  );
  durationsMs.chromium = Math.round(performance.now() - chromiumStarted);
  assert.deepEqual(errors, []);
  const report = {
    schemaVersion: 1,
    package: "W01/W03/W04/W05/W07",
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
    durationsMs,
    workerdRequestTimeoutMs: WORKERD_REQUEST_TIMEOUT_MS,
    snapshotBytes: expected.snapshots.map((snapshot) => ({
      name: snapshot.name,
      bytes: snapshot.hex.length / 2,
    })),
    appliedTicks: expected.trace.map((tick) => tick.input.serverTick),
    collisionSeeds: expected.collision.samples.length,
    movement: expected.movement,
    controller: expected.controller,
    grounded: expected.grounded,
    restoredGroundedHash: expected.restoredGrounded.traceHash,
    seams: expected.seams,
    navigation: expected.navigation,
    traversal: expected.traversal,
    route: expected.route,
    compiledLevel: expected.compiledLevel,
    encounter: expected.encounter,
    prediction: expected.prediction,
    mappedPrediction: expected.mappedPrediction,
    inputCapture: expected.inputCapture,
    inputFlow: expected.inputFlow,
    routedEnemy: expected.routedEnemy,
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
    combat: expected.combat,
    playerLife: expected.playerLife,
    bodyPresence: expected.bodyPresence,
    entryPhysics: expected.entryPhysics,
    entryRecovery: expected.entryRecovery,
    airborneDeathRecovery: expected.airborneDeathRecovery,
    playerLifeRecovery: expected.playerLifeRecovery,
    campaign: expected.campaign,
    worldCombat: expected.worldCombat,
    combatRecovery: expected.combatRecovery,
    rifleRecovery: expected.rifleRecovery,
    footCombat: expected.footCombat,
    shieldCombat: expected.shieldCombat,
    areaCombat: expected.areaCombat,
    tankCombat: expected.tankCombat,
    cannonCombat: expected.cannonCombat,
    ordnance: expected.ordnance,
    hmg: expected.hmg,
    support: expected.support,
    rocket: expected.rocket,
    rocketCombat: expected.rocketCombat,
    beam: expected.beam,
    laserCombat: expected.laserCombat,
    weaponPickups: expected.weaponPickups,
    pickupCombat: expected.pickupCombat,
    materials: expected.materials,
    combatReconnect: expected.combatReconnect,
    eventDelivery: expected.eventDelivery,
    firearmFeedback: expected.firearmFeedback,
    mixedInputRecovery: expected.mixedInputRecovery,
    collisionResults: {
      solidHits: expected.collision.samples.filter((sample) => sample.solid?.kind === "hit").length,
      initialOverlaps: expected.collision.samples.filter(
        (sample) => sample.solid?.kind === "overlap",
      ).length,
      oneWayHits: expected.collision.samples.filter((sample) => sample.oneWay !== null).length,
    },
    status: "pass",
    scope:
      "Portable simulation, input/snapshot/recovery, released-rocket and beam-charge fixtures in Node, Chromium and local workerd. No production gameplay, deployed cadence or per-tick CPU claim.",
  };
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(
    `${output}/failure.json`,
    `${JSON.stringify({ phase, error: String(error), durationsMs, serverLog }, null, 2)}\n`,
  );
  throw error;
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

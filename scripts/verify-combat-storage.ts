import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { verifyStoredCampaign } from "./lib/verify-stored-campaign.js";
import { verifyStoredFootCombat } from "./lib/verify-stored-foot-combat.js";
import { verifyStoredPhases } from "./lib/verify-stored-phases.js";
import { verifyStoredRifle } from "./lib/verify-stored-rifle.js";

const require = createRequire(import.meta.url);
const workerRequire = createRequire(require.resolve("wrangler/package.json"));
const { Miniflare, Log, LogLevel, convertV4MiniflareOptions } = workerRequire("miniflare");
const output = "dist/combat-storage-proof";
await mkdir(output, { recursive: true });
await rm(`${output}/report.json`, { force: true });
const directory = await mkdtemp(join(tmpdir(), "edgefall-combat-storage-"));
const bundle = await build({
  entryPoints: ["test/fixtures/combat-storage-worker.ts"],
  bundle: true,
  external: ["cloudflare:workers"],
  platform: "neutral",
  format: "esm",
  write: false,
  metafile: true,
});
const script = bundle.outputFiles[0]?.text;
assert(script, "Missing storage Worker");
const source = createHash("sha256");
for (const path of Object.keys(bundle.metafile.inputs).sort())
  source
    .update(path)
    .update("\0")
    .update(await readFile(path))
    .update("\0");
const create = () =>
  new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-08-30",
      durableObjects: { STORES: { className: "CombatStorageProof", useSQLite: true } },
      resourcePersistencePath: directory,
      log: new Log(LogLevel.ERROR),
    }),
  );
let runtime = create();
const origin = async () => {
  const url: URL = await runtime.ready;
  url.hostname = "127.0.0.1";
  return url.origin;
};
try {
  const seedResponse = await fetch(`${await origin()}/proof/seed`, { method: "POST" });
  assert(seedResponse.ok, `Storage setup failed: ${await seedResponse.clone().text()}`);
  const seeded = (await seedResponse.json()) as {
    instance: string;
    tick: number;
    observedTick: number;
    rollbackTick: number;
    rollbackTicks: number[];
    hash: string;
  };
  assert.equal(seeded.tick, 105);
  assert.equal(seeded.observedTick, 119);
  assert.equal(seeded.rollbackTick, 90);
  assert.deepEqual(seeded.rollbackTicks, [45, 90]);
  await runtime.dispose();
  runtime = create();
  const restoredResponse = await fetch(`${await origin()}/proof/restore`);
  assert(restoredResponse.ok, `Cold restore failed: ${await restoredResponse.clone().text()}`);
  const restored = (await restoredResponse.json()) as {
    instance: string;
    tick: number;
    hash: string;
    rows: unknown[];
  };
  assert.notEqual(restored.instance, seeded.instance, "Durable Object instance was reused");
  assert.equal(restored.tick, seeded.tick);
  assert.equal(restored.hash, seeded.hash);
  assert.equal(restored.rows.length, 5);
  const gapResponse = await fetch(`${await origin()}/proof/gap`, { method: "POST" });
  assert.equal(gapResponse.status, 409, "Missing journal segment was silently accepted");
  const gap = await gapResponse.json();
  const tailState = async (action: string) => {
    const response = await fetch(`${await origin()}/tail/${action}`, { method: "POST" });
    assert(response.ok, `Tail ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      roomMode: string;
      hash: string;
      rows: unknown[];
    };
  };
  const seededTail = await tailState("seed-tail");
  assert.equal(seededTail.tick, 59);
  assert.equal(seededTail.rows.length, 6);
  await runtime.dispose();
  runtime = create();
  const restoredTail = await tailState("restore");
  assert.notEqual(restoredTail.instance, seededTail.instance);
  assert.equal(restoredTail.hash, seededTail.hash);
  assert.equal(restoredTail.tick, 59);
  const pausedTail = await tailState("pause-tail");
  assert.equal(pausedTail.roomMode, "paused-empty");
  assert.equal(pausedTail.rows.length, 2);
  await runtime.dispose();
  runtime = create();
  const coldPause = await tailState("restore");
  assert.notEqual(coldPause.instance, pausedTail.instance);
  assert.equal(coldPause.hash, pausedTail.hash);
  assert.equal(coldPause.tick, 59);
  assert.equal(coldPause.roomMode, "paused-empty");
  const expiredTail = await tailState("expire-tail");
  assert.equal(expiredTail.roomMode, "expired");
  await runtime.dispose();
  runtime = create();
  const coldExpired = await tailState("resurrect");
  assert.notEqual(coldExpired.instance, expiredTail.instance);
  assert.equal(coldExpired.hash, expiredTail.hash);
  assert.equal(coldExpired.roomMode, "expired");
  assert.equal(coldExpired.tick, 59);
  const loadingState = async (action: string) => {
    const response = await fetch(`${await origin()}/loading/${action}`, { method: "POST" });
    assert(response.ok, `Loading ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      roomMode: string;
      runEpoch: number;
      hash: string;
      connections: Array<{
        playerId: number;
        connectionEpoch: number;
        controlEpoch: number;
        lastProcessedSequence: number;
      }>;
      loadingChecks: string[] | null;
    };
  };
  const seededLoading = await loadingState("seed-loading");
  const replacedLoading = await loadingState("replace-loading");
  assert.equal(replacedLoading.tick, 45);
  assert.equal(replacedLoading.runEpoch, seededLoading.runEpoch);
  assert.equal(replacedLoading.roomMode, "loading");
  assert.notEqual(replacedLoading.hash, seededLoading.hash);
  assert.deepEqual(replacedLoading.loadingChecks, ["sql-rollback", "changed-prefix-rejected"]);
  assert.deepEqual(
    replacedLoading.connections,
    seededLoading.connections.map((connection) => ({
      ...connection,
      connectionEpoch: connection.connectionEpoch + (connection.playerId === 2 ? 1 : 0),
    })),
  );
  await runtime.dispose();
  runtime = create();
  const coldLoading = await loadingState("restore");
  assert.notEqual(coldLoading.instance, replacedLoading.instance);
  assert.equal(coldLoading.hash, replacedLoading.hash);
  assert.equal(coldLoading.tick, replacedLoading.tick);
  assert.equal(coldLoading.runEpoch, replacedLoading.runEpoch);
  assert.equal(coldLoading.roomMode, "loading");
  assert.deepEqual(coldLoading.connections, replacedLoading.connections);
  const phases = await verifyStoredPhases(origin, async () => {
    await runtime.dispose();
    runtime = create();
  });
  const campaign = await verifyStoredCampaign(origin, async () => {
    await runtime.dispose();
    runtime = create();
  });
  const lifeState = async (action: string) => {
    const response = await fetch(`${await origin()}/life/${action}`, { method: "POST" });
    assert(response.ok, `Life ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      lives: Array<{
        life: string;
        lifeStartTick: number;
        lives: number;
        invulnerableTicks: number;
      }>;
    };
  };
  const dying = await lifeState("seed-life");
  assert.equal(dying.lives[0]?.life, "death");
  assert.equal(dying.lives[0]?.lives, 2);
  assert.equal(dying.tick - (dying.lives[0]?.lifeStartTick ?? NaN), 21);
  await runtime.dispose();
  runtime = create();
  const coldDeath = await lifeState("restore");
  assert.notEqual(coldDeath.instance, dying.instance);
  assert.equal(coldDeath.hash, dying.hash);
  assert.deepEqual(coldDeath.lives, dying.lives);
  const entering = await lifeState("resume-life");
  assert.equal(entering.lives[0]?.life, "respawning");
  assert.equal(entering.lives[0]?.lives, 2);
  assert.equal(entering.lives[0]?.invulnerableTicks, 114);
  assert.equal(entering.tick - (entering.lives[0]?.lifeStartTick ?? NaN), 6);
  await runtime.dispose();
  runtime = create();
  const coldEntry = await lifeState("restore");
  assert.notEqual(coldEntry.instance, entering.instance);
  assert.equal(coldEntry.hash, entering.hash);
  assert.deepEqual(coldEntry.lives, entering.lives);
  const report = {
    footCombat: await verifyStoredFootCombat(origin, async () => {
      await runtime.dispose();
      runtime = create();
    }),
    rifle: await verifyStoredRifle(origin, async () => {
      await runtime.dispose();
      runtime = create();
    }),
    recordedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceSha256: source.digest("hex"),
    workerBundleSha256: createHash("sha256").update(script).digest("hex"),
    wrangler: require("wrangler/package.json").version,
    seeded,
    restored,
    gap,
    tail: { seededTail, restoredTail, pausedTail, coldPause, expiredTail, coldExpired },
    loading: { seededLoading, replacedLoading, coldLoading },
    phases,
    campaign,
    life: { dying, coldDeath, entering, coldEntry, transactionRollback: ["death", "entry"] },
    status: "pass",
    scope:
      "Owned local SQLite Durable Object and fresh workerd processes. Actual wipe/continue checkpoint reset, spent credits, fresh IDs, rollback, stale host/prefix rejection and lost response after commit; death/entry recovery and room phase regressions. No authored mission progression, deployed durability or production outbox claim.",
  };
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}

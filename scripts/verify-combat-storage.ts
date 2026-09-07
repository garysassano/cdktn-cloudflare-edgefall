import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

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
  const report = {
    recordedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceSha256: source.digest("hex"),
    workerBundleSha256: createHash("sha256").update(script).digest("hex"),
    wrangler: require("wrangler/package.json").version,
    seeded,
    restored,
    gap,
    status: "pass",
    scope:
      "Owned local SQLite Durable Object and fresh workerd process. Checkpoint/journal reconstruction and atomic rollback; no production room, client recovery barrier or deployed durability claim.",
  };
  await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}

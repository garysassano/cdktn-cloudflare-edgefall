import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";
import {
  MATERIAL_LAB_WEAPONS,
  type MaterialLabDefinition,
  materialScenario,
} from "../src/game/content/scenarios/materials.js";
import { combatScenarioId } from "../src/game/labs/combat-scenarios.js";

const surfaces = [
  "concrete",
  "timber",
  "armor-steel",
  "open-grating",
  "timber",
  "armor-steel",
  "timber",
  "open-grating",
] as const;
const definitions: MaterialLabDefinition[] = [1, 4].flatMap((players) =>
  MATERIAL_LAB_WEAPONS.map((weapon, index) => ({
    weapon,
    materialId: surfaces[index] ?? "concrete",
    targetMotion: players === 1 ? "stationary" : "patrol",
    players,
  })),
);
const output = "dist/network-material-room-evidence",
  reports = [];
const resume = process.argv.includes("--resume");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const workerBundle = await build({
  entryPoints: ["src/worker/diagnostics/room-probe.ts"],
  bundle: true,
  external: ["cloudflare:workers"],
  platform: "neutral",
  format: "esm",
  write: false,
});
const clientBundle = await build({
  entryPoints: [resolve("src/client/network-lab.ts")],
  bundle: true,
  outfile: resolve("dist/client/network-lab.js"),
  platform: "browser",
  target: "es2022",
  format: "iife",
  write: false,
});
const workerBytes = workerBundle.outputFiles[0]?.contents,
  clientBytes = clientBundle.outputFiles[0]?.contents;
assert(workerBytes && clientBytes);
const validPrevious = async (entry: string) => {
  if (!resume) return false;
  try {
    const previous = JSON.parse(await readFile(`${entry}/report.json`, "utf8")),
      execution = JSON.parse(await readFile(`${entry}/execution.json`, "utf8"));
    if (
      previous.status !== "pass" ||
      previous.workerBundleSha256 !== sha256(workerBytes) ||
      previous.bundleSha256 !== sha256(clientBytes)
    )
      return false;
    for (const source of execution.sources)
      if (sha256(await readFile(source.file)) !== source.sha256) return false;
    return true;
  } catch {
    return false;
  }
};
await mkdir(output, { recursive: true });
for (const definition of definitions) {
  const scenario = materialScenario(definition),
    id = `${definition.players}-${combatScenarioId(scenario)}`,
    entry = `${output}/${id}`;
  await mkdir(entry, { recursive: true });
  if (!(await validPrevious(entry))) {
    const child = spawn(
      "pnpm",
      [
        "tsx",
        "scripts/verify-network-controller.ts",
        `--combat-material=${scenario}`,
        `--combat-players=${definition.players}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let log = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk: Buffer) => {
        log += chunk.toString();
      });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    await writeFile(`${entry}/execution.log`, log);
    assert.equal(code, 0, `Material network case ${id} failed; see ${entry}/execution.log`);
  }
  const raw = await readFile(`${entry}/report.json`),
    report = JSON.parse(raw.toString());
  assert.equal(report.status, "pass");
  assert.deepEqual(report.materialRoom.definition, definition);
  reports.push({
    definition,
    directory: entry,
    reportSha256: createHash("sha256").update(raw).digest("hex"),
    sharedSnapshots: report.sharedSnapshots,
    ticks: report.clients.map((client: { snapshotTick: number }) => client.snapshotTick),
    events: report.materialRoom.events.length,
    finalCoverHealth: report.room.combat.world.props[0].health,
  });
  console.log(`Material network case ${reports.length}/${definitions.length} passed: ${id}`);
}
await writeFile(
  `${output}/report.json`,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      status: "pass",
      recordedAt: new Date().toISOString(),
      cases: reports,
      scope:
        "Sixteen representative real-keyboard network cases: all eight action families with solo stationary and four-player moving targets, collectively covering all four materials. Each case drops four event frames per client, duplicates delivery, checks accepted inventory and drawn geometry, and compares terminal snapshots. The complete 128-case material matrix is covered separately by three-runtime and cold SQLite checks; this network subset does not claim all 128 combinations or deployed cadence.",
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify({ status: "pass", cases: reports.length, output }));

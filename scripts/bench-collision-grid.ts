import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform } from "node:os";
import { build } from "esbuild";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import { type MovementResult, moveKinematic } from "../src/game/physics/move.js";
import { SPATIAL_FRAME, spatialProof, spatialScene } from "../test/fixtures/spatial-proof.js";

assert.equal(process.argv.length, 2, "This is a fixed, local-only engineering benchmark");
const scene = spatialScene();
const reference = scene.bodies.map((body) =>
  moveKinematic(body, [...scene.fixed, ...scene.moving]),
);
const timed = <T>(run: () => T) => {
  const start = process.hrtime.bigint();
  const value = run();
  return { value, ms: Number(process.hrtime.bigint() - start) / 1e6 };
};
const summarize = (samples: number[]) => {
  const ordered = [...samples].sort((a, b) => a - b);
  return {
    samples,
    minimum: ordered[0],
    median: ordered[Math.floor(ordered.length / 2)],
    maximum: ordered.at(-1),
  };
};
function measure(run: () => MovementResult[]) {
  for (let i = 0; i < 3; i++) assert.deepEqual(run(), reference);
  return summarize(
    Array.from({ length: 9 }, () => {
      const sample = timed(run);
      assert.deepEqual(sample.value, reference);
      return sample.ms;
    }),
  );
}
const fullScanMs = measure(() =>
  scene.bodies.map((body) => moveKinematic(body, [...scene.fixed, ...scene.moving])),
);
const indexed = ([32, 64] as const).map((cellPixels) => {
  const built = timed(() => new CollisionGrid(scene.fixed, cellPixels));
  const fixed = built.value;
  const frameMs = measure(() => {
    const index = new CollisionIndex(fixed, scene.moving, SPATIAL_FRAME);
    return scene.bodies.map((body) => moveKinematic(body, index, { frame: SPATIAL_FRAME }));
  });
  return { cellPixels, staticBuildMs: built.ms, frameMs };
});
const graph = await build({
  entryPoints: ["scripts/bench-collision-grid.ts"],
  bundle: true,
  platform: "node",
  packages: "external",
  format: "esm",
  metafile: true,
  write: false,
});
const source = createHash("sha256");
for (const path of Object.keys(graph.metafile.inputs).sort())
  source
    .update(path)
    .update("\0")
    .update(await readFile(path))
    .update("\0");
const proof = spatialProof();
const report = {
  schemaVersion: 1,
  package: "W03",
  recordedAt: new Date().toISOString(),
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  sourceSha256: source.digest("hex"),
  runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  workload: {
    fixed: proof.fixed,
    moving: proof.moving,
    bodies: proof.bodies,
    resultHash: proof.referenceHash,
  },
  fullScanMs,
  indexed,
  candidates: proof.cells.map(({ outcomes: _outcomes, ...summary }) => summary),
  status: "equivalent-results",
  scope:
    "Local Node microbenchmark, three warmup frames/nine measured frames; timings include 64 movement queries and dynamic index construction, exclude reused static build and result comparison. Static build is one cold observation. Not representative combat CPU, deployed cadence or a performance gate.",
};
await mkdir("dist/collision-grid-benchmark", { recursive: true });
await writeFile(
  "dist/collision-grid-benchmark/report.json",
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(JSON.stringify(report));

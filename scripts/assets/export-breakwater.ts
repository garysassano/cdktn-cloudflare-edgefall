import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { BREAKWATER } from "../../src/game/missions/breakwater-content.js";
import { BREAKWATER_ART } from "../../src/shared/animation/breakwater.js";
import { inspectArtImage } from "../lib/art-image.js";
import { compileNativeArt } from "../lib/native-art.js";

const check = process.argv.includes("--check"),
  sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const manifestPath = "public/assets/manifest.json",
  provenancePath = "art/source/provenance.json",
  manifest = JSON.parse(await readFile(manifestPath, "utf8")),
  provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const reports = [];
for (const asset of BREAKWATER_ART) {
  const sourcePath = `art/source/${asset.source}.pixels.json`,
    raw = await readFile(sourcePath),
    built = await compileNativeArt(raw, `${asset.id}.png`),
    { atlas, source } = built;
  if (asset.id === "lock-engine")
    for (const name of ["engine-idle", "engine-windup", "engine-fire"])
      assert.deepEqual(atlas.meta.edgefall.drawings[name]?.sockets?.muzzle, [
        BREAKWATER.boss.muzzle.x,
        BREAKWATER.boss.muzzle.y,
      ]);
  const audit = await inspectArtImage(built.png, {
    nativeWidth: atlas.meta.size.w,
    nativeHeight: atlas.meta.size.h,
    pixelScale: 1,
    columns: 8,
    rows: atlas.meta.size.h / (source.canvas.height + 4),
  });
  assert(audit.canImportUnchanged, "Mission atlas violates native alpha/pixel policy");
  const directory = `public/assets/art/${asset.directory}`,
    files = [
      { path: `${directory}/${asset.id}.png`, bytes: built.png },
      {
        path: `${directory}/${asset.id}.atlas.json`,
        bytes: Buffer.from(`${JSON.stringify(atlas, null, 2)}\n`),
      },
    ],
    sourceId = `edgefall-native-${asset.id}`;
  const sourceRecord = {
    creator: source.creator,
    licence: source.licence,
    provenance: `Original indexed-pixel source in ${sourcePath}; pnpm art:export rebuilds the atlas. Human style review pending.`,
  };
  const entries = files.map(({ path, bytes }) => ({
    path: path.replace(/^public\//, ""),
    bytes: bytes.length,
    sha256: sha(bytes),
    source: sourceId,
    licence: source.licence,
    maxBytes: path.endsWith(".png") ? 500000 : 256000,
    ...(path.endsWith(".png")
      ? {
          png: { width: atlas.meta.size.w, height: atlas.meta.size.h, colorType: 6 },
          atlas: `assets/art/${asset.directory}/${asset.id}.atlas.json`,
        }
      : {}),
  }));
  const origin = {
    id: source.id,
    file: sourcePath,
    bytes: raw.length,
    sha256: built.sourceSha256,
    creator: source.creator,
    licence: source.licence,
    role: "native-benchmark-candidate",
    references: [],
    method:
      "Original literal palette-indexed source rows for Breakwater Approach; no sampled reference pixels or runtime figure generation.",
    export: "pnpm art:export",
    humanReview: { status: "pending", reviewer: null },
  };
  if (check) {
    for (const file of files)
      assert((await readFile(file.path)).equals(file.bytes), `Stale mission asset ${file.path}`);
    assert.deepEqual(manifest.sources[sourceId], sourceRecord);
    for (const entry of entries)
      assert.deepEqual(
        manifest.assets.find((e: { path: string }) => e.path === entry.path),
        entry,
      );
    assert.deepEqual(
      provenance.nativeDrawings.find((e: { id: string }) => e.id === source.id),
      origin,
    );
  } else {
    await mkdir(directory, { recursive: true });
    for (const file of files) await writeFile(file.path, file.bytes);
    manifest.sources[sourceId] = sourceRecord;
    manifest.assets = manifest.assets
      .filter((e: { path: string }) => !entries.some((entry) => entry.path === e.path))
      .concat(entries);
    provenance.nativeDrawings = provenance.nativeDrawings
      .filter((e: { id: string }) => e.id !== source.id)
      .concat(origin);
  }
  reports.push({
    id: asset.id,
    source: sourcePath,
    sourceSha256: built.sourceSha256,
    drawings: source.frames.length,
    root: source.canvas.root,
    frameHashes: built.frameHashes,
    image: audit,
  });
}
const report = {
    status: "pass",
    art: reports,
    humanReview: "pending",
    scope:
      "Native original scenery, caches, destructible and mechanical-target candidates for the continuous W06 lane. Human style approval remains open.",
  },
  reportPath = "docs/redesign-evidence/style-v2/native-breakwater.json";
if (check) assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
else {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    status: "pass",
    drawings: reports.reduce((n, r) => n + r.drawings, 0),
    humanReview: "pending",
  }),
);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { actionPose } from "../../src/game/combat/timeline.js";
import {
  COMBAT_CATALOG,
  RIFLE_PROFILE,
  SHIELD_PROFILE,
  TANK_PROFILE,
} from "../../src/game/labs/combat-content.js";
import { CAST_ART, CAST_TIMING } from "../../src/shared/animation/cast.js";
import { nativeExposure } from "../../src/shared/animation/native.js";
import { inspectArtImage } from "../lib/art-image.js";
import { compileNativeArt } from "../lib/native-art.js";

const check = process.argv.includes("--check"),
  sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const manifestPath = "public/assets/manifest.json",
  provenancePath = "art/source/provenance.json";
const manifest = JSON.parse(await readFile(manifestPath, "utf8")),
  provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const reports = [];
for (const asset of CAST_ART) {
  const sourcePath = `art/source/${asset.source}.pixels.json`,
    raw = await readFile(sourcePath);
  const built = await compileNativeArt(raw, `${asset.id}.png`),
    { atlas, source } = built;
  const clip = (id: string) => {
    const c = source.clips.find((c) => c.id === id);
    assert(c, `Missing cast clip ${id}`);
    return c;
  };
  const duration = (id: string) => clip(id).exposures.reduce((n, e) => n + e.ticks, 0);
  const socket = (frame: string, name: "muzzle" | "hand", point: { x: number; y: number }) =>
    assert.deepEqual(
      atlas.meta.edgefall.drawings[frame]?.sockets?.[name],
      [point.x / 256, point.y / 256],
      "Cast socket differs from simulation",
    );
  if (asset.id === "quay-watch") {
    for (const [aim, id] of RIFLE_PROFILE.timelineIds.entries()) {
      const name = aim === 0 ? "watch.fire" : "watch.fire.up";
      assert.equal(duration(name), COMBAT_CATALOG.timelines.get(id)?.durationTicks);
      for (const tick of CAST_TIMING.rifle.releases) {
        const point = actionPose(COMBAT_CATALOG, id, tick)?.sockets.find(
          (s) => s.name === "muzzle",
        )?.point;
        assert(point);
        socket(nativeExposure(clip(name), tick), "muzzle", point);
      }
    }
  } else if (asset.id === "breakwater") {
    for (const name of ["breakwater.bash", "breakwater.bash.broken"]) {
      assert.equal(
        duration(name),
        COMBAT_CATALOG.timelines.get(SHIELD_PROFILE.timelineIds.bash)?.durationTicks,
      );
      for (
        let tick = CAST_TIMING.shield.activeStart;
        tick < CAST_TIMING.shield.activeStart + CAST_TIMING.shield.activeTicks;
        tick++
      ) {
        const point = actionPose(
          COMBAT_CATALOG,
          SHIELD_PROFILE.timelineIds.bash,
          tick,
        )?.sockets.find((s) => s.name === "hand")?.point;
        assert(point);
        socket(nativeExposure(clip(name), tick), "hand", point);
      }
    }
  } else {
    for (const name of ["kestrel.board", "kestrel.exit"])
      assert(
        new Set(clip(name).exposures.map((e) => built.frameHashes[`p1/${e.frame}`])).size >= 8,
        "Crew transfers need distinct acting drawings",
      );
    assert.equal(
      duration("kestrel.board"),
      COMBAT_CATALOG.timelines.get(TANK_PROFILE.definition.seat.boardingTimelineId)?.durationTicks,
    );
    assert.equal(
      duration("kestrel.exit"),
      COMBAT_CATALOG.timelines.get(TANK_PROFILE.exitTimelineId)?.durationTicks,
    );
    for (const [heading, value] of TANK_PROFILE.headings.entries())
      socket(`kestrel-turret-${heading}`, "muzzle", value.muzzle);
  }
  const audit = await inspectArtImage(built.png, {
    nativeWidth: atlas.meta.size.w,
    nativeHeight: atlas.meta.size.h,
    pixelScale: 1,
    columns: 8,
    rows: atlas.meta.size.h / (source.canvas.height + 4),
  });
  assert(audit.canImportUnchanged, "Cast PNG violates pixel/alpha policy");
  const directory = `public/assets/art/${asset.directory}`;
  const files = [
    { path: `${directory}/${asset.id}.png`, bytes: built.png },
    {
      path: `${directory}/${asset.id}.atlas.json`,
      bytes: Buffer.from(`${JSON.stringify(atlas, null, 2)}\n`),
    },
  ];
  const sourceId = `edgefall-native-${asset.id}`;
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
      "Original literal palette-indexed pixel rows; no sampled reference pixels, runtime figure generation or whole-character rotation.",
    export: "pnpm art:export",
    humanReview: { status: "pending", reviewer: null },
  };
  if (check) {
    for (const file of files)
      assert((await readFile(file.path)).equals(file.bytes), `Stale cast asset ${file.path}`);
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
    variants: atlas.meta.edgefall.variants.length,
    clips: source.clips,
    frameHashes: built.frameHashes,
    image: audit,
  });
}
const report = {
  status: "pass",
  cast: reports,
  humanReview: "pending",
  scope:
    "Native enemy/vehicle candidates with accepted release, bash and seat timing, eight independent turret headings, exact PNG/provenance and bounded pixel/texture output. Full W06 environment/effects/audio specimen and human style approval remain open.",
};
const reportPath = "docs/redesign-evidence/style-v2/native-cast.json";
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
    families: reports.length,
    humanReview: "pending",
  }),
);

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { actionPose } from "../../src/game/combat/timeline.js";
import { CONTRACT_FIXTURE } from "../../src/game/content/contract-fixture.js";
import { COMBAT_CATALOG } from "../../src/game/labs/combat-content.js";
import { ARCADE } from "../../src/game/rules.js";
import { nativeExposure } from "../../src/shared/animation/native.js";
import {
  OPERATIVE_ACTIONS,
  OPERATIVE_ARSENAL,
  OPERATIVE_POSES,
} from "../../src/shared/animation/operative.js";
import { inspectArtImage } from "../lib/art-image.js";
import { compileNativeArt } from "../lib/native-art.js";

const check = process.argv.includes("--check"),
  sourcePath = "art/source/hero/operative.pixels.json";
const raw = await readFile(sourcePath),
  built = await compileNativeArt(raw, "operative.png");
assert.deepEqual(built.source.canvas, { width: 64, height: 64, root: [24, 48] });
const output = "public/assets/art/hero",
  reportPath = "docs/redesign-evidence/style-v2/native-frames.json";
const audit = await inspectArtImage(built.png, {
  nativeWidth: built.atlas.meta.size.w,
  nativeHeight: built.atlas.meta.size.h,
  pixelScale: 1,
  columns: 8,
  rows: built.atlas.meta.size.h / 68,
});
assert(audit.canImportUnchanged, "Native export failed actual pixel checks");
const bindings = Object.entries(OPERATIVE_POSES);
for (const [frame, id] of bindings) {
  const pose = COMBAT_CATALOG.poses.get(id),
    muzzle = pose?.sockets.find((socket) => socket.name === "muzzle")?.point;
  assert(muzzle, "Missing authoritative pose muzzle");
  assert.deepEqual(
    built.atlas.meta.edgefall.drawings[frame]?.sockets?.muzzle,
    [muzzle.x / 256, muzzle.y / 256],
    "Native muzzle differs from simulation",
  );
  const clip = built.source.clips.find((clip) => clip.id === `upper.fire.${frame.slice(6)}`);
  const timeline = COMBAT_CATALOG.timelines.get(id);
  assert(clip && timeline, "Missing sidearm visual/action clip");
  assert.equal(
    clip.exposures.reduce((total, exposure) => total + exposure.ticks, 0),
    timeline.durationTicks,
    "Sidearm recoil duration differs from action",
  );
  for (const marker of timeline.markers)
    if (marker.socket === "muzzle") {
      const eventFrame = nativeExposure(clip, marker.tickOffset);
      assert.deepEqual(
        built.atlas.meta.edgefall.drawings[eventFrame]?.sockets?.muzzle,
        [muzzle.x / 256, muzzle.y / 256],
        "Visual release muzzle differs from authoritative event",
      );
    }
  assert(
    new Set(clip.exposures.map((exposure) => built.frameHashes[`p1/${exposure.frame}`])).size >= 3,
    "Recoil must contain three distinct drawings",
  );
}
const run = built.source.clips.find((clip) => clip.id === "legs.run");
for (const binding of OPERATIVE_ARSENAL) {
  const timeline = COMBAT_CATALOG.timelines.get(binding.timelineId),
    clip = built.source.clips.find((c) => c.id === binding.clip);
  assert(timeline && clip, "Missing arsenal action/clip");
  assert.equal(
    clip.exposures.reduce((sum, e) => sum + e.ticks, 0),
    timeline.durationTicks,
  );
  for (const marker of timeline.markers.filter((m) => m.socket === "muzzle")) {
    const pose = actionPose(COMBAT_CATALOG, binding.timelineId, marker.tickOffset),
      muzzle = pose?.sockets.find((s) => s.name === "muzzle")?.point;
    assert(muzzle, "Missing authoritative arsenal socket");
    assert.deepEqual(
      built.atlas.meta.edgefall.drawings[nativeExposure(clip, marker.tickOffset)]?.sockets?.muzzle,
      [muzzle.x / 256, muzzle.y / 256],
      "Arsenal release muzzle differs from simulation",
    );
  }
  assert(
    new Set(clip.exposures.map((e) => built.frameHashes[`p1/${e.frame}`])).size >= 2,
    "Arsenal recoil/pulse drawings must differ",
  );
}
for (const drawing of Object.values(built.atlas.meta.edgefall.drawings))
  if (drawing.sockets?.muzzle) assert(drawing.sockets.grip, "Native firearm lacks a grip");
const actionBindings = Object.entries(OPERATIVE_ACTIONS);
for (const [id, binding] of actionBindings) {
  const timeline = COMBAT_CATALOG.timelines.get(Number(id));
  const clip = built.source.clips.find((clip) => clip.id === binding.clip);
  assert(clip && timeline, "Missing native action binding");
  for (const exposure of clip.exposures)
    assert(
      built.atlas.meta.edgefall.drawings[exposure.frame]?.sockets?.hand,
      "Native action drawing lacks its authored hand",
    );
  assert.equal(
    clip.exposures.reduce((n, e) => n + e.ticks, 0),
    timeline.durationTicks,
    "Native action duration mismatch",
  );
  assert(
    new Set(clip.exposures.map((e) => built.frameHashes[`p1/${e.frame}`])).size >= 5,
    "Native action requires distinct acting drawings",
  );
  for (const marker of timeline.markers) {
    const pose = actionPose(COMBAT_CATALOG, Number(id), marker.tickOffset);
    const point = pose?.sockets.find((s) => s.name === marker.socket)?.point;
    assert(point && marker.socket === "hand", "Missing authoritative action hand");
    const end =
      binding.kind === "melee" && marker.kind === "activate-hitbox"
        ? marker.tickOffset + pose.durationTicks
        : marker.tickOffset + 1;
    for (let age = marker.tickOffset; age < end; age++)
      assert.deepEqual(
        built.atlas.meta.edgefall.drawings[nativeExposure(clip, age)]?.sockets?.hand,
        [point.x / 256, point.y / 256],
        "Native release/active hand differs from simulation",
      );
  }
}
for (const [id, duration, minDrawings] of [
  ["body.death", ARCADE.deathTicks, 8],
  ["body.reentry", ARCADE.respawnEntryTicks, 4],
] as const) {
  const clip = built.source.clips.find((clip) => clip.id === id);
  assert(clip && clip.channel === "full-body", "Missing native life clip");
  assert.equal(
    clip.exposures.reduce((n, e) => n + e.ticks, 0),
    duration,
    "Native life duration mismatch",
  );
  assert(
    new Set(clip.exposures.map((e) => built.frameHashes[`p1/${e.frame}`])).size >= minDrawings,
    "Native life acting drawings are duplicates",
  );
}
assert(run && run.exposures.length === 8);
assert.equal(
  new Set(run.exposures.map((exposure) => built.frameHashes[`p1/${exposure.frame}`])).size,
  8,
  "Run drawings are duplicates",
);
const runSpeed = (CONTRACT_FIXTURE.actors.find((actor) => actor.id === 1)?.runSpeed ?? 0) / 256;
const contacts = run.exposures.map(
  (exposure) => built.atlas.meta.edgefall.drawings[exposure.frame]?.contact,
);
for (let index = 1; index < contacts.length; index++) {
  const before = contacts[index - 1],
    after = contacts[index];
  assert(before && after, "Run exposure lacks contact metadata");
  if (before.foot === after.foot)
    assert.equal(
      after.point[0] - before.point[0],
      -runSpeed * (run.exposures[index - 1]?.ticks ?? 0),
      "Run contact spacing differs from movement speed",
    );
}
const atlasBytes = Buffer.from(`${JSON.stringify(built.atlas, null, 2)}\n`),
  sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const files = [
  { path: `${output}/operative.png`, bytes: built.png },
  { path: `${output}/operative.atlas.json`, bytes: atlasBytes },
];
const report = {
  status: "pass",
  source: sourcePath,
  sourceSha256: built.sourceSha256,
  drawings: built.source.frames.length,
  paletteVariants: Object.keys(built.source.variants).length,
  runDrawings: 8,
  runDurationTicks: run.exposures.reduce((n, e) => n + e.ticks, 0),
  contactTravelPixelsPerTick: runSpeed,
  contacts,
  sidearmRecoilClips: bindings.length,
  arsenalBindings: OPERATIVE_ARSENAL,
  actionBindings,
  fullBodyClips: ["body.death", "body.reentry"],
  bindings: bindings.map(([frame, poseId]) => ({ frame, poseId })),
  image: audit,
  frameHashes: built.frameHashes,
  humanReview: "pending",
  scope:
    "Native operative benchmark candidate. Indexed pixels, action/life exposure durations, active/release hand sockets, firearm grips and sidearm/HMG/shotgun/flame muzzles are checked. Final weapon acting, effects, motion/feel and W06 acceptance remain open.",
};
const manifestPath = "public/assets/manifest.json",
  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const record = {
  creator: built.source.creator,
  licence: built.source.licence,
  provenance: `Hand-authored indexed-pixel source in ${sourcePath}, concept design reference hero-key-poses-01. Exported with pnpm art:export. Human style review pending.`,
};
const entries = files.map(({ path, bytes }) => ({
  path: path.replace(/^public\//, ""),
  bytes: bytes.length,
  sha256: sha(bytes),
  source: "edgefall-native-operative",
  licence: built.source.licence,
  maxBytes: path.endsWith(".png") ? 500000 : 256000,
  ...(path.endsWith(".png")
    ? {
        png: { width: built.atlas.meta.size.w, height: built.atlas.meta.size.h, colorType: 6 },
        atlas: "assets/art/hero/operative.atlas.json",
      }
    : {}),
}));
const provenancePath = "art/source/provenance.json",
  provenance = JSON.parse(await readFile(provenancePath, "utf8"));
const nativeRecord = {
  id: built.source.id,
  file: sourcePath,
  bytes: raw.length,
  sha256: built.sourceSha256,
  creator: built.source.creator,
  licence: built.source.licence,
  role: "native-benchmark-candidate",
  references: ["hero-key-poses-01"],
  method:
    "Explicit palette-indexed pixel rows authored by Codex; design reference only, no sampled concept pixels.",
  export: "pnpm art:export",
  humanReview: { status: "pending", reviewer: null },
};
if (check) {
  for (const file of files)
    assert((await readFile(file.path)).equals(file.bytes), `Stale native export: ${file.path}`);
  assert.deepEqual(
    JSON.parse(await readFile(reportPath, "utf8")),
    report,
    "Stale native review report",
  );
  assert.deepEqual(manifest.sources["edgefall-native-operative"], record);
  for (const entry of entries)
    assert.deepEqual(
      manifest.assets.find((asset: { path: string }) => asset.path === entry.path),
      entry,
      "Native manifest differs",
    );
  assert.deepEqual(
    provenance.nativeDrawings?.find((entry: { id: string }) => entry.id === nativeRecord.id),
    nativeRecord,
    "Native provenance differs",
  );
} else {
  await mkdir(output, { recursive: true });
  for (const file of files) await writeFile(file.path, file.bytes);
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  manifest.sources["edgefall-native-operative"] = record;
  manifest.assets = manifest.assets
    .filter((asset: { path: string }) => !entries.some((entry) => entry.path === asset.path))
    .concat(entries);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  provenance.nativeDrawings = (provenance.nativeDrawings ?? [])
    .filter((entry: { id: string }) => entry.id !== nativeRecord.id)
    .concat(nativeRecord);
  await writeFile(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
}
console.log(
  JSON.stringify({
    status: "pass",
    drawings: report.drawings,
    variants: report.paletteVariants,
    humanReview: report.humanReview,
  }),
);

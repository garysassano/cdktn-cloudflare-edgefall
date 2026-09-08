import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";

const destination = "docs/redesign-evidence/style-v2/operative-air",
  output = "dist/operative-air-evidence",
  hash = (b) => createHash("sha256").update(b).digest("hex"),
  json = async (p) => JSON.parse(await readFile(p, "utf8")),
  files = new Map();
await assert.rejects(access(destination), "Preserve published evidence; destination must be new");
const add = async (name, path, expected) => {
  const bytes = await readFile(path);
  if (expected) assert.equal(hash(bytes), expected, path);
  assert(!files.has(name));
  files.set(name, bytes);
};
const addGzip = async (name, path) => files.set(name, gzipSync(await readFile(path)));
const air = await json(`${output}/report.json`),
  source = await json("art/source/hero/operative.pixels.json");
assert.equal(air.status, "pass");
assert.equal(air.sourceSha256, hash(await readFile("art/source/hero/operative.pixels.json")));
assert.equal(air.clientSha256, hash(await readFile("dist/client/combat-lab.js")));
assert.equal(air.runs.length, 8);
assert.equal(air.captures.length, 128);
assert.equal(air.videos.length, 8);
for (const facing of [-1, 1])
  assert.equal(
    new Set(air.runs.filter((r) => r.facing === facing).flatMap((r) => r.seen)).size,
    28,
  );
await addGzip("air/report.json.gz", `${output}/report.json`);
for (const run of air.runs) {
  assert(run.restored);
  const trace = await json(`${output}/${run.id}.trace.json`);
  assert.equal(trace.length, run.ticks);
  await addGzip(`air/${run.id}.trace.json.gz`, `${output}/${run.id}.trace.json`);
  await add(`air/${run.id}.recording.json`, `${output}/${run.id}.recording.json`);
}
for (const capture of air.captures)
  await add(`air/${capture.label}.png`, `${output}/${capture.label}.png`, capture.sha256);
for (const video of air.videos) {
  assert.equal(video.audio.dropped, 0);
  assert(video.peakDb.every((v) => v < 20 * Math.log10(0.99)));
  await add(`air/${video.name}.mp4`, `${output}/${video.name}.mp4`, video.sha256);
}
const sheets = await json("dist/operative-air-sheets/sheets.json");
assert.equal(sheets.sourceSha256, air.sourceSha256);
assert.equal(sheets.outputs.length, 18);
await add("sheets/sheets.json", "dist/operative-air-sheets/sheets.json");
for (const name of sheets.outputs) await add(`sheets/${name}`, `dist/operative-air-sheets/${name}`);
// The baseline is immutable; compare release metadata independently from the exporter.
const before = JSON.parse(
  execFileSync("git", ["show", `${sheets.baseCommit}:art/source/hero/operative.pixels.json`]),
);
assert.equal(source.frames.length, 149);
assert.equal(before.frames.length, 127);
assert.deepEqual(source.canvas, before.canvas);
assert.deepEqual(source.palette, before.palette);
assert.deepEqual(source.variants, before.variants);
const removed = [
  "legs-rise",
  "legs-fall",
  "legs-land-compress",
  "legs-land-rise",
  "upper-land-compress",
  "upper-land-rise",
];
assert.deepEqual(
  before.frames
    .filter((f) => !source.frames.some((n) => n.id === f.id))
    .map((f) => f.id)
    .sort(),
  removed.toSorted(),
);
for (const old of before.frames.filter((f) => !removed.includes(f.id)))
  assert.deepEqual(
    source.frames.find((f) => f.id === old.id),
    old,
    "Unrelated source changed",
  );
const revised = source.frames
  .filter((f) => !before.frames.some((old) => old.id === f.id))
  .map((f) => f.id);
assert.deepEqual(revised.toSorted(), air.changed.toSorted());
for (const clip of before.clips.filter(
  (c) => !["legs.land", "upper.land.horizontal"].includes(c.id),
))
  assert.deepEqual(
    source.clips.find((c) => c.id === clip.id),
    clip,
    "Unrelated action timing changed",
  );
const regressionDirectory = "dist/native-operative-evidence",
  native = await json(`${regressionDirectory}/report.json`);
assert.equal(native.status, "pass");
assert.equal(native.sourceSha256, air.sourceSha256);
assert.equal(native.bundleSha256, air.clientSha256);
assert.equal(native.reviewedClips.length, source.clips.length - 1);
assert.equal(native.footage.length, 0);
await addGzip("native/report.json.gz", `${regressionDirectory}/report.json`);
for (const path of execFileSync("rg", ["--files", "--no-ignore", regressionDirectory], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .sort()) {
  if (path.endsWith("/report.json")) continue;
  assert(/\.(png|json)$/.test(path), "Unexpected native regression output");
  await add(`native/${path.slice(regressionDirectory.length + 1)}`, path);
}
const missions = [];
const missionBundleSha256 = hash(await readFile("dist/client/benchmark.js"));
for (const players of [1, 2, 4]) {
  const directory =
      players === 1 ? "dist/breakwater-evidence" : `dist/breakwater-${players}-evidence`,
    prefix = players === 1 ? "solo" : `coop-${players}`,
    report = await json(`${directory}/report.json`);
  assert.equal(report.status, "pass");
  assert.equal(report.players, players);
  assert.equal(report.clientSha256, missionBundleSha256);
  assert.equal(report.videos.length, 0);
  assert.equal(report.screenshots.length, 48);
  assert.equal(report.boundaryHashes.length, report.ticks + 1);
  assert.equal(report.visualHashes.length, report.ticks + 1);
  assert.equal(report.forcedEjections.length, 1);
  assert.equal(report.forcedEjections[0].invulnerableTicks, 12);
  await addGzip(`missions/${prefix}/report.json.gz`, `${directory}/report.json`);
  await add(`missions/${prefix}/${prefix}.recording.json`, `${directory}/${prefix}.recording.json`);
  for (const shot of report.screenshots)
    await add(`missions/${prefix}/${shot.name}`, `${directory}/${shot.name}`, shot.sha256);
  missions.push({
    players,
    ticks: report.ticks,
    boundaries: report.boundaryHashes.length,
    crewBoundaries: report.crewBoundaries.length,
    forcedEjection: report.forcedEjections[0],
  });
}
const sources = [];
for (const path of execFileSync(
  "rg",
  [
    "--files",
    "art/source",
    "audio",
    "content",
    "src",
    "test",
    "scripts",
    "public/assets",
    "package.json",
    "pnpm-lock.yaml",
    "mise.toml",
    "wrangler.jsonc",
  ],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .sort()) {
  const bytes = await readFile(path);
  sources.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
const artifacts = [...files]
  .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }))
  .sort((a, b) => (a.path < b.path ? -1 : 1));
for (const [path, bytes] of files) {
  await mkdir(dirname(`${destination}/${path}`), { recursive: true });
  await writeFile(`${destination}/${path}`, bytes);
}
const manifest = {
  format: 1,
  scope:
    "28 original air/impact drawings replace six former holds. Accepted cosmetic phase clocks, immediate control and independent fire are tested; 960 browser boundaries, 128 pixel checks, eight short clips, all source workbench clips and current 1/2/4 mission replay/stills are retained. Continuous movies await the remaining tank acting pass. Human craft/listening approval, full W06 matrix, production v3 and live ingestion remain open.",
  baseline: sheets.baseCommit,
  sourceSha256: air.sourceSha256,
  missionBundleSha256,
  changed: revised,
  missions,
  sources,
  artifacts,
};
await writeFile(`${destination}/artifacts.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
  JSON.stringify({
    destination,
    artifacts: artifacts.length,
    sources: sources.length,
    bytes: artifacts.reduce((n, a) => n + a.bytes, 0),
    sha256: hash(await readFile(`${destination}/artifacts.json`)),
  }),
);

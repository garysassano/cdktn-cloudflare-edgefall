import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const destination = "docs/redesign-evidence/style-v2/kestrel-motion",
  output = "dist/native-cast-evidence",
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
const addGzip = async (name, path, expected) => {
  const bytes = await readFile(path);
  if (expected) assert.equal(hash(bytes), expected, path);
  assert(!files.has(name));
  files.set(name, gzipSync(bytes));
};
const cast = await json(`${output}/report.json`),
  source = await json("art/source/vehicles/kestrel.pixels.json"),
  sheets = await json("dist/kestrel-sheets/sheets.json");
assert.equal(cast.status, "pass");
assert.equal(cast.sourceSha256, hash(await readFile("art/source/vehicles/kestrel.pixels.json")));
assert.equal(cast.clientSha256, hash(await readFile("dist/client/combat-lab.js")));
assert.equal(cast.runs.length, 6);
assert.equal(cast.captures.length, 120);
assert.equal(cast.videos.length, 12);
assert.equal(
  cast.runs.reduce((n, r) => n + r.ticks, 0),
  815,
);
assert.equal(
  cast.runs.reduce((n, r) => n + r.releases.length, 0),
  54,
);
assert.equal(sheets.sourceSha256, cast.sourceSha256);
assert.equal(sheets.outputs.length, 24);
const before = JSON.parse(
  execFileSync("git", ["show", `${sheets.baseCommit}:art/source/vehicles/kestrel.pixels.json`]),
);
assert.equal(before.frames.length, 39);
assert.equal(source.frames.length, 72);
assert.deepEqual(source.canvas, before.canvas);
assert.deepEqual(source.palette, before.palette);
assert.deepEqual(source.variants, before.variants);
const removed = before.frames
  .filter((f) => !source.frames.some((n) => n.id === f.id))
  .map((f) => f.id);
assert.deepEqual(removed, [
  "kestrel-treads-0",
  "kestrel-treads-1",
  "kestrel-treads-2",
  "kestrel-treads-3",
  "kestrel-air",
  "kestrel-land",
]);
for (const frame of before.frames.filter((f) => !removed.includes(f.id)))
  assert.deepEqual(
    source.frames.find((f) => f.id === frame.id),
    frame,
    "Retained crew, turret or wreck drawing changed",
  );
for (const clip of before.clips.filter((c) => c.id !== "kestrel.drive"))
  assert.deepEqual(
    source.clips.find((c) => c.id === clip.id),
    clip,
    "Seat timing changed",
  );
const added = source.frames
  .filter((f) => !before.frames.some((b) => b.id === f.id))
  .map((f) => f.id)
  .sort();
assert.equal(added.length, 39);
const sheetFrames = new Set(sheets.pages.flatMap((p) => p.cells.flatMap((c) => c.frames)));
for (const id of added) assert(sheetFrames.has(id), `Missing composed source drawing ${id}`);
for (const run of cast.runs) {
  assert(run.restored);
  const trace = await json(`${output}/${run.id}-trace.json`);
  assert.equal(trace.length, run.ticks);
  if (run.id.startsWith("kestrel-")) {
    for (const frame of source.frames.filter(
      (f) =>
        f.id.startsWith("kestrel-hull-") || /^kestrel-track-[0-7]$|^kestrel-turret-/.test(f.id),
    ))
      assert(run.seen.includes(`p1/${frame.id}`), `${run.id} missing ${frame.id}`);
    assert(trace.at(-1).frames.length > 0);
  }
}
for (const video of cast.videos) {
  assert.equal(video.audio.dropped, 0);
  assert.equal(video.stereo.length, 2);
  for (const audit of video.stereo) {
    assert.equal(audit.peakDb.length, 3);
    assert(audit.peakDb.every((v) => v < 20 * Math.log10(0.99)));
  }
}
await addGzip("cast/report.json.gz", `${output}/report.json`);
for (const file of cast.files) {
  assert(/\.(png|json|mp4|webm)$/.test(file.name));
  if (file.name.endsWith("-trace.json"))
    await addGzip(`cast/${file.name}.gz`, `${output}/${file.name}`, file.sha256);
  else await add(`cast/${file.name}`, `${output}/${file.name}`, file.sha256);
}
await add("sheets/sheets.json", "dist/kestrel-sheets/sheets.json");
for (const name of sheets.outputs) await add(`sheets/${name}`, `dist/kestrel-sheets/${name}`);
const missions = [],
  missionBundleSha256 = hash(await readFile("dist/client/benchmark.js"));
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
  const previous = JSON.parse(
    gunzipSync(
      await readFile(
        `docs/redesign-evidence/style-v2/operative-air/missions/${prefix}/report.json.gz`,
      ),
    ),
  );
  assert.deepEqual(report.boundaryHashes, previous.boundaryHashes, "Authoritative mission changed");
  assert.deepEqual(report.visualHashes, previous.visualHashes, "Effects changed");
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
    authorityAndEffectsEqualAirBaseline: true,
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
const capturedFrames = new Set(
  cast.captures.flatMap((c) => c.frames.map((f) => f.frame.replace(/^p[1-4]\//, ""))),
);
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
    "Separate eight-phase tracks and hull suspension; accepted launch/rise/apex/fall, light/heavy impact and two-stage post-release recoil. Current cast/crew replay, source sheets, short raw WebM/MP4 and 1/2/4 mission replay/stills are retained. Continuous movies, full W06 matrix, human craft/listening acceptance, production v3 and live trace ingestion remain open.",
  baseline: sheets.baseCommit,
  sourceSha256: cast.sourceSha256,
  missionBundleSha256,
  removed,
  added,
  browserCapturedNewDrawings: added.filter((id) => capturedFrames.has(id)),
  sourceSheetOnlyNewDrawings: added.filter((id) => !capturedFrames.has(id)),
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
    sourceSheetOnly: manifest.sourceSheetOnlyNewDrawings,
  }),
);

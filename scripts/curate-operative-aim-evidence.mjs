import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";

const destination = "docs/redesign-evidence/style-v2/operative-aim",
  output = "dist/operative-aim-evidence",
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
const aim = await json(`${output}/report.json`),
  source = await json("art/source/hero/operative.pixels.json");
assert.equal(aim.status, "pass");
assert.equal(aim.sourceSha256, hash(await readFile("art/source/hero/operative.pixels.json")));
assert.equal(aim.clientSha256, hash(await readFile("dist/client/combat-lab.js")));
assert.equal(aim.runs.length, 8);
assert.equal(aim.captures.length, 68);
assert.equal(aim.videos.length, 8);
for (const facing of [-1, 1])
  assert.equal(
    new Set(aim.runs.filter((r) => r.facing === facing).flatMap((r) => r.seen)).size,
    34,
  );
await addGzip("aim/report.json.gz", `${output}/report.json`);
for (const run of aim.runs) {
  assert(run.restored);
  const trace = await json(`${output}/${run.id}.trace.json`);
  assert.equal(trace.length, run.ticks);
  await addGzip(`aim/${run.id}.trace.json.gz`, `${output}/${run.id}.trace.json`);
  await add(`aim/${run.id}.recording.json`, `${output}/${run.id}.recording.json`);
}
for (const capture of aim.captures)
  await add(`aim/${capture.label}.png`, `${output}/${capture.label}.png`, capture.sha256);
for (const video of aim.videos) {
  assert.equal(video.audio.dropped, 0);
  assert(video.peakDb.every((v) => v < 20 * Math.log10(0.99)));
  await add(`aim/${video.name}.mp4`, `${output}/${video.name}.mp4`, video.sha256);
}
const sheets = await json("dist/operative-aim-sheets/sheets.json");
assert.equal(sheets.sourceSha256, aim.sourceSha256);
assert.equal(sheets.outputs.length, 24);
await add("sheets/sheets.json", "dist/operative-aim-sheets/sheets.json");
for (const name of sheets.outputs) await add(`sheets/${name}`, `dist/operative-aim-sheets/${name}`);
// The baseline is immutable; compare release metadata independently from the exporter.
const before = JSON.parse(
  execFileSync("git", ["show", `${sheets.baseCommit}:art/source/hero/operative.pixels.json`]),
);
assert.equal(source.frames.length, before.frames.length);
const revised = [];
for (const old of before.frames) {
  const next = source.frames.find((f) => f.id === old.id);
  assert(next);
  assert.deepEqual(next.sockets?.muzzle, old.sockets?.muzzle, old.id);
  if (JSON.stringify(next) !== JSON.stringify(old)) revised.push(old.id);
}
assert.deepEqual(revised.toSorted(), aim.changed.toSorted());
assert.deepEqual(source.clips, before.clips);
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
    "34 revised firearm aim/recoil drawings; exact browser pixels in both directions, eight short clips, native/enlarged source comparisons and current 1/2/4 mission replay/still regression. Continuous mission movies remain at the earlier crew revision until the remaining acting pass. Human craft/listening approval, full W06 matrix, production v3 and live ingestion remain open.",
  baseline: sheets.baseCommit,
  sourceSha256: aim.sourceSha256,
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

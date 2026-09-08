import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { reviewMatrixViewer } from "./lib/review-matrix-viewer.mjs";

const destination = "docs/redesign-evidence/style-v2/mission-review",
  releaseDirectory = "dist/review-matrix-release",
  releaseTag = "w06-review-v2-kestrel",
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  json = async (path) => JSON.parse(await readFile(path, "utf8")),
  files = new Map(),
  uploads = [],
  runs = [];
await assert.rejects(
  access(destination),
  "Preserve published review packages; destination must be new",
);
const add = async (name, path, expected, gzip = false) => {
  const bytes = await readFile(path);
  if (expected) assert.equal(hash(bytes), expected, path);
  assert(!files.has(name));
  files.set(name, gzip ? gzipSync(bytes) : bytes);
};
const build = {
  clientSha256: hash(await readFile("dist/client/benchmark.js")),
  assetManifestSha256: hash(await readFile("dist/client/assets/manifest.json")),
  verifierSha256: hash(await readFile("scripts/verify-breakwater.mjs")),
  exporterSha256: hash(await readFile("scripts/lib/export-breakwater-video.mjs")),
  routeSha256: hash(await readFile("test/fixtures/breakwater-proof.ts")),
};
assert.equal(build.assetManifestSha256, hash(await readFile("public/assets/manifest.json")));
const modes = [1, 0.25].flatMap((speed) =>
  [false, true].flatMap((debug) =>
    [true, false].flatMap((music) =>
      [false, true].map((reduced) => [speed, debug, music, reduced]),
    ),
  ),
);
for (const players of [1, 2, 4]) {
  const prefix = players === 1 ? "solo" : `coop-${players}`,
    directory = `dist/breakwater-matrix/${prefix}`,
    report = await json(`${directory}/report.json`);
  assert.equal(report.status, "pass");
  assert.equal(report.validationOnly, false);
  assert.equal(report.fullMatrix, true);
  assert(!report.activeCapture, "A capture is still active");
  assert.deepEqual(report.captureIdentity, { format: 1, players, ...build });
  assert.equal(report.screenshots.length, 96);
  assert.equal(report.videos.length, 16);
  assert.deepEqual(report.requestedModes, modes);
  assert.equal(new Set(report.videos.map((v) => v.name)).size, 16);
  const baseline = JSON.parse(
    gunzipSync(
      await readFile(
        `docs/redesign-evidence/style-v2/kestrel-motion/missions/${prefix}/report.json.gz`,
      ),
    ),
  );
  assert.deepEqual(report.boundaryHashes, baseline.boundaryHashes);
  assert.deepEqual(report.visualHashes, baseline.visualHashes);
  assert.deepEqual(report.forcedEjections, baseline.forcedEjections);
  await add(`${prefix}/report.json.gz`, `${directory}/report.json`, undefined, true);
  await add(`${prefix}/${prefix}.recording.json`, `${directory}/${prefix}.recording.json`);
  let reducedPairs = 0;
  for (const shot of report.screenshots) {
    await add(`${prefix}/${shot.name}`, `${directory}/${shot.name}`, shot.sha256);
    const pair = report.screenshots.filter((s) => s.tick === shot.tick && s.debug === shot.debug);
    assert.equal(pair.length, 2);
    assert.equal(new Set(pair.map((s) => s.reduced)).size, 2);
    if (!shot.reduced && pair[0].effectHash !== pair[1].effectHash) reducedPairs++;
  }
  assert(reducedPairs > 0, "Reduced-effects comparison is empty");
  const expectedCues = report.videos[0].clocks.audioCues;
  for (const [speed, debug, music, reduced] of modes) {
    const name = `${prefix}-${debug ? "debug" : "clean"}-${speed === 1 ? "normal" : "quarter"}${music ? "" : "-music-off"}${reduced ? "-reduced-effects" : ""}`;
    const video = report.videos.find((v) => v.name === name);
    assert(video);
    assert.deepEqual(
      [video.speed, video.debug, video.music, video.reduced],
      [speed, debug, music, reduced],
    );
    assert.equal(video.initialTick, 0);
    assert.equal(video.clocks.audioDropped, 0);
    assert.equal(video.clocks.audioCues, expectedCues);
    assert(video.clocks.maximumAudioVoices <= 32);
    assert(video.clocks.decodedAudioBytes <= 32 * 1024 * 1024);
    assert.equal(video.clocks.music.voices, 0);
    assert.equal(video.stereo.length, 2);
    for (const audit of video.stereo) {
      assert.equal(audit.peakDb.length, 3);
      assert(audit.peakDb.every((db) => db < 20 * Math.log10(0.99)));
    }
    assert.equal(video.files.length, 4);
    for (const file of video.files) {
      const path = `${directory}/${file.name}`,
        bytes = await readFile(path);
      assert.equal(bytes.length, file.bytes, path);
      assert.equal(hash(bytes), file.sha256, path);
      if (/\.(mp4|webm)$/.test(file.name)) {
        assert(
          bytes.length < 2 * 1024 * 1024 * 1024,
          "GitHub release asset exceeds the per-file limit",
        );
        uploads.push({ ...file, path });
      } else await add(`${prefix}/${file.name}`, path, file.sha256);
    }
    assert.equal(
      video.files.find((f) => f.name.endsWith("-start.png"))?.sha256,
      video.initialFrameSha256,
    );
    assert(
      Math.abs(video.duration - (report.ticks + report.presentationPostrollTicks) / 60 / speed) < 2,
    );
    assert(Math.abs(video.clocks.audioSeconds - video.clocks.monotonicMs / 1000) < 0.2);
  }
  runs.push({
    players,
    ticks: report.ticks,
    chapters: Object.entries({
      apron: "Start",
      grenade: "Grenade",
      shotgun: "Shotgun",
      flame: "Flamethrower",
      "boarding-climb": "Boarding",
      "tank-jump": "Tank jump",
      "forced-ejection-brace": "Forced ejection",
      aperture: "Boss fight",
      victory: "Victory",
    }).map(([id, label]) => {
      const shot = report.screenshots.find((s) => s.name.endsWith(`-${id}-clean.png`));
      assert(shot, `Missing scene: ${id}`);
      return { label, tick: shot.tick };
    }),
    worldAndEffectsBoundaries: report.boundaryHashes.length,
    crewBoundaries: report.crewBoundaries.length,
    reducedPairs,
    movies: report.videos.map(
      ({ name, duration, speed, debug, music, reduced, initialTick, clocks, stereo }) => ({
        name,
        duration,
        speed,
        debug,
        music,
        reduced,
        initialTick,
        audioCues: clocks.audioCues,
        maxVoices: clocks.maximumAudioVoices,
        stereo,
      }),
    ),
    forcedEjections: report.forcedEjections,
  });
}
assert.equal(uploads.length, 96);
assert.equal(new Set(uploads.map((f) => f.name)).size, 96);
// A visual weapon comparison is required even though the matrix contains the weapons.
const comparison = await json("dist/weapon-comparison/sheets.json");
assert.equal(comparison.assetManifestSha256, build.assetManifestSha256);
assert.deepEqual(comparison.weapons, [
  "sidearm",
  "heavy-machine-gun",
  "shotgun",
  "grenade",
  "flamethrower",
]);
assert.deepEqual(comparison.ages, [0, 2, 4, 6]);
const comparisonStates = await json("dist/weapon-comparison/accepted-states.json"),
  soloReport = await json("dist/breakwater-matrix/solo/report.json");
assert.deepEqual(
  comparisonStates.map((s) => s.weapon),
  comparison.weapons,
);
for (const selection of comparisonStates) {
  assert.deepEqual(
    selection.samples.map((s) => s.age),
    comparison.ages,
  );
  for (const sample of selection.samples) {
    assert.equal(sample.tick, selection.releaseTick + sample.age);
    assert.equal(sample.worldSha256, soloReport.boundaryHashes[sample.tick]);
  }
}
await add("weapons/sheets.json", "dist/weapon-comparison/sheets.json");
for (const file of comparison.files) {
  await add(`weapons/${file.name}`, `dist/weapon-comparison/${file.name}`, file.sha256);
  if (file.name.endsWith(".png"))
    uploads.push({ ...file, path: `dist/weapon-comparison/${file.name}` });
}
const viewer = Buffer.from(reviewMatrixViewer(runs)),
  viewerName = "review.html";
files.set(viewerName, viewer);
uploads.push({
  name: viewerName,
  bytes: viewer.length,
  sha256: hash(viewer),
  path: `${releaseDirectory}/${viewerName}`,
});
const references = [];
for (const path of [
  "docs/redesign-evidence/style-v2/operative-air/artifacts.json",
  "docs/redesign-evidence/style-v2/kestrel-motion/artifacts.json",
  "docs/redesign-evidence/style-v2/mission-audio/artifacts.json",
]) {
  references.push({ path, sha256: hash(await readFile(path)) });
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
const manifest = {
  format: 1,
  scope:
    "Complete current 1/2/4-player mission movie matrix, retained inputs and clean/debug/full/reduced stills. Human review and physical-device output remain pending; this is not production integration or a final game release.",
  artBaseline: "200be35c1a098df9240ee6968059190be580f864",
  captureBuild: build,
  review: {
    status: "pending",
    reviewer: null,
    categories: [
      "silhouette/readability",
      "pixel discipline",
      "motion/acting",
      "weapon distinction",
      "vehicle weight",
      "environment separation",
      "multiplayer clarity",
      "audio impact",
    ],
  },
  release: {
    tag: releaseTag,
    publication: "draft",
    assets: uploads.map(({ path, ...file }) => file),
  },
  runs,
  references,
  sources,
  artifacts,
};
for (const [path, bytes] of files) {
  await mkdir(dirname(`${destination}/${path}`), { recursive: true });
  await writeFile(`${destination}/${path}`, bytes);
}
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(`${destination}/artifacts.json`, manifestBytes);
await mkdir(releaseDirectory, { recursive: true });
await writeFile(`${releaseDirectory}/${viewerName}`, viewer);
await writeFile(`${releaseDirectory}/artifacts.json`, manifestBytes);
await writeFile(
  `${releaseDirectory}/upload.json`,
  `${JSON.stringify({ releaseTag, assets: [...uploads, { name: "artifacts.json", path: `${releaseDirectory}/artifacts.json`, bytes: manifestBytes.length, sha256: hash(manifestBytes) }] }, null, 2)}\n`,
);
await writeFile(
  `${releaseDirectory}/notes.md`,
  [
    "# W06 review specimen",
    "",
    "Original Breakwater benchmark candidates with 48 current seeded movies: one/two/four players, normal/quarter playback, clean/debug overlays, music enabled/muted and full/reduced effects. MP4 and raw WebM are retained. Human style/listening acceptance remains pending.",
    "",
    "Download every asset into one directory and open review.html in a browser. The offline viewer selects any of the 48 MP4 views and displays the current weapon comparison; no server or login is needed after download.",
    "",
    `Artifact manifest SHA256: ${hash(manifestBytes)}. The repository retains the input recordings, source fingerprints, initial frames, clock/stereo reports, stills and weapon comparison. This draft is the review download location; it does not approve the candidates or complete production/campaign work.`,
    "",
    "See docs/redesign-evidence/style-v2/mission-review/artifacts.json at the release target commit for the complete inventory and integrity checks.",
    "",
  ].join("\n"),
);
console.log(
  JSON.stringify({
    destination,
    releaseTag,
    repoArtifacts: artifacts.length,
    sources: sources.length,
    movies: uploads.filter((f) => f.name.endsWith(".mp4")).length,
    releaseAssets: uploads.length + 1,
    mediaBytes: uploads
      .filter((f) => /\.(mp4|webm)$/.test(f.name))
      .reduce((n, f) => n + f.bytes, 0),
    manifestSha256: hash(manifestBytes),
  }),
);

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const destination = "docs/redesign-evidence/style-v2/mission-audio",
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  json = async (file) => JSON.parse(await readFile(file, "utf8")),
  files = new Map();
await assert.rejects(
  access(destination),
  "Evidence destination must be new; preserve prior captures",
);
const add = async (name, source, expected) => {
  const bytes = await readFile(source);
  if (expected) assert.equal(hash(bytes), expected, source);
  assert(!files.has(name), `Duplicate artifact ${name}`);
  files.set(name, bytes);
};
const addJson = (name, value) =>
  files.set(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
const audio = await json("dist/combat-audio-evidence/report.json");
assert.equal(audio.status, "pass");
assert.equal(audio.decoded.length, 52);
assert.equal(audio.stress.admitted.criticalDropped, 0);
assert(audio.stress.maxAudible <= 32 && audio.stress.admitted.maxSourceNodes <= 64);
for (const item of audio.files) {
  assert(item.channels.every((channel) => channel.peak < 0.99 && channel.rms > 0.0001));
  await add(item.file, `dist/combat-audio-evidence/${item.file}`, item.sha256);
}
const harnessSource = await readFile("scripts/verify-combat-audio.mjs", "utf8"),
  contents = /contents: `([\s\S]*?)`,\n/.exec(harnessSource)?.[1];
assert(contents, "Missing inline browser fixture");
const rebuilt = await build({
  stdin: { resolveDir: process.cwd(), contents },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: "es2022",
});
assert.equal(
  hash(rebuilt.outputFiles[0].contents),
  audio.bundleSha256,
  "Audio capture bundle no longer matches source",
);
await add("audio-report.json", "dist/combat-audio-evidence/report.json");
const reproduction = await json("dist/combat-audio-evidence/reproducibility.json");
for (const [file, expected] of Object.entries(reproduction.files))
  assert.equal(hash(await readFile(file)), expected, file);
await add("reproducibility.json", "dist/combat-audio-evidence/reproducibility.json");
const diagnosis = await json("dist/combat-audio-evidence/output-diagnosis.json");
assert.equal(diagnosis.headroomPassed, false);
assert(diagnosis.file.channels.some((channel) => channel.peak > 1));
await add(
  diagnosis.file.file,
  `dist/combat-audio-evidence/${diagnosis.file.file}`,
  diagnosis.file.sha256,
);
addJson("output-diagnosis.json", diagnosis);

const browserSha256 = hash(await readFile("dist/client/benchmark.js")),
  mediaAudit = [],
  runs = [];
for (const players of [1, 2, 4]) {
  const directory =
      players === 1 ? "dist/breakwater-evidence" : `dist/breakwater-${players}-evidence`,
    report = await json(`${directory}/report.json`),
    prefix = players === 1 ? "solo" : `coop-${players}`;
  assert.equal(report.status, "pass");
  assert.equal(report.clientSha256, browserSha256, "Mission capture bundle changed");
  assert.equal(report.players, players);
  assert.equal(report.screenshots.length, 18);
  assert.equal(report.boundaryHashes.length, report.ticks + 1);
  assert.equal(report.visualHashes.length, report.ticks + 1);
  if (players === 4) assert.equal(report.videos.length, 3);
  else assert.equal(report.videos.length, 0);
  files.set(`${prefix}/report.json.gz`, gzipSync(await readFile(`${directory}/report.json`)));
  await add(`${prefix}/${prefix}.recording.json`, `${directory}/${prefix}.recording.json`);
  for (const shot of report.screenshots)
    await add(`${prefix}/${shot.name}`, `${directory}/${shot.name}`, shot.sha256);
  for (const video of report.videos) {
    assert.equal(video.clocks.audioDropped, 0);
    assert(video.clocks.maximumAudioVoices <= 32);
    assert(video.clocks.decodedAudioBytes < 32 * 1024 * 1024);
    assert.equal(video.clocks.music.voices, 0);
    for (const extension of ["webm", "mp4"]) {
      const file = `${directory}/${video.name}.${extension}`,
        decoded = spawnSync(
          "ffmpeg",
          [
            "-hide_banner",
            "-nostats",
            "-i",
            file,
            "-af",
            "astats=reset=0",
            "-vn",
            "-f",
            "null",
            "-",
          ],
          { encoding: "utf8" },
        );
      assert.equal(decoded.status, 0, file);
      const peakDb = [...decoded.stderr.matchAll(/Peak level dB: ([-.\d]+)/g)].map((m) =>
          Number(m[1]),
        ),
        rmsDb = [...decoded.stderr.matchAll(/RMS level dB: ([-.\d]+)/g)].map((m) => Number(m[1]));
      assert.equal(peakDb.length, 3);
      assert.equal(rmsDb.length, 3);
      assert(
        peakDb.every((v) => v < 20 * Math.log10(0.99)),
        `Stereo clipping ${file}`,
      );
      assert(
        rmsDb.every((v) => v > -80),
        `Silent stereo channel ${file}`,
      );
      mediaAudit.push({
        name: `${video.name}.${extension}`,
        sha256: hash(await readFile(file)),
        peakDb,
        rmsDb,
      });
    }
    await add(`${prefix}/${video.name}.mp4`, `${directory}/${video.name}.mp4`);
    await add(`${prefix}/${video.name}-clocks.json`, `${directory}/${video.name}-clocks.json`);
  }
  runs.push({
    players,
    ticks: report.ticks,
    screenshots: report.screenshots.length,
    videos: report.videos.length,
  });
}
addJson("mission-stereo-audit.json", {
  status: "pass",
  scope:
    "Each raw WebM and published MP4 stereo channel, plus overall statistics; no mono downmix.",
  files: mediaAudit,
});
const cast = await json("dist/native-cast-evidence/report.json");
assert.equal(cast.runs.length, 4);
assert(cast.runs.every((r) => r.restored));
assert.equal(cast.videos.length, 6);
files.set(
  "cast-regression.json.gz",
  gzipSync(await readFile("dist/native-cast-evidence/report.json")),
);

// Preserve the short-file encoder control independently of the checked-in runtime encodings.
const shortFile = "audio/source/masters/sfx/sidearm-a.flac",
  controls = [];
for (const [name, options] of [
  ["default-pages", []],
  ["explicit-pages", ["-page_duration", "20000"]],
]) {
  const bytes = execFileSync("ffmpeg", [
      "-v",
      "error",
      "-i",
      shortFile,
      "-c:a",
      "libvorbis",
      "-q:a",
      "5",
      "-fflags",
      "+bitexact",
      "-map_metadata",
      "-1",
      ...options,
      "-f",
      "ogg",
      "pipe:1",
    ]),
    decoded = execFileSync("ffmpeg", ["-v", "error", "-i", "pipe:0", "-f", "f32le", "pipe:1"], {
      input: bytes,
    });
  files.set(`ogg-${name}.ogg`, bytes);
  controls.push({ name, sha256: hash(bytes), decodedFrames: decoded.length / 4 });
}
assert.equal(controls[0].decodedFrames, 8992);
assert.equal(controls[1].decodedFrames, 9120);
addJson("ogg-diagnosis.json", {
  scope:
    "FFmpeg short mono file decode control; explicit pages retain all authored frames without adding silence.",
  master: shortFile,
  masterSha256: hash(await readFile(shortFile)),
  expectedFrames: 9120,
  controls,
});

const sourcePaths = execFileSync(
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
    .sort(),
  sources = [];
for (const path of sourcePaths) {
  const bytes = await readFile(path);
  sources.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
const artifacts = [...files]
  .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) }))
  .sort((a, b) => (a.path < b.path ? -1 : 1));
// Validate every input before creating the immutable publication directory.
for (const [name, bytes] of files) {
  await mkdir(dirname(`${destination}/${name}`), { recursive: true });
  await writeFile(`${destination}/${name}`, bytes);
}
await writeFile(
  `${destination}/artifacts.json`,
  `${JSON.stringify({ format: 1, scope: "Interaction audio candidate and local mission regression; human listening/style, physical output, production networking and live ingestion remain open.", audioBundleSha256: audio.bundleSha256, missionBundleSha256: browserSha256, runs, sources, artifacts }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    destination,
    artifacts: artifacts.length,
    sources: sources.length,
    bytes: artifacts.reduce((sum, file) => sum + file.bytes, 0),
  }),
);

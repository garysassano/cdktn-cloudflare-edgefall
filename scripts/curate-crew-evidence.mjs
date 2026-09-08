import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gzipSync } from "node:zlib";
import sharp from "sharp";

const destination = "docs/redesign-evidence/style-v2/mission-crew",
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  json = async (path) => JSON.parse(await readFile(path, "utf8")),
  files = new Map();
await assert.rejects(access(destination), "Preserve published evidence; destination must be new");
const add = async (name, source, expected) => {
  const bytes = await readFile(source);
  if (expected) assert.equal(hash(bytes), expected, source);
  assert(!files.has(name));
  files.set(name, bytes);
};
const addJson = (name, value) =>
  files.set(name, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
const browserSha256 = hash(await readFile("dist/client/benchmark.js")),
  runs = [],
  media = [];
for (const players of [1, 2, 4]) {
  const directory =
      players === 1 ? "dist/breakwater-evidence" : `dist/breakwater-${players}-evidence`,
    report = await json(`${directory}/report.json`),
    prefix = players === 1 ? "solo" : `coop-${players}`;
  assert.equal(report.status, "pass");
  assert.equal(report.clientSha256, browserSha256, "Stale mission bundle");
  assert.equal(report.players, players);
  assert.equal(report.screenshots.length, 48);
  assert.equal(report.boundaryHashes.length, report.ticks + 1);
  assert.equal(report.visualHashes.length, report.ticks + 1);
  assert.equal(report.forcedEjections.length, 1);
  assert.equal(report.forcedEjections[0].invulnerableTicks, 12);
  assert.equal(report.videos.length, 3);
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
      const file = `${directory}/${video.name}.${extension}`;
      const result = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-nostats", "-i", file, "-af", "astats=reset=0", "-vn", "-f", "null", "-"],
        { encoding: "utf8" },
      );
      assert.equal(result.status, 0, file);
      const peakDb = [...result.stderr.matchAll(/Peak level dB: ([-.\d]+)/g)].map((m) =>
          Number(m[1]),
        ),
        rmsDb = [...result.stderr.matchAll(/RMS level dB: ([-.\d]+)/g)].map((m) => Number(m[1]));
      assert.equal(peakDb.length, 3);
      assert.equal(rmsDb.length, 3);
      assert(peakDb.every((v) => v < 20 * Math.log10(0.99)));
      assert(rmsDb.every((v) => v > -80));
      media.push({
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
    forcedEjection: report.forcedEjections[0],
  });
}
addJson("stereo-audit.json", {
  status: "pass",
  scope:
    "Independent per-channel and overall decode of raw WebM and published MP4, without downmix.",
  files: media,
});
const cast = await json("dist/native-cast-evidence/report.json");
assert.equal(cast.runs.length, 4);
assert(cast.runs.every((run) => run.restored));
assert.equal(cast.videos.length, 6);
assert.equal(cast.captures.length, 24);
files.set("cast/report.json.gz", gzipSync(await readFile("dist/native-cast-evidence/report.json")));
for (const shot of cast.captures)
  await add(`cast/${shot.label}.png`, `dist/native-cast-evidence/${shot.label}.png`);
for (const video of cast.videos)
  await add(`cast/${video.name}.mp4`, `dist/native-cast-evidence/${video.name}.mp4`);

// Source contact sheets compose the same literal atlas layers without adding poses.
const atlases = new Map(),
  images = new Map();
for (const [id, directory] of [
  ["operative", "hero"],
  ["kestrel", "vehicles"],
]) {
  atlases.set(id, await json(`public/assets/art/${directory}/${id}.atlas.json`));
  images.set(id, await readFile(`public/assets/art/${directory}/${id}.png`));
}
for (const [theme, background, color] of [
  ["black", "#000000", "#ffffff"],
  ["white", "#ffffff", "#000000"],
  ["chroma", "#ff00ff", "#000000"],
]) {
  const layers = [],
    labels = [];
  const groups = [
    ["kestrel", "kestrel.board"],
    ["kestrel", "kestrel.exit"],
    ["operative", "body.eject"],
  ];
  for (const [row, [id, clipId]] of groups.entries()) {
    const atlas = atlases.get(id),
      clip = atlas.meta.edgefall.clips.find((c) => c.id === clipId);
    assert(clip);
    for (const [col, exposure] of clip.exposures.entries()) {
      const left = col * 104 + 4,
        top = row * 114 + 4;
      for (const name of id === "kestrel"
        ? ["kestrel-treads-0", "kestrel-turret-0", exposure.frame]
        : [exposure.frame]) {
        const f = atlas.frames[`p1/${name}`].frame;
        layers.push({
          input: await sharp(images.get(id))
            .extract({ left: f.x, top: f.y, width: f.w, height: f.h })
            .png()
            .toBuffer(),
          left: left + (id === "operative" ? 24 : 0),
          top: top + (id === "operative" ? 24 : 0),
        });
      }
      labels.push(
        `<text x="${left}" y="${top + 106}">${exposure.frame.replace(/^kestrel-|^body-/, "")}</text>`,
      );
    }
  }
  layers.push({
    input: Buffer.from(
      `<svg width="832" height="342"><g fill="${color}" font-family="monospace" font-size="8">${labels.join("")}</g></svg>`,
    ),
    left: 0,
    top: 0,
  });
  const png = await sharp({ create: { width: 832, height: 342, channels: 4, background } })
    .composite(layers)
    .png()
    .toBuffer();
  files.set(`sheets/crew-${theme}-1x.png`, png);
  files.set(
    `sheets/crew-${theme}-4x.png`,
    await sharp(png).resize(3328, 1368, { kernel: "nearest" }).png().toBuffer(),
  );
}
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
for (const [path, bytes] of files) {
  await mkdir(dirname(`${destination}/${path}`), { recursive: true });
  await writeFile(`${destination}/${path}`, bytes);
}
await writeFile(
  `${destination}/artifacts.json`,
  `${JSON.stringify({ format: 1, scope: "Native crew transfers and safe forced ejection inside continuous local missions; full W06 acting, review matrix, human approval, production integration and live trace ingestion remain open.", missionBundleSha256: browserSha256, runs, sources, artifacts }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    destination,
    artifacts: artifacts.length,
    sources: sources.length,
    bytes: artifacts.reduce((n, f) => n + f.bytes, 0),
  }),
);

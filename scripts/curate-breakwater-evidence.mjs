import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";

const destination = "docs/redesign-evidence/style-v2/mission-effects";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  await access(destination);
  throw new Error("Evidence already exists; use a new dated destination for a later revision");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const artifacts = [],
  pending = [],
  captures = [],
  clientHash = hash(await readFile("dist/client/benchmark.js"));
const copy = async (from, name, gzip = false) => {
  const original = await readFile(from),
    bytes = gzip ? gzipSync(original, { level: 9 }) : original;
  const path = `${destination}/${name}`;
  pending.push({ path, bytes });
  artifacts.push({ path: name, bytes: bytes.length, sha256: hash(bytes) });
};
for (const players of [1, 2, 4]) {
  const prefix = players === 1 ? "solo" : `coop-${players}`,
    from = players === 1 ? "dist/breakwater-evidence" : `dist/breakwater-${players}-evidence`,
    report = JSON.parse(await readFile(`${from}/report.json`));
  assert.equal(report.status, "pass");
  assert.equal(report.players, players);
  assert.equal(report.clientSha256, clientHash, "Rebuild changed the captured browser bundle");
  assert(report.videos.length >= 3 && report.screenshots.length === 18);
  captures.push({
    players,
    ticks: report.ticks,
    seconds: report.simulationSeconds,
    videos: report.videos.length,
    screenshots: report.screenshots.length,
  });
  await copy(`${from}/report.json`, `${prefix}/report.json.gz`, true);
  await copy(`${from}/${prefix}.recording.json`, `${prefix}/${prefix}.recording.json`);
  for (const shot of report.screenshots)
    await copy(`${from}/${shot.name}`, `${prefix}/${shot.name}`);
  for (const video of report.videos) {
    await copy(`${from}/${video.name}.mp4`, `${prefix}/${video.name}.mp4`);
    await copy(`${from}/${video.name}-clocks.json`, `${prefix}/${video.name}-clocks.json`);
  }
}
for (const name of await readdir("dist/breakwater-evidence"))
  if (
    /^(operative|breakwater-quay|lock-engine|breakwater-fx)-(black|white|gray|cyan|chroma)-(1|4)x\.png$/.test(
      name,
    )
  )
    await copy(`dist/breakwater-evidence/${name}`, `sheets/${name}`);
assert.equal(artifacts.filter((a) => a.path.startsWith("sheets/")).length, 40);
for (const [from, name] of [
  ["dist/native-operative-evidence/report.json", "operative-regression.json.gz"],
  ["dist/native-cast-evidence/report.json", "cast-regression.json.gz"],
]) {
  const report = JSON.parse(await readFile(from));
  if (name === "operative-regression.json.gz") assert.equal(report.status, "pass");
  else {
    // This verifier writes its report only after all assertions pass; its existing schema has no status field.
    assert.equal(report.runs.length, 4);
    assert(report.runs.every((run) => run.restored));
    assert.equal(report.videos.length, 6);
    assert.equal(report.captures.length, 10);
    for (const file of report.files)
      assert.equal(hash(await readFile(`dist/native-cast-evidence/${file.name}`)), file.sha256);
  }
  await copy(from, name, true);
}
const sources = [];
await copy("dist/breakwater-observability.json", "observability.json");
await copy("dist/breakwater-media-audit.json", "media-audit.json");
await copy("dist/breakwater-encoding-diagnosis.json", "encoding-diagnosis.json");
const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "src",
    "test",
    "scripts",
    "art/source",
    "audio/source",
    "public/assets",
    "package.json",
    "mise.toml",
    "pnpm-lock.yaml",
    "wrangler.jsonc",
  ],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
for (const path of [...new Set(files)].sort()) {
  const bytes = await readFile(path);
  sources.push({ path, bytes: bytes.length, sha256: hash(bytes) });
}
const manifest = JSON.parse(await readFile("public/assets/manifest.json"));
const native = manifest.assets.filter(
  (a) => a.png && /^assets\/art\/(hero|enemies|vehicles|bosses|environment|effects)\//.test(a.path),
);
const textureBytes = native.reduce((sum, a) => sum + a.png.width * a.png.height * 4, 0);
assert(native.every((a) => a.png.width <= 2048 && a.png.height <= 2048));
assert(textureBytes <= 64 * 1024 * 1024);
artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const result = {
  format: 1,
  scope:
    "Finite native effects, authored music and complete local solo/two/four-player input and browser recordings. Human approval and production/network integration remain open.",
  browser:
    "Chromium with --disable-audio-output; WebAudio and MediaRecorder active; physical output not verified",
  clientSha256: clientHash,
  captures,
  textureBytes,
  textureBudgetBytes: 64 * 1024 * 1024,
  maximumTextureDimension: 2048,
  artifacts,
  sources,
};
for (const { path, bytes } of pending) {
  await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await writeFile(path, bytes);
}
await writeFile(`${destination}/artifacts.json`, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify({
    destination,
    captures,
    artifacts: artifacts.length,
    sources: sources.length,
    bytes: artifacts.reduce((sum, a) => sum + a.bytes, 0),
    textureBytes,
  }),
);

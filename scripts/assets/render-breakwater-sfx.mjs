import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = "audio/source",
  sessionBytes = await readFile(`${root}/sfx/breakwater.json`),
  provenanceBytes = await readFile(`${root}/sfx/provenance.json`),
  session = JSON.parse(sessionBytes),
  provenance = JSON.parse(provenanceBytes),
  check = process.argv.includes("--check"),
  hash = (bytes) => createHash("sha256").update(bytes).digest("hex"),
  metadataPath = "public/assets/audio/sfx/breakwater-sfx.json",
  previous = check ? JSON.parse(await readFile(metadataPath)) : null,
  rate = session.sampleRate,
  samples = new Map(),
  result = {
    format: 1,
    sessionSha256: hash(sessionBytes),
    provenanceSha256: hash(provenanceBytes),
    recipe:
      "Recorded mono layers, trim/resample/filter, short envelopes, wrapped loop tails, PCM24 FLAC masters, Vorbis quality 5 with 20 ms Ogg pages",
    encoder: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0],
    clips: [],
  };
assert.equal(session.format, 1);
assert.equal(rate, 48000);
assert.equal(session.channels, 1);
if (previous) {
  assert.equal(previous.sessionSha256, result.sessionSha256, "Stale SFX session");
  assert.equal(previous.provenanceSha256, result.provenanceSha256, "Stale SFX provenance");
}
const ffmpeg = (args, input) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
const pcm = (file) => {
  const bytes = ffmpeg(["-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"]);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
};
for (const library of Object.values(provenance.libraries))
  assert.equal(hash(await readFile(`${root}/${library.licenceFile}`)), library.licenceSha256);
for (const sample of provenance.files) {
  assert(!samples.has(sample.id), "Duplicate sample");
  const bytes = await readFile(`${root}/${sample.file}`);
  assert.equal(bytes.length, sample.bytes);
  assert.equal(hash(bytes), sample.sha256, sample.file);
  assert(provenance.libraries[sample.library], "Unknown source licence");
  if (!check) {
    const decoded = pcm(`${root}/${sample.file}`);
    let first = decoded.findIndex((v) => Math.abs(v) > 0.005);
    assert(first >= 0, "Silent source");
    first = Math.max(0, first - 48);
    let peak = 0;
    for (const value of decoded) peak = Math.max(peak, Math.abs(value));
    samples.set(
      sample.id,
      Float32Array.from(decoded.subarray(first), (v) => v / peak),
    );
  } else samples.set(sample.id, null);
}
await mkdir(`${root}/masters/sfx`, { recursive: true });
await mkdir("public/assets/audio/sfx", { recursive: true });
const ids = new Set(),
  used = new Set();
for (const clip of session.cues) {
  assert(/^[a-z][a-z0-9-]+$/.test(clip.id) && !ids.has(clip.id), "Invalid SFX identity");
  ids.add(clip.id);
  assert(clip.seconds >= 0.08 && clip.seconds <= 3 && typeof clip.loop === "boolean");
  assert(clip.peak > 0 && clip.peak <= 0.7);
  assert(clip.layers.length > 0 && clip.layers.length <= 64);
  const frames = Math.round(clip.seconds * rate),
    master = `masters/sfx/${clip.id}.flac`,
    file = `assets/audio/sfx/${clip.id}.ogg`,
    channels = new Float64Array(frames);
  for (const layer of clip.layers) {
    used.add(layer.sample);
    assert(samples.has(layer.sample), "Unknown recorded source");
    for (const [key, max] of [
      ["at", 3],
      ["seconds", 3],
      ["gain", 2],
      ["rate", 3],
      ["attack", 1],
      ["release", 1],
    ])
      assert(Number.isFinite(layer[key]) && layer[key] >= 0 && layer[key] <= max, key);
    assert(layer.rate >= 0.25 && layer.seconds > 0 && layer.gain > 0 && layer.release > 0);
    assert(layer.at < clip.seconds && layer.attack + layer.release <= layer.seconds);
    assert((layer.offset ?? 0) >= 0 && (layer.offset ?? 0) < 2);
    for (const key of ["highpass", "lowpass"])
      if (layer[key] !== undefined) assert(layer[key] >= 20 && layer[key] <= 20000);
    if (check) continue;
    const filters = [`asetrate=${Math.round(rate * layer.rate)}`, `aresample=${rate}`];
    if (layer.highpass) filters.push(`highpass=f=${layer.highpass}`);
    if (layer.lowpass) filters.push(`lowpass=f=${layer.lowpass}`);
    const bytes = ffmpeg(
        [
          "-f",
          "f32le",
          "-ar",
          String(rate),
          "-ac",
          "1",
          "-i",
          "pipe:0",
          "-af",
          filters.join(","),
          "-f",
          "f32le",
          "pipe:1",
        ],
        Buffer.from(samples.get(layer.sample).buffer),
      ),
      decoded = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
      offset = Math.round((layer.offset ?? 0) * rate),
      length = Math.min(Math.round(layer.seconds * rate), decoded.length - offset),
      start = Math.round(layer.at * rate);
    assert(length > 0, "Empty sample layer");
    for (let i = 0; i < length; i++) {
      const index = start + i;
      if (!clip.loop && index >= frames) break;
      const envelope = Math.min(
        1,
        i / Math.max(1, rate * layer.attack),
        (length - 1 - i) / (rate * layer.release),
      );
      channels[index % frames] += decoded[offset + i] * layer.gain * envelope;
    }
  }
  if (!check) {
    const mean = channels.reduce((sum, value) => sum + value, 0) / frames;
    for (let i = 0; i < frames; i++) channels[i] -= mean;
    if (clip.loop) {
      // A short end bridge makes the source periodic without imposing silence on the whole loop.
      const delta = channels[0] - channels[frames - 1],
        bridge = 576;
      for (let i = 0; i < bridge; i++) channels[frames - bridge + i] += (delta * i) / (bridge - 1);
    } else {
      for (let i = 0; i < 96; i++) {
        channels[i] *= i / 96;
        channels[frames - 1 - i] *= i / 96;
      }
    }
    let peak = 0;
    for (const value of channels) peak = Math.max(peak, Math.abs(value));
    assert(peak > 0.001, "Silent mix");
    const normalized = Float32Array.from(channels, (value) => (value * clip.peak) / peak);
    ffmpeg(
      [
        "-y",
        "-f",
        "f32le",
        "-ar",
        String(rate),
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-c:a",
        "flac",
        "-sample_fmt",
        "s32",
        "-bits_per_raw_sample",
        "24",
        `${root}/${master}`,
      ],
      Buffer.from(normalized.buffer),
    );
    // Short single-page Ogg exports decoded 128 frames short in FFmpeg. Explicit pages retain the full timeline.
    ffmpeg([
      "-y",
      "-i",
      `${root}/${master}`,
      "-c:a",
      "libvorbis",
      "-q:a",
      "5",
      "-page_duration",
      "20000",
      "-fflags",
      "+bitexact",
      "-map_metadata",
      "-1",
      `public/${file}`,
    ]);
  }
  const decoded = pcm(`public/${file}`),
    encoded = await readFile(`public/${file}`),
    masterBytes = await readFile(`${root}/${master}`);
  assert.equal(decoded.length, frames, `${clip.id}: decoded length`);
  let peak = 0,
    energy = 0;
  for (const value of decoded) {
    assert(Number.isFinite(value));
    peak = Math.max(peak, Math.abs(value));
    energy += value * value;
  }
  const rms = Math.sqrt(energy / frames),
    seamDelta = Math.abs(decoded[0] - decoded[frames - 1]);
  assert(peak < 0.9 && rms > 0.006, `${clip.id}: headroom/silence`);
  if (clip.loop) assert(seamDelta < 0.025, `${clip.id}: decoded loop seam`);
  const record = {
    id: clip.id,
    file,
    master,
    frames,
    sampleRate: rate,
    channels: 1,
    loop: clip.loop,
    loopStart: 0,
    loopEnd: clip.seconds,
    decodedBytes: frames * 4,
    bytes: encoded.length,
    sha256: hash(encoded),
    masterSha256: hash(masterBytes),
    peak,
    rms,
    seamDelta,
  };
  if (check) {
    const old = previous.clips.find((v) => v.id === clip.id);
    assert(old, "Missing SFX export");
    for (const key of Object.keys(record))
      if (["peak", "rms", "seamDelta"].includes(key))
        assert(Math.abs(old[key] - record[key]) < 1e-6, `${clip.id}: ${key}`);
      else assert.equal(old[key], record[key], `${clip.id}: ${key}`);
  }
  result.clips.push(record);
}
assert.equal(used.size, provenance.files.length, "Unused source recordings");
assert(result.clips.reduce((sum, c) => sum + c.bytes, 0) < 2 * 1024 * 1024, "SFX download budget");
assert(
  result.clips.reduce((sum, c) => sum + c.decodedBytes, 0) < 8 * 1024 * 1024,
  "SFX decoded budget",
);
if (check) assert.equal(previous.clips.length, result.clips.length);
else {
  await writeFile(metadataPath, `${JSON.stringify(result, null, 2)}\n`);
  const path = "public/assets/manifest.json",
    manifest = JSON.parse(await readFile(path));
  manifest.sources["edgefall-breakwater-sfx"] = {
    creator:
      "Original Edgefall layer arrangements by Codex; Kenney CC0 foley and VSCO CE recorded instruments",
    licence: "Project-original",
    provenance:
      "Exact CC0 sources, licences, editable layer sessions and lossless derived masters in audio/source/sfx; pnpm audio:sfx:render. Human listening review pending.",
  };
  for (const file of [...result.clips.map((v) => v.file), "assets/audio/sfx/breakwater-sfx.json"]) {
    const bytes = await readFile(`public/${file}`),
      record = {
        path: file,
        bytes: bytes.length,
        sha256: hash(bytes),
        source: "edgefall-breakwater-sfx",
        licence: "Project-original",
        maxBytes: 250000,
      };
    const index = manifest.assets.findIndex((v) => v.path === file);
    if (index < 0) manifest.assets.push(record);
    else manifest.assets[index] = record;
  }
  manifest.assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
console.log(
  `${check ? "Validated" : "Rendered"} ${result.clips.length} recorded SFX variants; ${result.clips.reduce((sum, c) => sum + c.decodedBytes, 0)} decoded bytes.`,
);

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const source = "audio/source",
  scoreBytes = await readFile(`${source}/scores/breakwater.json`),
  provenanceBytes = await readFile(`${source}/provenance.json`),
  score = JSON.parse(scoreBytes),
  provenance = JSON.parse(provenanceBytes),
  check = process.argv.includes("--check"),
  rate = score.sampleRate;
assert.equal(rate, 48000);
assert.equal(score.tempo, 144);
assert.equal(score.beatsPerBar, 4);
assert.equal(score.tracks.length, 2);
const ffmpeg = (args, input) =>
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    input,
    maxBuffer: 40_000_000,
  });
const samples = new Map();
assert.equal(
  hash(await readFile(`${source}/${provenance.licenceFile}`)),
  provenance.licenceSha256,
  "Sample license changed",
);
for (const sample of provenance.files) {
  assert.equal(hash(await readFile(`${source}/${sample.file}`)), sample.sha256, sample.id);
  const bytes = ffmpeg([
    "-i",
    `${source}/${sample.file}`,
    "-ac",
    "1",
    "-ar",
    String(rate),
    "-f",
    "f32le",
    "pipe:1",
  ]);
  const data = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4),
    peak = data.reduce((p, v) => Math.max(p, Math.abs(v)), 0),
    onset = Math.max(0, data.findIndex((v) => Math.abs(v) >= peak * 0.015) - 96);
  samples.set(sample.id, { ...sample, data: data.slice(onset), peak, onset });
}
await mkdir(`${source}/masters`, { recursive: true });
const metadataPath = "public/assets/audio/breakwater-music.json",
  previous = check ? JSON.parse(await readFile(metadataPath)) : null,
  result = {
    format: 1,
    tempo: score.tempo,
    beatsPerBar: 4,
    sampleRate: rate,
    scoreSha256: hash(scoreBytes),
    provenanceSha256: hash(provenanceBytes),
    render:
      "pnpm audio:render; recorded samples, resampled notes, cosine-panned stereo mix, wrapped note/reverb tails, PCM24 FLAC masters and Vorbis quality 5",
    encoder: execFileSync("ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0],
    tracks: [],
  };
if (check) {
  assert.equal(previous.scoreSha256, result.scoreSha256, "Stale score export");
  assert.equal(previous.provenanceSha256, result.provenanceSha256, "Stale sample provenance");
}
for (const track of score.tracks) {
  assert.equal(track.bars, 16);
  assert(track.notes.length > 100 && track.notes.length < 5000);
  const length = (rate * 60 * track.bars * score.beatsPerBar) / score.tempo,
    secondsPerBeat = 60 / score.tempo,
    file = `assets/audio/${track.id}-music.ogg`,
    master = `masters/${track.id}.flac`;
  assert(Number.isSafeInteger(length));
  if (!check) {
    const channels = [new Float64Array(length), new Float64Array(length)],
      cache = new Map();
    for (const note of track.notes) {
      const sample = samples.get(note.instrument),
        settings = score.instruments[note.instrument];
      assert(sample && settings, "Unknown score instrument");
      assert(Number.isFinite(note.beat) && note.beat >= 0 && note.beat < track.bars * 4);
      assert(Number.isFinite(note.beats) && note.beats > 0 && note.beats <= 8);
      assert(Number.isFinite(note.velocity) && note.velocity > 0 && note.velocity <= 1);
      assert(
        note.note === null || (Number.isInteger(note.note) && note.note >= 24 && note.note <= 96),
      );
      const key = `${note.instrument}:${note.note}`;
      if (!cache.has(key)) {
        const ratio = note.note === null ? 1 : 2 ** ((note.note - sample.rootNote) / 12),
          bytes = ffmpeg(
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
              `asetrate=${Math.round(rate * ratio)},aresample=${rate}`,
              "-f",
              "f32le",
              "pipe:1",
            ],
            Buffer.from(sample.data.buffer),
          );
        cache.set(key, new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4));
      }
      const pcm = cache.get(key),
        start = Math.round(note.beat * secondsPerBeat * rate),
        sustain = Math.round(note.beats * secondsPerBeat * rate),
        release = Math.round(settings.releaseSeconds * rate),
        frames = Math.min(pcm.length, sustain + release),
        angle = ((settings.pan + 1) * Math.PI) / 4,
        gains = [Math.cos(angle), Math.sin(angle)].map(
          (p) => (p * settings.gain * note.velocity) / sample.peak,
        );
      for (let i = 0; i < frames; i++) {
        const envelope = Math.min(1, i / 96) * Math.min(1, (frames - i) / release);
        for (let channel = 0; channel < 2; channel++)
          channels[channel][(start + i) % length] += pcm[i] * envelope * gains[channel];
      }
    }
    // A short room return wraps at the exact musical loop, including the final note tails.
    const mixed = new Float32Array(length * 2);
    let peak = 0;
    for (let i = 0; i < length; i++)
      for (let c = 0; c < 2; c++) {
        let value = channels[c][i];
        for (const [delay, gain] of [
          [0.067, 0.12],
          [0.113, 0.08],
          [0.179, 0.04],
        ])
          value += channels[1 - c][(i - Math.round(delay * rate) + length) % length] * gain;
        mixed[i * 2 + c] = value;
        peak = Math.max(peak, Math.abs(value));
      }
    // Preserve arrangement dynamics while leaving predictable space for sound effects.
    const scale = Math.min(1, 0.55 / peak);
    for (let i = 0; i < mixed.length; i++) mixed[i] *= scale;
    ffmpeg(
      [
        "-y",
        "-f",
        "f32le",
        "-ar",
        String(rate),
        "-ac",
        "2",
        "-i",
        "pipe:0",
        "-c:a",
        "flac",
        "-sample_fmt",
        "s32",
        "-bits_per_raw_sample",
        "24",
        `${source}/${master}`,
      ],
      Buffer.from(mixed.buffer),
    );
    ffmpeg(["-y", "-i", `${source}/${master}`, "-c:a", "libvorbis", "-q:a", "5", `public/${file}`]);
  }
  const bytes = await readFile(`public/${file}`),
    masterBytes = await readFile(`${source}/${master}`),
    decoded = ffmpeg(["-i", `public/${file}`, "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]),
    pcm = new Float32Array(decoded.buffer, decoded.byteOffset, decoded.length / 4);
  assert.equal(pcm.length, length * 2, "Lossy decode changed the musical loop length");
  let peak = 0,
    energy = 0,
    maximumDelta = 0;
  for (let i = 0; i < pcm.length; i++) {
    peak = Math.max(peak, Math.abs(pcm[i]));
    energy += pcm[i] ** 2;
    if (i >= 2) maximumDelta = Math.max(maximumDelta, Math.abs(pcm[i] - pcm[i - 2]));
  }
  const seamDelta = Math.max(Math.abs(pcm[0] - pcm.at(-2)), Math.abs(pcm[1] - pcm.at(-1))),
    rms = Math.sqrt(energy / pcm.length);
  assert(peak < 0.7 && rms > 0.01, "Silent or overdriven score");
  assert(seamDelta < 0.025 && seamDelta < maximumDelta, "Discontinuous decoded loop seam");
  assert(bytes.length <= 1_500_000, "Compressed music budget exceeded");
  const entry = {
    id: track.id,
    title: track.title,
    file,
    master,
    frames: length,
    seconds: length / rate,
    loopStart: 0,
    loopEnd: length / rate,
    bars: track.bars,
    notes: track.notes.length,
    bytes: bytes.length,
    sha256: hash(bytes),
    masterSha256: hash(masterBytes),
    decodedBytes: pcm.byteLength,
    peak,
    rms,
    seamDelta,
    maximumDelta,
  };
  if (check)
    assert.deepEqual(
      entry,
      previous.tracks.find((t) => t.id === track.id),
    );
  result.tracks.push(entry);
  console.log(
    JSON.stringify({
      track: track.id,
      seconds: entry.seconds,
      bytes: entry.bytes,
      peak,
      rms,
      seamDelta,
    }),
  );
}
assert(result.tracks.reduce((sum, t) => sum + t.decodedBytes, 0) <= 24 * 1024 * 1024);
if (!check) {
  await writeFile(metadataPath, `${JSON.stringify(result, null, 2)}\n`);
  const manifestPath = "public/assets/manifest.json",
    manifest = JSON.parse(await readFile(manifestPath));
  manifest.sources["edgefall-breakwater-music"] = {
    creator:
      "Original Edgefall score by Codex; VSCO CE instruments recorded by Sam Gossner and Simon Dalzell, edited by Elan Hickler / Soundemote",
    licence: "Project-original",
    provenance:
      "Editable score, lossless masters and CC0 sample provenance in audio/source; pnpm audio:render.",
  };
  for (const file of [...result.tracks.map((t) => t.file), "assets/audio/breakwater-music.json"]) {
    const bytes = await readFile(`public/${file}`),
      entry = {
        path: file,
        bytes: bytes.length,
        sha256: hash(bytes),
        source: "edgefall-breakwater-music",
        licence: "Project-original",
        maxBytes: file.endsWith(".json") ? 32000 : 1500000,
      };
    const i = manifest.assets.findIndex((a) => a.path === file);
    if (i < 0) manifest.assets.push(entry);
    else manifest.assets[i] = entry;
  }
  manifest.assets.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

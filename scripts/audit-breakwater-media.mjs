import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const files = [];
for (const players of [1, 2, 4]) {
  const directory =
    players === 1 ? "dist/breakwater-evidence" : `dist/breakwater-${players}-evidence`;
  const report = JSON.parse(await readFile(`${directory}/report.json`));
  assert.equal(report.status, "pass");
  for (const video of report.videos)
    for (const extension of ["webm", "mp4"]) {
      const file = `${directory}/${video.name}.${extension}`;
      const decoded = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-nostats", "-i", file, "-af", "astats=reset=0", "-vn", "-f", "null", "-"],
        { encoding: "utf8" },
      );
      assert.equal(decoded.status, 0, `Media decode failed: ${file}`);
      const peakDb = [...decoded.stderr.matchAll(/Peak level dB: ([-.\d]+)/g)].map((m) =>
          Number(m[1]),
        ),
        rmsDb = [...decoded.stderr.matchAll(/RMS level dB: ([-.\d]+)/g)].map((m) => Number(m[1]));
      assert.equal(peakDb.length, 3, "Expected two channels and the overall peak");
      assert(
        peakDb.every((db) => db < 20 * Math.log10(0.99)),
        `Stereo clipping: ${file}`,
      );
      assert(
        rmsDb.every((db) => db > -80),
        `Silent channel: ${file}`,
      );
      files.push({ file, peakDb, rmsDb });
    }
}
const result = {
  status: "pass",
  scope:
    "Independent FFmpeg decode of each stereo channel in raw WebAudio/WebM captures and the published AAC/MP4 encodes; no mono downmix masks channel peaks.",
  files,
};
await writeFile("dist/breakwater-media-audit.json", `${JSON.stringify(result, null, 2)}\n`);
console.log(
  JSON.stringify({
    status: result.status,
    files: files.length,
    maximumChannelPeakDb: Math.max(...files.flatMap((file) => file.peakDb)),
  }),
);

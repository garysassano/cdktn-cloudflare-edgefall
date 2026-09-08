import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { AUDIO_EXPORT, exportBreakwaterVideo } from "./lib/export-breakwater-video.mjs";

for (const players of [1, 2, 4]) {
  const directory =
    players === 1 ? "dist/breakwater-evidence" : `dist/breakwater-${players}-evidence`;
  const report = JSON.parse(await readFile(`${directory}/report.json`));
  assert.equal(report.status, "pass");
  for (const video of report.videos) {
    exportBreakwaterVideo(`${directory}/${video.name}`, true);
    const seconds = Number(
      execFileSync(
        "ffprobe",
        [
          "-v",
          "error",
          "-show_entries",
          "format=duration",
          "-of",
          "default=nw=1:nk=1",
          `${directory}/${video.name}.mp4`,
        ],
        { encoding: "utf8" },
      ),
    );
    assert(Math.abs(seconds - video.duration) < 0.04, "Re-encoding changed capture duration");
    video.audioExport = AUDIO_EXPORT;
    video.duration = video.clocks.videoSeconds = seconds;
    await writeFile(
      `${directory}/${video.name}-clocks.json`,
      `${JSON.stringify(video.clocks, null, 2)}\n`,
    );
    console.log(`Re-encoded audio; retained H.264 video: ${video.name}`);
  }
  report.exportNote =
    "AAC exports use the fast search coder at 192 kbit/s and -1 dB reserve after stereo audit exposed overshoot with the default two-loop coder. Raw WebM and captured H.264 video are unchanged.";
  await writeFile(`${directory}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
}

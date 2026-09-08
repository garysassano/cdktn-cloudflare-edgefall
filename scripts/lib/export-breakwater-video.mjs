import { execFileSync } from "node:child_process";
import { renameSync } from "node:fs";

export const AUDIO_EXPORT = { codec: "AAC", coder: "fast", bitrate: 192000, gainDb: -1 };
/** Reserve codec headroom without changing recording clocks or relative sound/music levels. */
export function exportBreakwaterVideo(base, preserveVideo = false) {
  const output = `${base}.export.mp4`;
  execFileSync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    `${base}.webm`,
    ...(preserveVideo
      ? ["-i", `${base}.mp4`, "-map", "1:v:0", "-map", "0:a:0", "-c:v", "copy"]
      : ["-c:v", "libx264", "-crf", "20", "-pix_fmt", "yuv420p"]),
    "-af",
    `aresample=async=1:first_pts=0,volume=${AUDIO_EXPORT.gainDb}dB`,
    "-c:a",
    "aac",
    "-aac_coder",
    AUDIO_EXPORT.coder,
    "-b:a",
    String(AUDIO_EXPORT.bitrate),
    "-movflags",
    "+faststart",
    output,
  ]);
  renameSync(output, `${base}.mp4`);
}

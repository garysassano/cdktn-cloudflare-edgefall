import { mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
const result = await build({
  bundle: true,
  entryPoints: ["src/worker/index.ts"],
  format: "esm",
  loader: {
    ".css": "text",
    ".html": "text",
    ".svg": "text",
    ".txt": "text",
  },
  minify: true,
  outfile: "dist/index.js",
  platform: "neutral",
  target: "es2022",
});

if (result.errors.length > 0) process.exitCode = 1;
else console.log("Built self-contained Worker: dist/index.js");

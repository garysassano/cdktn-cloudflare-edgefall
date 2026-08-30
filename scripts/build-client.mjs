import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "src", "generated");

const result = await build({
  bundle: true,
  entryPoints: [join(root, "src", "client", "index.ts")],
  format: "iife",
  legalComments: "none",
  minify: true,
  platform: "browser",
  target: "es2022",
  tsconfigRaw: {
    compilerOptions: { target: "ES2022" },
  },
  write: false,
});

const output = result.outputFiles?.[0];
if (!output) {
  throw new Error("esbuild produced no browser bundle");
}

await mkdir(outputDirectory, { recursive: true });
await writeFile(join(outputDirectory, "client.txt"), output.text);
console.log(`Built browser client: ${output.text.length.toLocaleString()} bytes`);

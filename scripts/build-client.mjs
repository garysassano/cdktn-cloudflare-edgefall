import { execFileSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "dist", "client");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await build({
  bundle: true,
  entryPoints: [join(root, "src", "client", "index.ts")],
  format: "iife",
  legalComments: "none",
  minify: true,
  outfile: join(outputDirectory, "client.js"),
  platform: "browser",
  target: "es2022",
  tsconfigRaw: { compilerOptions: { target: "ES2022" } },
});

await Promise.all([
  cp(join(root, "src", "client", "index.html"), join(outputDirectory, "index.html")),
  cp(join(root, "src", "client", "styles.css"), join(outputDirectory, "styles.css")),
  cp(join(root, "src", "client", "favicon.svg"), join(outputDirectory, "favicon.svg")),
  cp(join(root, "public", "assets"), join(outputDirectory, "assets"), { recursive: true }),
]);

console.log("Built Phaser client and static assets: dist/client");

// Explicit opt-in; every ordinary build removes the lab with the output directory.
if (process.argv.includes("--lab")) {
  execFileSync("pnpm", ["exec", "tsx", "scripts/assets/review-studies.ts", "--preview"], {
    cwd: root,
    stdio: "inherit",
  });
  await cp(
    join(root, "art", "source", "hero", "operative.pixels.json"),
    join(outputDirectory, "art-review", "operative.pixels.json"),
  );
  await cp(
    join(root, "content", "engineering", "terrain.png"),
    join(outputDirectory, "engineering-terrain.png"),
  );
  for (const name of ["lab", "controller-lab", "network-lab", "combat-lab", "art-review"]) {
    await build({
      bundle: true,
      entryPoints: [join(root, "src", "client", `${name}.ts`)],
      format: "iife",
      outfile: join(outputDirectory, `${name}.js`),
      platform: "browser",
      target: "es2022",
    });
    await cp(join(root, "src", "client", `${name}.html`), join(outputDirectory, `${name}.html`));
  }
}

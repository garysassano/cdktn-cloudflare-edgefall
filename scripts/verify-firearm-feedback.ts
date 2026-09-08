import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const cases = [];
const resume = process.argv.includes("--resume");
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expected = resume
  ? {
      worker: hash(
        (
          await build({
            entryPoints: ["src/worker/diagnostics/room-probe.ts"],
            bundle: true,
            external: ["cloudflare:workers"],
            platform: "neutral",
            format: "esm",
            write: false,
          })
        ).outputFiles[0]?.contents ?? new Uint8Array(),
      ),
      client: hash(
        (
          await build({
            entryPoints: [resolve("src/client/network-lab.ts")],
            bundle: true,
            format: "iife",
            outfile: resolve("dist/client/network-lab.js"),
            platform: "browser",
            target: "es2022",
            write: false,
          })
        ).outputFiles[0]?.contents ?? new Uint8Array(),
      ),
    }
  : null;
// Each child rebuilds dist/client. Keep browser build/run/readback jobs sequential.
for (const scenario of [
  "sidearm",
  "heavy-machine-gun",
  "shotgun",
  "rocket-launcher",
  "flamethrower",
  "laser",
]) {
  const directory = `dist/network-firearm-feedback/${scenario}`;
  const cached = resume
    ? await readFile(`${directory}/report.json`).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      })
    : null;
  if (cached && expected) {
    const report = JSON.parse(cached.toString());
    assert.equal(report.status, "pass");
    assert.equal(report.workerBundleSha256, expected.worker, "Cached Worker changed");
    assert.equal(report.bundleSha256, expected.client, "Cached client changed");
    const execution = JSON.parse(await readFile(`${directory}/execution.json`, "utf8"));
    for (const { file, sha256 } of execution.sources)
      assert.equal(hash(await readFile(file)), sha256, `Cached verifier changed: ${file}`);
  } else {
    const stdout = execFileSync(
      "pnpm",
      ["exec", "tsx", "scripts/verify-network-controller.ts", `--combat-feedback=${scenario}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    await writeFile(`${directory}/execution.log`, stdout);
  }
  const bytes = await readFile(`${directory}/report.json`),
    report = JSON.parse(bytes.toString());
  assert.equal(report.status, "pass");
  cases.push({
    scenario,
    directory,
    reportSha256: createHash("sha256").update(bytes).digest("hex"),
    sharedSnapshots: report.sharedSnapshots,
  });
  console.log(JSON.stringify(cases.at(-1)));
}
await writeFile(
  "dist/network-firearm-feedback/report.json",
  `${JSON.stringify({ status: "pass", cases }, null, 2)}\n`,
);

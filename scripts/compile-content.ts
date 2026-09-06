import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { CONTRACT_FIXTURE } from "../src/game/content/contract-fixture.js";
import { canonical } from "../src/game/core/canonical.js";
import { compileLdtk } from "./lib/ldtk.js";

const source = "content/engineering/navigation.ldtk";
const output = "src/game/content/compiled/navigation.json";
const bytes = await readFile(source);
assert(bytes.length <= 8 * 1024 * 1024, "Editor input exceeds 8 MiB");
const compiled = compileLdtk(JSON.parse(bytes.toString("utf8")), CONTRACT_FIXTURE);
const sourceDirectory = await realpath(dirname(source));
const asset = await realpath(resolve(sourceDirectory, compiled.presentation.tileset.path));
assert(asset.startsWith(`${sourceDirectory}${sep}`), "Tileset escapes content directory");
const assetBytes = await readFile(asset);
assert(assetBytes.length <= 8 * 1024 * 1024, "Tileset exceeds 8 MiB");
assert(
  assetBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  "Tileset must be PNG",
);
assert.equal(
  assetBytes.readUInt32BE(16),
  compiled.presentation.tileset.width,
  "Tileset width mismatch",
);
assert.equal(
  assetBytes.readUInt32BE(20),
  compiled.presentation.tileset.height,
  "Tileset height mismatch",
);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const graphics = { ...compiled.presentation, assetSha256: sha(assetBytes) };
const graphicsHash = sha(canonical(graphics));
const artifact = {
  ...compiled,
  presentation: graphics,
  graphicsHash,
  buildHash: sha(
    canonical({ compiler: compiled.compiler, contentHash: compiled.contentHash, graphicsHash }),
  ),
};
const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
if (process.argv.includes("--check"))
  assert.equal(
    await readFile(output, "utf8"),
    serialized,
    "Compiled content is stale; run pnpm content:compile",
  );
else {
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized);
}
console.log(
  JSON.stringify({
    status: "pass",
    source,
    output,
    sourceSha256: sha(bytes),
    schemaSha256: sha(await readFile("scripts/content/ldtk-1.5.3/schema.json")),
    contentHash: artifact.contentHash,
    graphicsHash,
    buildHash: artifact.buildHash,
    terrain: artifact.gameplay.terrain.length,
    links: artifact.gameplay.links.length,
    checkpointTicks: artifact.gameplay.route.costTicks,
  }),
);

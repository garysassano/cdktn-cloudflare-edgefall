import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const outputs = JSON.parse(await readFile("dist/cdktn-outputs.json", "utf8"));
const databaseOutput = findOutput(outputs, "runs_database_id");
const bucketOutput = findOutput(outputs, "replays_bucket_name");
const databaseId =
  typeof databaseOutput === "string"
    ? databaseOutput
    : typeof databaseOutput?.value === "string"
      ? databaseOutput.value
      : undefined;
if (!databaseId) throw new Error("CDKTN output runs_database_id was not found");
const bucketName =
  typeof bucketOutput === "string"
    ? bucketOutput
    : typeof bucketOutput?.value === "string"
      ? bucketOutput.value
      : undefined;
if (!bucketName) throw new Error("CDKTN output replays_bucket_name was not found");

const source = await readFile("wrangler.jsonc", "utf8");
const config = JSON.parse(source.replace(/^\s*\/\/.*$/gmu, ""));
const runs = config.d1_databases?.find((database) => database.binding === "RUNS");
if (!runs) throw new Error("wrangler.jsonc is missing the RUNS D1 binding");
const replays = config.r2_buckets?.find((bucket) => bucket.binding === "REPLAYS");
if (!replays) throw new Error("wrangler.jsonc is missing the REPLAYS R2 binding");
runs.database_id = databaseId;
replays.bucket_name = bucketName;
config.main = resolve("src/worker/index.ts");
config.assets.directory = resolve("dist/client");

await writeFile(".wrangler.deploy.json", `${JSON.stringify(config, null, 2)}\n`);
console.log("Rendered .wrangler.deploy.json from CDKTN outputs");

function findOutput(value, key) {
  if (!value || typeof value !== "object") return undefined;
  if (key in value) return value[key];
  for (const child of Object.values(value)) {
    const match = findOutput(child, key);
    if (match !== undefined) return match;
  }
  return undefined;
}

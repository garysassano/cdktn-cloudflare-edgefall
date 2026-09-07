import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildArtStudyPreview, reviewArtStudies } from "../lib/art-studies.js";

const report = await reviewArtStudies(resolve("."));
const target = "docs/redesign-evidence/style-v2/source-review.json";
if (process.argv.includes("--preview"))
  await buildArtStudyPreview(resolve("."), resolve("dist/client/art-review"));
else if (process.argv.includes("--write"))
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`);
else
  assert.deepEqual(
    JSON.parse(await readFile(target, "utf8")),
    report,
    "Art source review is stale; inspect changes and run pnpm art:review",
  );
console.log(
  JSON.stringify({
    sourceIntegrity: report.sourceIntegrity,
    studies: report.studies.length,
    unchangedImportsAllowed: report.studies.filter((study) => study.image.canImportUnchanged)
      .length,
    humanStyleReview: report.humanStyleReview,
    scope: report.scope,
  }),
);

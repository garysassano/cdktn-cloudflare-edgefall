import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import sharp from "sharp";
import { type ArtGrid, inspectArtImage } from "./art-image.js";

export interface ArtStudy {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  prompt: string;
  promptSha256: string;
  creator: string;
  licence: string;
  role: "concept-study";
  references: string[];
  requested: ArtGrid;
  humanReview: { status: "pending"; reviewer: null };
  artAssessment: { status: "revision-required"; issues: string[] };
}
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
async function sourcePath(root: string, file: string) {
  assert(typeof file === "string" && file.startsWith("art/source/"), "Expected art source path");
  const path = await realpath(resolve(root, file));
  assert(
    path.startsWith(`${await realpath(resolve(root, "art/source"))}${sep}`),
    "Art path escapes source tree",
  );
  return path;
}
/** Integrity may pass for a rejected study; no result of this command grants artistic approval. */
export async function reviewArtStudies(root: string) {
  const raw = await readFile(resolve(root, "art/source/provenance.json"));
  const index = JSON.parse(raw.toString()) as {
    format: number;
    policy: string;
    sources: ArtStudy[];
  };
  assert(index.format === 1 && index.policy?.trim(), "Invalid art provenance index");
  assert(Array.isArray(index.sources) && index.sources.length > 0 && index.sources.length <= 32);
  const seen = new Set<string>(),
    files = new Set<string>(),
    previewNames = new Map<string, string>(),
    studies = [];
  for (const entry of index.sources) {
    assert(/^[a-z][a-z0-9-]+$/.test(entry.id) && !seen.has(entry.id), "Duplicate/invalid study ID");
    assert(!files.has(entry.file), "Duplicate art source file");
    assert(entry.role === "concept-study", "Study review cannot admit runtime art");
    assert(entry.creator?.trim() && entry.licence?.trim(), "Missing art provenance");
    assert(
      entry.humanReview?.status === "pending" && entry.humanReview.reviewer === null,
      "Study review cannot record human acceptance",
    );
    assert(
      entry.artAssessment?.status === "revision-required" && entry.artAssessment.issues.length > 0,
    );
    assert(
      Array.isArray(entry.references) && entry.references.every((id) => seen.has(id)),
      "Unknown/circular source reference",
    );
    const file = await sourcePath(root, entry.file),
      prompt = await sourcePath(root, entry.prompt);
    for (const path of [entry.file, entry.prompt]) {
      const existing = previewNames.get(basename(path));
      assert(existing === undefined || existing === path, "Preview filename collision");
      previewNames.set(basename(path), path);
    }
    const bytes = await readFile(file),
      promptBytes = await readFile(prompt);
    assert(entry.file.endsWith(".png") && entry.prompt.endsWith(".prompt.txt"));
    assert(
      bytes.length === entry.bytes && sha(bytes) === entry.sha256,
      `Stale source: ${entry.file}`,
    );
    assert(
      promptBytes.length > 0 && sha(promptBytes) === entry.promptSha256,
      `Stale prompt: ${entry.prompt}`,
    );
    studies.push({ ...entry, image: await inspectArtImage(bytes, entry.requested) });
    seen.add(entry.id);
    files.add(entry.file);
  }
  return {
    format: 1,
    sourceIndexSha256: sha(raw),
    decoder: { sharp: sharp.versions.sharp, vips: sharp.versions.vips },
    sourceIntegrity: "pass",
    humanStyleReview: "pending",
    scope:
      "Concept-source inspection only. No export, pixel repair, animation validation, runtime admission or human approval is performed.",
    studies,
  };
}
export async function buildArtStudyPreview(root: string, output: string) {
  const report = await reviewArtStudies(root);
  await mkdir(output, { recursive: true });
  for (const study of report.studies) {
    await cp(await sourcePath(root, study.file), resolve(output, basename(study.file)));
    await cp(await sourcePath(root, study.prompt), resolve(output, basename(study.prompt)));
  }
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

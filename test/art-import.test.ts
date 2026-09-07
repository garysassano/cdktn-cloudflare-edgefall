import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { inspectArtImage } from "../scripts/lib/art-image.js";
import { reviewArtStudies } from "../scripts/lib/art-studies.js";

const grid = { nativeWidth: 2, nativeHeight: 2, pixelScale: 2, columns: 1, rows: 1 };
function pixels() {
  const raw = Buffer.alloc(4 * 4 * 4);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) raw.set([30, 80, 120, 255], (y * 4 + x) * 4);
  return raw;
}
const png = (data: Buffer) =>
  sharp(data, { raw: { width: 4, height: 4, channels: 4 } })
    .png()
    .toBuffer();
describe("native art import checks", () => {
  it("recognizes an exact enlarged binary-alpha grid without granting artistic approval", async () => {
    const result = await inspectArtImage(await png(pixels()), grid);
    expect(result.canImportUnchanged).toBe(true);
    expect(result.alpha).toEqual({ transparent: 12, opaque: 4, partial: 0, hiddenRgb: 0 });
    expect(result.nonuniformBlocks).toBe(0);
  });
  it("detects a semi-transparent body even when the PNG header declares alpha", async () => {
    const raw = pixels();
    raw[3] = 127;
    const result = await inspectArtImage(await png(raw), grid);
    expect(result.hasAlphaChannel).toBe(true);
    expect(result.canImportUnchanged).toBe(false);
    expect(result.findings.some((finding) => finding.code === "partial-alpha")).toBe(true);
  });
  it("rejects opaque RGB sheets instead of treating painted backgrounds as transparency", async () => {
    const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: "white" } })
      .png()
      .toBuffer();
    const result = await inspectArtImage(bytes, grid);
    expect(result.alpha).toMatchObject({ transparent: 0, opaque: 16 });
    expect(result.findings.some((finding) => finding.code === "opaque-background")).toBe(true);
  });
  it("detects a broken source pixel even when image dimensions and binary alpha match", async () => {
    const raw = pixels();
    raw[0] = 31;
    const result = await inspectArtImage(await png(raw), grid);
    expect(result.nonuniformBlocks).toBe(1);
    expect(result.canImportUnchanged).toBe(false);
  });
  it("retains hidden color defects in its report instead of silently repairing the source", async () => {
    const raw = pixels();
    raw[(3 * 4 + 3) * 4] = 200;
    const bytes = await png(raw),
      before = Buffer.from(bytes);
    const result = await inspectArtImage(bytes, grid);
    expect(result.alpha.hiddenRgb).toBe(1);
    expect(result.canImportUnchanged).toBe(false);
    expect(bytes.equals(before)).toBe(true);
  });
  it("rejects corrupt files, fractional grids and oversized declarations before admission", async () => {
    await expect(inspectArtImage(Buffer.from("invalid PNG"), grid)).rejects.toThrow();
    await expect(inspectArtImage(await png(pixels()), { ...grid, columns: 3 })).rejects.toThrow(
      /fractional/,
    );
    await expect(
      inspectArtImage(await png(pixels()), { ...grid, nativeWidth: 4097 }),
    ).rejects.toThrow(/bounds/);
    expect(
      (await inspectArtImage(await png(pixels()), { ...grid, nativeWidth: 4 })).findings.some(
        (finding) => finding.code === "canvas-size",
      ),
    ).toBe(true);
  });
  it("binds study pixels and prompts to provenance while keeping even clean pixels outside runtime approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "edgefall-art-import-"));
    try {
      const directory = join(root, "art/source");
      await mkdir(directory, { recursive: true });
      const bytes = await png(pixels()),
        prompt = Buffer.from("Synthetic pixel validator control, not game art.");
      const hash = (data: Buffer) => createHash("sha256").update(data).digest("hex");
      const index = {
        format: 1,
        policy: "Test concept sources only",
        sources: [
          {
            id: "test-study",
            role: "concept-study",
            file: "art/source/test.png",
            bytes: bytes.length,
            sha256: hash(bytes),
            prompt: "art/source/test.prompt.txt",
            promptSha256: hash(prompt),
            creator: "Automated test fixture",
            licence: "Project-original",
            references: [],
            requested: grid,
            humanReview: { status: "pending", reviewer: null },
            artAssessment: {
              status: "revision-required",
              issues: ["Synthetic test pixels are not art."],
            },
          },
        ],
      };
      await writeFile(join(directory, "test.png"), bytes);
      await writeFile(join(directory, "test.prompt.txt"), prompt);
      await writeFile(join(directory, "provenance.json"), JSON.stringify(index));
      const report = await reviewArtStudies(root);
      expect(report.studies[0]?.image.canImportUnchanged).toBe(true);
      expect(report.humanStyleReview).toBe("pending");
      expect(report.studies[0]?.role).toBe("concept-study");
      await writeFile(join(directory, "test.prompt.txt"), "silently changed prompt");
      await expect(reviewArtStudies(root)).rejects.toThrow(/Stale prompt/);
      await writeFile(join(directory, "test.prompt.txt"), prompt);
      await writeFile(join(directory, "test.png"), Buffer.from("silently changed image"));
      await expect(reviewArtStudies(root)).rejects.toThrow(/Stale source/);
      await writeFile(join(directory, "test.png"), bytes);
      await mkdir(join(directory, "other"));
      await writeFile(join(directory, "other/test.png"), bytes);
      const second = { ...index.sources[0], id: "second-study", file: "art/source/other/test.png" };
      await writeFile(
        join(directory, "provenance.json"),
        JSON.stringify({ ...index, sources: [...index.sources, second] }),
      );
      await expect(reviewArtStudies(root)).rejects.toThrow(/Preview filename collision/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

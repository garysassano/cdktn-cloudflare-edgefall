import { createHash } from "node:crypto";
import sharp from "sharp";

export interface ArtGrid {
  nativeWidth: number;
  nativeHeight: number;
  pixelScale: number;
  columns: number;
  rows: number;
}
export interface ArtFinding {
  code: string;
  message: string;
}
export function validateArtGrid(grid: ArtGrid) {
  for (const key of ["nativeWidth", "nativeHeight", "pixelScale", "columns", "rows"] as const)
    if (!Number.isSafeInteger(grid[key]) || grid[key] < 1)
      throw new Error(`Invalid art grid ${key}`);
  if (
    grid.pixelScale > 8 ||
    grid.nativeWidth * grid.pixelScale > 4096 ||
    grid.nativeHeight * grid.pixelScale > 4096 ||
    grid.nativeWidth % grid.columns !== 0 ||
    grid.nativeHeight % grid.rows !== 0
  )
    throw new Error("Art grid exceeds bounds or has fractional cells");
}
/** Read actual decoded pixels. Header alpha and a plausible preview do not establish clean sprites. */
export async function inspectArtImage(bytes: Buffer, grid: ArtGrid) {
  validateArtGrid(grid);
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024)
    throw new Error("Art source exceeds byte budget");
  const image = sharp(bytes, { limitInputPixels: 4096 * 4096, failOn: "warning" });
  const metadata = await image.metadata();
  if (metadata.format !== "png" || metadata.depth !== "uchar" || (metadata.pages ?? 1) !== 1)
    throw new Error("Art source must be a single 8-bit PNG");
  const { data, info } = await image
    .toColourspace("srgb")
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 4) throw new Error("Expected decoded RGBA pixels");
  const alpha = { transparent: 0, opaque: 0, partial: 0, hiddenRgb: 0 };
  const visibleColors = new Set<number>();
  for (let offset = 0; offset < data.length; offset += 4) {
    const a = data[offset + 3],
      rgb = ((data[offset] ?? 0) << 16) | ((data[offset + 1] ?? 0) << 8) | (data[offset + 2] ?? 0);
    if (a === 0) {
      alpha.transparent++;
      if (rgb !== 0) alpha.hiddenRgb++;
    } else {
      if (a === 255) alpha.opaque++;
      else alpha.partial++;
      if (visibleColors.size <= 65536) visibleColors.add(rgb);
    }
  }
  const findings: ArtFinding[] = [];
  const expected = {
    width: grid.nativeWidth * grid.pixelScale,
    height: grid.nativeHeight * grid.pixelScale,
  };
  if (info.width !== expected.width || info.height !== expected.height)
    findings.push({
      code: "canvas-size",
      message: `Requested ${expected.width}×${expected.height}; decoded ${info.width}×${info.height}.`,
    });
  if (alpha.transparent === 0)
    findings.push({ code: "opaque-background", message: "No transparent pixel exists." });
  if (alpha.opaque === 0)
    findings.push({ code: "no-opaque-body", message: "No fully opaque body pixel exists." });
  if (alpha.partial > 0)
    findings.push({
      code: "partial-alpha",
      message: `${alpha.partial} pixels have partial alpha; body art requires binary alpha.`,
    });
  if (alpha.hiddenRgb > 0)
    findings.push({
      code: "hidden-rgb",
      message: `${alpha.hiddenRgb} transparent pixels retain colored RGB.`,
    });
  let nonuniformBlocks: number | null = null;
  const scale = grid.pixelScale;
  if (info.width % scale !== 0 || info.height % scale !== 0)
    findings.push({
      code: "fractional-grid",
      message: "Image edges do not fit the declared pixel grid.",
    });
  else {
    nonuniformBlocks = 0;
    for (let y = 0; y < info.height; y += scale)
      for (let x = 0; x < info.width; x += scale) {
        const start = (y * info.width + x) * 4;
        let uniform = true;
        for (let dy = 0; dy < scale && uniform; dy++)
          for (let dx = 0; dx < scale && uniform; dx++)
            for (let channel = 0; channel < 4; channel++)
              if (data[((y + dy) * info.width + x + dx) * 4 + channel] !== data[start + channel]) {
                uniform = false;
                break;
              }
        if (!uniform) nonuniformBlocks++;
      }
    if (nonuniformBlocks > 0)
      findings.push({
        code: "nonuniform-pixel-grid",
        message: `${nonuniformBlocks} blocks differ inside a declared source pixel.`,
      });
  }
  return {
    width: info.width,
    height: info.height,
    hasAlphaChannel: metadata.hasAlpha,
    decodedRgbaSha256: createHash("sha256").update(data).digest("hex"),
    alpha,
    visibleColors: visibleColors.size > 65536 ? ">65536" : visibleColors.size,
    expected,
    pixelScale: scale,
    nonuniformBlocks,
    canImportUnchanged: findings.length === 0,
    findings,
  };
}

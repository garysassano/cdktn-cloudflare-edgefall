import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type {
  NativeAtlas,
  NativeChannel,
  NativeClip,
  NativeContact,
  NativeSockets,
} from "../../src/shared/animation/native.js";

export interface NativeDrawing {
  format: 1;
  id: string;
  status: "benchmark-candidate";
  creator: string;
  licence: "Project-original";
  reference: string;
  canvas: { width: number; height: number; root: [number, number] };
  palette: Record<string, string>;
  variants: Record<string, Record<string, string>>;
  frames: Array<{
    id: string;
    channel: NativeChannel;
    at: [number, number];
    rows: string[];
    sockets?: NativeSockets | null;
    contact?: NativeContact;
  }>;
  clips: NativeClip[];
  notes: string[];
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function number(value: number, min: number, max: number) {
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    "Invalid native pixel coordinate/count",
  );
}
/** Static indexed drawings compile directly to PNG; this exporter does not invent geometry or animation. */
export async function compileNativeArt(raw: Buffer, image: string) {
  assert(/^[a-z][a-z0-9-]+\.png$/.test(image), "Invalid native atlas image filename");
  assert(raw.length > 0 && raw.length <= 1_000_000, "Native source byte budget");
  const source = JSON.parse(raw.toString()) as NativeDrawing;
  assert(
    source.format === 1 && source.status === "benchmark-candidate",
    "Native source format/status",
  );
  assert(
    source.creator?.trim() && source.reference?.trim() && source.licence === "Project-original",
  );
  assert(/^[a-z][a-z0-9-]+$/.test(source.id), "Native source ID");
  const { width, height, root } = source.canvas;
  number(width, 1, 128);
  number(height, 1, 128);
  assert(Array.isArray(root) && root.length === 2);
  number(root[0], 0, width);
  number(root[1], 0, height);
  assert(source.palette["."] === "00000000", "Native transparent pixel must normalize hidden RGB");
  assert(Object.keys(source.palette).length <= 64, "Native drawing palette budget");
  for (const [symbol, color] of Object.entries(source.palette)) {
    assert(symbol.length === 1 && /^[0-9a-f]{8}$/.test(color), "Invalid native palette entry");
    assert(symbol === "." || color.endsWith("ff"), "Native bodies require binary alpha");
  }
  const variants = Object.keys(source.variants);
  number(variants.length, 1, 4);
  for (const [name, changes] of Object.entries(source.variants)) {
    assert(/^(base|p[1-4])$/.test(name), "Native palette ID");
    for (const [symbol, color] of Object.entries(changes))
      assert(
        symbol !== "." && source.palette[symbol] && /^[0-9a-f]{6}ff$/.test(color),
        "Invalid native palette override",
      );
  }
  number(source.frames.length, 1, 128);
  const known = new Map<string, NativeDrawing["frames"][number]>();
  for (const frame of source.frames) {
    assert(/^[a-z][a-z0-9-]+$/.test(frame.id) && !known.has(frame.id), "Native frame ID collision");
    assert(
      ["legs", "upper", "full-body", "effects"].includes(frame.channel),
      "Native frame channel",
    );
    number(frame.at[0], 0, width - 1);
    number(frame.at[1], 0, height - 1);
    number(frame.rows.length, 1, height - frame.at[1]);
    let visible = 0;
    for (const row of frame.rows) {
      assert(
        typeof row === "string" && row.length > 0 && row.length <= width - frame.at[0],
        "Native row exceeds canvas",
      );
      for (const symbol of row) {
        assert(source.palette[symbol], `Unknown native pixel ${symbol}`);
        if (symbol !== ".") visible++;
      }
    }
    assert(visible > 0, "Empty native drawing");
    for (const [name, point] of Object.entries(frame.sockets ?? {})) {
      assert(
        frame.channel !== "legs" &&
          ["muzzle", "hand", "grip"].includes(name) &&
          Array.isArray(point) &&
          point.length === 2,
        "Invalid native socket",
      );
      number(point[0], -root[0], width - root[0]);
      number(point[1], -root[1], height - root[1]);
      const [x, y] = point;
      const adjacent = (symbols: string) =>
        [-1, 0, 1].some((dy) =>
          [-1, 0, 1].some((dx) => {
            const symbol =
              frame.rows[root[1] + y + dy - frame.at[1]]?.[root[0] + x + dx - frame.at[0]];
            return symbol !== undefined && symbols.includes(symbol);
          }),
        );
      if (name !== "muzzle") {
        assert(adjacent("GgfSsk"), "Native hand/grip has no adjacent hand drawing");
        if (name === "grip") assert(adjacent("Mmi"), "Native grip does not meet its weapon");
        continue;
      }
      assert(
        [
          [0, 0],
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ].some(([dx = 0, dy = 0]) => {
          const symbol =
            frame.rows[root[1] + y + dy - frame.at[1]]?.[root[0] + x + dx - frame.at[0]];
          return symbol === "M" || symbol === "m" || symbol === "i";
        }),
        "Native muzzle has no adjacent gun drawing",
      );
    }
    if (frame.contact) {
      assert(
        frame.channel === "legs" && ["near", "far"].includes(frame.contact.foot),
        "Invalid native foot contact",
      );
      const [x, y] = frame.contact.point;
      number(x, -root[0], width - root[0]);
      assert(y === 0, "Planted native contact must meet the floor");
      assert(
        [-2, -1].some((dy) =>
          [-1, 0, 1].some((dx) => {
            const symbol =
              frame.rows[root[1] + y + dy - frame.at[1]]?.[root[0] + x + dx - frame.at[0]];
            return symbol === "B" || symbol === "t" || symbol === "u";
          }),
        ),
        "Native contact has no adjacent boot drawing",
      );
    }
    known.set(frame.id, frame);
  }
  const clipIds = new Set<string>();
  for (const clip of source.clips) {
    assert(!clipIds.has(clip.id) && clip.id.length > 0, "Native clip ID collision");
    assert(["loop", "hold-last"].includes(clip.mode));
    number(clip.exposures.length, 1, 64);
    for (const exposure of clip.exposures) {
      number(exposure.ticks, 1, 120);
      assert(
        known.get(exposure.frame)?.channel === clip.channel,
        "Native clip channel/frame mismatch",
      );
    }
    clipIds.add(clip.id);
  }
  const padding = 2,
    strideX = width + 2 * padding,
    strideY = height + 2 * padding;
  const maxRows = Math.floor(2048 / strideY),
    columns = Math.max(8, Math.ceil((source.frames.length * variants.length) / maxRows));
  const imageWidth = columns * strideX,
    imageHeight = Math.ceil((source.frames.length * variants.length) / columns) * strideY;
  assert(
    imageWidth <= 2048 && imageHeight <= 2048,
    "Split native art into multiple atlases to stay within the 2048-pixel texture budget",
  );
  const pixels = Buffer.alloc(imageWidth * imageHeight * 4);
  const atlas: NativeAtlas = {
    frames: {},
    meta: {
      image,
      size: { w: imageWidth, h: imageHeight },
      edgefall: {
        format: 2,
        sourceId: source.id,
        sourceSha256: hash(raw),
        root,
        variants,
        drawings: {},
        clips: source.clips,
        approval: "pending",
      },
    },
  };
  const frameHashes: Record<string, string> = {};
  for (const [index, frame] of source.frames.entries()) {
    atlas.meta.edgefall.drawings[frame.id] = {
      channel: frame.channel,
      ...(frame.sockets ? { sockets: frame.sockets } : {}),
      ...(frame.contact ? { contact: frame.contact } : {}),
    };
    for (const [variantIndex, variant] of variants.entries()) {
      const slot = variantIndex * source.frames.length + index,
        left = (slot % columns) * strideX + padding,
        top = Math.floor(slot / columns) * strideY + padding;
      const colors = { ...source.palette, ...source.variants[variant] },
        decoded = Buffer.alloc(width * height * 4);
      for (const [y, row] of frame.rows.entries())
        for (const [x, symbol] of [...row].entries()) {
          const color = Buffer.from(colors[symbol] ?? "", "hex");
          color.copy(decoded, ((frame.at[1] + y) * width + frame.at[0] + x) * 4);
          color.copy(pixels, ((top + frame.at[1] + y) * imageWidth + left + frame.at[0] + x) * 4);
        }
      const name = `${variant}/${frame.id}`;
      atlas.frames[name] = {
        frame: { x: left, y: top, w: width, h: height },
        rotated: false,
        trimmed: false,
        spriteSourceSize: { x: 0, y: 0, w: width, h: height },
        sourceSize: { w: width, h: height },
      };
      frameHashes[name] = hash(decoded);
    }
  }
  const png = await sharp(pixels, { raw: { width: imageWidth, height: imageHeight, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { source, atlas, png, frameHashes, sourceSha256: hash(raw) };
}

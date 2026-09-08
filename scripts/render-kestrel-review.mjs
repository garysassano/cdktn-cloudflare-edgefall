import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const output = "dist/kestrel-sheets",
  atlas = JSON.parse(await readFile("public/assets/art/vehicles/kestrel.atlas.json", "utf8")),
  image = await readFile("public/assets/art/vehicles/kestrel.png"),
  pages = [];
await mkdir(output, { recursive: true });
const cell = (row, col, hull, track, heading = 0, suffix = "", variant = "p1") => ({
  row,
  col,
  variant,
  frames: [track, `hull-${hull}`, `turret-${heading}${suffix}`, "hatch-closed"].map(
    (id) => `kestrel-${id}`,
  ),
  label: `${variant} ${hull} ${heading}${suffix}`,
});
pages.push({
  name: "drive",
  rows: 3,
  columns: 8,
  cells: Array.from({ length: 24 }, (_, i) => {
    const phase = i % 8;
    return {
      ...cell(
        Math.floor(i / 8),
        phase,
        i >= 16
          ? "rise-extend"
          : [
              "drive-load",
              "drive-load",
              "idle",
              "idle",
              "drive-return",
              "drive-return",
              "idle",
              "idle",
            ][phase],
        `track-${phase}${i >= 16 ? "-extended" : ""}`,
      ),
      flip: i >= 8 && i < 16,
    };
  }),
});
pages.push({
  name: "air",
  rows: 2,
  columns: 8,
  cells: [
    "launch-load",
    "launch-release",
    "rise-lift",
    "rise-extend",
    "apex-float",
    "apex-tip",
    "fall-reach",
    "fall-brace",
  ].flatMap((hull, i) =>
    [0, 1].map((row) => ({ ...cell(row, i, hull, "track-0-extended"), flip: row === 1 })),
  ),
});
pages.push({
  name: "impact",
  rows: 2,
  columns: 4,
  cells: [0, 1].flatMap((row) =>
    ["touch", "absorb", "rise", "settle"].map((kind, col) => ({
      ...cell(row, col, `impact-${kind}`, "track-0"),
      flip: row === 1,
    })),
  ),
});
pages.push({
  name: "aim",
  rows: 3,
  columns: 8,
  cells: ["", "-kick", "-recoil"].flatMap((suffix, row) =>
    Array.from({ length: 8 }, (_, col) => cell(row, col, "idle", "track-0", col, suffix)),
  ),
});
const outputs = [];
for (const page of pages)
  for (const [theme, background, color] of [
    ["black", "#000000", "#ffffff"],
    ["white", "#ffffff", "#000000"],
    ["chroma", "#ff00ff", "#000000"],
  ]) {
    const width = page.columns * 100,
      height = page.rows * 108,
      layers = [],
      labels = [];
    for (const c of page.cells) {
      const local = [];
      for (const id of c.frames) {
        const frame = atlas.frames[`${c.variant}/${id}`]?.frame;
        assert(frame);
        let pixels = sharp(image).extract({
          left: frame.x,
          top: frame.y,
          width: frame.w,
          height: frame.h,
        });
        if (c.flip && !id.includes("turret")) pixels = pixels.flop();
        local.push({ input: await pixels.png().toBuffer(), left: 0, top: 0 });
      }
      const composed = await sharp({
        create: { width: 96, height: 96, channels: 4, background: "#00000000" },
      })
        .composite(local)
        .png()
        .toBuffer();
      const left = c.col * 100 + 2,
        top = c.row * 108 + 2;
      layers.push({ input: composed, left, top });
      labels.push(`<text x="${left}" y="${top + 101}">${c.label}</text>`);
    }
    layers.push({
      input: Buffer.from(
        `<svg width="${width}" height="${height}"><g fill="${color}" font-family="monospace" font-size="6">${labels.join("")}</g></svg>`,
      ),
      left: 0,
      top: 0,
    });
    const png = await sharp({ create: { width, height, channels: 4, background } })
      .composite(layers)
      .png()
      .toBuffer();
    for (const scale of [1, 4]) {
      const name = `${page.name}-${theme}-${scale}x.png`;
      await writeFile(
        `${output}/${name}`,
        scale === 1
          ? png
          : await sharp(png)
              .resize(width * scale, height * scale, { kernel: "nearest" })
              .png()
              .toBuffer(),
      );
      outputs.push(name);
    }
  }
await writeFile(
  `${output}/sheets.json`,
  `${JSON.stringify(
    {
      sourceSha256: atlas.meta.edgefall.sourceSha256,
      baseCommit: "ccf416607dafa9ea42793dfc59ddd5c3d005b2da",
      pages,
      outputs,
    },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({
    status: "pass",
    sheets: outputs.length,
    sourceSha256: atlas.meta.edgefall.sourceSha256,
  }),
);

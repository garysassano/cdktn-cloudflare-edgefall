import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const output = "dist/operative-air-sheets",
  atlas = JSON.parse(await readFile("public/assets/art/hero/operative.atlas.json", "utf8")),
  image = await readFile("public/assets/art/hero/operative.png");
await mkdir(output, { recursive: true });
const weapons = ["sidearm", "heavy-machine-gun", "shotgun", "flamethrower"],
  holds = [
    "upper-horizontal",
    "upper-hmg-14",
    "upper-shotgun-horizontal",
    "upper-flame-horizontal",
  ],
  phases = [
    "launch-drive",
    "launch-fold",
    "rise-open",
    "rise-tuck",
    "apex-fold",
    "apex-open",
    "fall-reach",
    "fall-brace",
  ],
  impacts = ["touch", "absorb", "rise", "settle"],
  pages = [];
for (const type of ["air", "impact"]) {
  const cells = [];
  for (const [row, weapon] of weapons.entries())
    for (const [col, name] of (type === "air" ? phases : impacts).entries())
      cells.push({
        row,
        col,
        variant: "p1",
        legs: `legs-${type === "air" ? name : `impact-${name}`}`,
        upper: type === "air" ? holds[row] : `upper-impact-${weapon}-${name}`,
        label: `${row + 1} ${name}`,
      });
  pages.push({ name: type, columns: type === "air" ? 8 : 4, rows: 4, cells });
}
const cells = [];
for (const [row, variant] of ["p1", "p2", "p3", "p4"].entries())
  for (const [index, weapon] of weapons.entries())
    for (const [phase, kind] of ["air", "impact"].entries())
      cells.push({
        row,
        col: index * 2 + phase,
        variant,
        legs: kind === "air" ? "legs-apex-fold" : "legs-impact-absorb",
        upper: kind === "air" ? holds[index] : `upper-impact-${weapon}-absorb`,
        label: `${variant} ${index + 1} ${kind}`,
      });
pages.push({ name: "palettes", columns: 8, rows: 4, cells });
const outputs = [];
for (const page of pages)
  for (const [theme, background, color] of [
    ["black", "#000000", "#ffffff"],
    ["white", "#ffffff", "#000000"],
    ["chroma", "#ff00ff", "#000000"],
  ]) {
    const width = page.columns * 68,
      height = page.rows * 78,
      layers = [],
      labels = [];
    for (const cell of page.cells) {
      const left = cell.col * 68 + 2,
        top = cell.row * 78 + 2;
      for (const id of [cell.legs, cell.upper]) {
        const frame = atlas.frames[`${cell.variant}/${id}`]?.frame;
        assert(frame);
        layers.push({
          input: await sharp(image)
            .extract({ left: frame.x, top: frame.y, width: frame.w, height: frame.h })
            .png()
            .toBuffer(),
          left,
          top,
        });
      }
      labels.push(`<text x="${left}" y="${top + 70}">${cell.label}</text>`);
    }
    layers.push({
      input: Buffer.from(
        `<svg width="${width}" height="${height}"><g fill="${color}" font-family="monospace" font-size="7">${labels.join("")}</g></svg>`,
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
  `${JSON.stringify({ baseCommit: "eadc81042c667178536cc3c6aa07bc0985bbacde", sourceSha256: atlas.meta.edgefall.sourceSha256, weapons, outputs, scope: "Literal indexed atlas layers at native and 4x nearest-neighbour scale. Air phases retain the independently authored weapon hold. Light and heavy impact clips share touch/rise/settle; only the heavy clip includes absorb. Human craft acceptance remains pending." }, null, 2)}\n`,
);
console.log(JSON.stringify({ output, sheets: outputs.length }));

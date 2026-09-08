import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";

const output = "dist/operative-aim-sheets",
  baseCommit = "9360fe710a0566850e2542fde339f7f7291c9ded",
  path = "public/assets/art/hero/operative";
await mkdir(output, { recursive: true });
const before = {
    atlas: JSON.parse(execFileSync("git", ["show", `${baseCommit}:${path}.atlas.json`])),
    png: execFileSync("git", ["show", `${baseCommit}:${path}.png`]),
  },
  after = {
    atlas: JSON.parse(await readFile(`${path}.atlas.json`, "utf8")),
    png: await readFile(`${path}.png`),
  };
const families = ["sidearm", "hmg", "shotgun", "flame"],
  idFor = (family, aim) =>
    family === "sidearm"
      ? `upper-${aim}`
      : family === "hmg"
        ? `upper-hmg-${aim === "up" ? 15 : 16}`
        : `upper-${family}-${aim}`;
const phaseFor = (id, family, phase) =>
  phase === 0
    ? id
    : phase === 1
      ? `${id}-kick`
      : family === "hmg"
        ? id
        : `${id}-${family === "sidearm" ? "settle" : "recover"}`;
const pages = [];
for (const aim of ["up", "down"]) {
  const cells = [];
  for (const [row, family] of families.entries())
    for (const [version, state] of [before, after].entries())
      for (let phase = 0; phase < 3; phase++)
        cells.push({
          state,
          row,
          col: version * 3 + phase,
          variant: "p1",
          legs: aim === "up" ? "legs-idle" : "legs-rise",
          upper: phaseFor(idFor(family, aim), family, phase),
          label: `${family} ${version ? "new" : "old"} ${phase}`,
        });
  pages.push({ name: aim, columns: 6, rows: 4, cells });
}
const cells = [];
for (const [version, state] of [before, after].entries())
  for (const [col, id] of [16, 200, 201, 202, 14, 203, 204, 205, 15].entries())
    for (let phase = 0; phase < 2; phase++)
      cells.push({
        state,
        row: version * 2 + phase,
        col,
        variant: "p1",
        legs: "legs-rise",
        upper: `upper-hmg-${id}${phase ? "-kick" : ""}`,
        label: `${version ? "new" : "old"} ${id}${phase ? " kick" : ""}`,
      });
pages.push({ name: "hmg-sweep", columns: 9, rows: 4, cells });
const variants = [];
for (const [row, variant] of ["p1", "p2", "p3", "p4"].entries())
  for (const [group, family] of families.entries())
    for (const [aimIndex, aim] of ["up", "down"].entries())
      variants.push({
        state: after,
        row,
        col: group * 2 + aimIndex,
        variant,
        legs: aim === "up" ? "legs-idle" : "legs-rise",
        upper: idFor(family, aim),
        label: `${variant} ${family} ${aim}`,
      });
pages.push({ name: "palettes", columns: 8, rows: 4, cells: variants });
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
        const activeId =
          id === "legs-rise" && !cell.state.atlas.frames[`${cell.variant}/${id}`]
            ? "legs-rise-tuck"
            : id;
        const f = cell.state.atlas.frames[`${cell.variant}/${activeId}`]?.frame;
        assert(f);
        layers.push({
          input: await sharp(cell.state.png)
            .extract({ left: f.x, top: f.y, width: f.w, height: f.h })
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
  `${JSON.stringify({ baseCommit, sourceSha256: after.atlas.meta.edgefall.sourceSha256, outputs, scope: "Literal source atlas comparison at native and nearest-neighbour enlarged sizes. HMG has two recoil drawings; its third vertical comparison column repeats the hold and does not imply a third drawing. Human craft approval remains pending." }, null, 2)}\n`,
);
console.log(JSON.stringify({ sheets: outputs.length, output }));

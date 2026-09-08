import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import type { NativeAtlas } from "../../src/shared/animation/native.js";

const output = "dist/breakwater-evidence";
await mkdir(output, { recursive: true });
for (const [directory, id, variant, prefix] of [
  ["hero", "operative", "p1", "upper-(hmg|shotgun|flame)-"],
  ["environment", "breakwater-quay", "base", ""],
  ["bosses", "lock-engine", "base", ""],
  ["effects", "breakwater-fx", "base", ""],
]) {
  const path = `public/assets/art/${directory}/${id}`,
    atlas = JSON.parse(await readFile(`${path}.atlas.json`, "utf8")) as NativeAtlas,
    png = await readFile(`${path}.png`),
    frames = Object.entries(atlas.frames).filter(([name]) =>
      new RegExp(`^${variant}/${prefix}`).test(name),
    ),
    size = frames[0]?.[1].sourceSize.w;
  if (!size) throw new Error("No native review frames");
  const names = frames.map(([name]) => {
    const lines = [""];
    for (const word of (name.split("/")[1]?.replace(/^upper-/, "") ?? name).split("-")) {
      const index = lines.length - 1;
      const line = lines[index] ?? "";
      if (line && line.length + word.length + 1 > Math.floor(size / 4.8)) lines.push(word);
      else lines[index] = line ? `${line}-${word}` : word;
    }
    return lines;
  });
  const cell = size + 8,
    rowHeight = cell + Math.max(...names.map((lines) => lines.length)) * 10,
    columns = 8,
    width = cell * columns,
    height = Math.ceil(frames.length / columns) * rowHeight;
  for (const [theme, background, color] of [
    ["black", "#000000", "#ffffff"],
    ["white", "#ffffff", "#151b24"],
    ["gray", "#808080", "#151b24"],
    ["cyan", "#00ffff", "#151b24"],
    ["chroma", "#ff00ff", "#151b24"],
  ]) {
    const layers: Array<{ input: Buffer; left: number; top: number }> = [],
      labels: string[] = [];
    for (const [index, [, metadata]] of frames.entries()) {
      const left = (index % columns) * cell + 4,
        top = Math.floor(index / columns) * rowHeight + 4;
      layers.push({
        input: await sharp(png)
          .extract({ left: metadata.frame.x, top: metadata.frame.y, width: size, height: size })
          .png()
          .toBuffer(),
        left,
        top,
      });
      for (const [line, name] of (names[index] ?? []).entries())
        labels.push(`<text x="${left}" y="${top + size + 9 + line * 10}">${name}</text>`);
    }
    layers.push({
      input: Buffer.from(
        `<svg width="${width}" height="${height}"><g fill="${color}" font-family="monospace" font-size="8">${labels.join("")}</g></svg>`,
      ),
      left: 0,
      top: 0,
    });
    const sheet = await sharp({
      create: { width, height, channels: 4, background: background ?? "#000000" },
    })
      .composite(layers)
      .png()
      .toBuffer();
    await writeFile(`${output}/${id}-${theme}-1x.png`, sheet);
    await sharp(sheet)
      .resize(width * 4, height * 4, { kernel: "nearest" })
      .png()
      .toFile(`${output}/${id}-${theme}-4x.png`);
  }
  console.log(
    JSON.stringify({
      source: id,
      drawings: frames.length,
      grounds: ["black", "white", "gray", "cyan", "chroma"],
      scales: [1, 4],
    }),
  );
}

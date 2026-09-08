import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { canonical } from "../src/game/core/canonical.ts";
import { breakwaterTerrain } from "../src/game/missions/breakwater.ts";
import {
  advanceBreakwaterVisual,
  initialBreakwaterVisual,
} from "../src/shared/animation/breakwater.ts";
import { effectDrawings } from "../src/shared/animation/combat-effects.ts";
import { operativePresentation } from "../src/shared/animation/operative.ts";
import {
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../src/shared/animation/operative-motion.ts";
import { runBreakwaterProof } from "../test/fixtures/breakwater-proof.ts";

const output = "dist/weapon-comparison",
  hash = (b) => createHash("sha256").update(b).digest("hex"),
  weapons = ["sidearm", "heavy-machine-gun", "shotgun", "grenade", "flamethrower"],
  ages = [0, 2, 4, 6],
  definitions = [1, 2, 10, 5, 11],
  sources = new Map();
await mkdir(output, { recursive: true });
for (const [id, directory] of [
  ["operative", "hero"],
  ["breakwater-fx", "effects"],
]) {
  const stem = `public/assets/art/${directory}/${id}`;
  sources.set(id, {
    atlas: JSON.parse(await readFile(`${stem}.atlas.json`, "utf8")),
    image: await sharp(`${stem}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  });
}
let previous,
  motion,
  visual = initialBreakwaterVisual();
const selected = new Map();
runBreakwaterProof((state) => {
  const actor = state.combat.players[0],
    hero = sources.get("operative").atlas;
  motion = previous
    ? advanceOperativeMotion(previous.combat.players[0], actor, motion, state.combat.tick, hero)
    : initialOperativeMotion(actor, state.combat.tick);
  visual = previous ? advanceBreakwaterVisual(visual, previous, state) : initialBreakwaterVisual();
  const release = state.combat.events.find(
    (e) => e.ownerId === actor.playerId && (e.kind === "shot" || e.kind === "throw"),
  );
  const id = release?.kind === "throw" ? "grenade" : actor.weapon.id;
  if (
    actor.vehicleId === null &&
    actor.facing === 1 &&
    actor.aim === 0 &&
    release &&
    weapons.includes(id) &&
    release.source?.definitionId === definitions[weapons.indexOf(id)] &&
    !selected.has(id)
  ) {
    selected.set(id, { weapon: id, releaseTick: state.combat.tick, release, samples: [] });
  }
  for (const selection of selected.values()) {
    const age = state.combat.tick - selection.releaseTick;
    if (!ages.includes(age)) continue;
    const belongs = (value) =>
      value.ownerId === actor.playerId &&
      value.actionInstanceId === selection.release.actionInstanceId;
    const own = {
      ...state.combat,
      projectiles: state.combat.projectiles.filter(belongs),
      grenades: state.combat.grenades.filter(belongs),
      areas: state.combat.areas.filter(belongs),
    };
    const effects = {
      ...visual.effects,
      items: visual.effects.items.filter((e) => {
        const parts = e.id.split(":");
        return (
          parts[1] === "event" &&
          parts[3] === String(actor.playerId) &&
          parts[4] === String(selection.release.actionInstanceId)
        );
      }),
    };
    selection.samples.push({
      age,
      tick: state.combat.tick,
      worldSha256: hash(canonical(state)),
      hero: operativePresentation(actor, state.combat.tick, hero, motion),
      effects: effectDrawings(
        effects,
        own,
        sources.get("breakwater-fx").atlas,
        breakwaterTerrain(state),
      ),
      state: structuredClone(state),
    });
  }
  previous = state;
}, 1);
assert.deepEqual(
  [...selected.keys()].sort(),
  [...weapons].sort(),
  "The accepted route must supply all five comparison weapons",
);
for (const selection of selected.values()) {
  assert.deepEqual(
    selection.samples.map((s) => s.age),
    ages,
  );
  assert(selection.samples[0].effects.length > 0, selection.weapon);
}
const width = 240,
  height = 104,
  records = weapons.map((weapon) => selected.get(weapon));
// Rasterize source pixels only. The accepted root, effect crop and quarter-turn
// transforms are preserved; no actor, weapon, projectile or effect shape is invented.
const composite = (value) => {
  const pixels = Buffer.alloc(width * height * 4),
    offsetX = 64 - value.hero.x,
    offsetY = 84 - value.hero.y,
    layers = [];
  for (const frame of [
    value.hero.legsFrame,
    value.hero.upperFrame,
    value.hero.fullBodyFrame,
  ].filter(Boolean))
    layers.push({
      texture: "operative",
      frame,
      x: value.hero.x,
      y: value.hero.y,
      flipX: value.hero.flipX,
      flipY: false,
      turn: 0,
      alpha: 1,
      depth: 1,
      root: sources.get("operative").atlas.meta.edgefall.root,
    });
  for (const effect of value.effects)
    layers.push({ ...effect, texture: "breakwater-fx", root: [64, 64] });
  layers.sort((a, b) => a.depth - b.depth);
  for (const layer of layers) {
    const source = sources.get(layer.texture),
      frame = source.atlas.frames[layer.frame]?.frame;
    assert(frame, layer.frame);
    const turn = ((layer.turn % 360) + 360) % 360;
    assert([0, 90, 180, 270].includes(turn));
    for (let y = 0; y < frame.h; y++)
      for (let x = 0; x < frame.w; x++) {
        if (
          layer.crop &&
          (x < layer.crop.x ||
            x >= layer.crop.x + layer.crop.w ||
            y < layer.crop.y ||
            y >= layer.crop.y + layer.crop.h)
        )
          continue;
        const from = ((frame.y + y) * source.image.info.width + frame.x + x) * 4,
          alpha = (source.image.data[from + 3] / 255) * layer.alpha;
        if (!alpha) continue;
        let dx = x + 0.5 - layer.root[0],
          dy = y + 0.5 - layer.root[1];
        if (layer.flipX) dx = -dx;
        if (layer.flipY) dy = -dy;
        if (turn === 90) [dx, dy] = [-dy, dx];
        else if (turn === 180) {
          dx = -dx;
          dy = -dy;
        } else if (turn === 270) [dx, dy] = [dy, -dx];
        const px = Math.floor(layer.x + offsetX + dx),
          py = Math.floor(layer.y + offsetY + dy);
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        const to = (py * width + px) * 4,
          old = pixels[to + 3] / 255,
          combined = alpha + old * (1 - alpha);
        for (let c = 0; c < 3; c++)
          pixels[to + c] = Math.round(
            (source.image.data[from + c] * alpha + pixels[to + c] * old * (1 - alpha)) / combined,
          );
        pixels[to + 3] = Math.round(combined * 255);
      }
  }
  return pixels;
};
const files = [];
for (const [theme, background, color] of [
  ["black", "#000000", "#ffffff"],
  ["white", "#ffffff", "#000000"],
  ["chroma", "#ff00ff", "#000000"],
]) {
  const layers = [],
    labels = [],
    sheetWidth = weapons.length * width,
    rowHeight = height + 18,
    sheetHeight = rowHeight * ages.length;
  for (const [i, weapon] of weapons.entries()) {
    for (const [row, value] of selected.get(weapon).samples.entries()) {
      assert(value.hero && !value.hero.fullBodyFrame);
      layers.push({
        input: await sharp(composite(value), { raw: { width, height, channels: 4 } })
          .png()
          .toBuffer(),
        left: i * width,
        top: row * rowHeight,
      });
      labels.push(
        `<text x="${i * width + 4}" y="${row * rowHeight + height + 12}">${weapon} · +${value.age} · tick ${value.tick}</text>`,
      );
    }
  }
  layers.push({
    input: Buffer.from(
      `<svg width="${sheetWidth}" height="${sheetHeight}"><g font-family="monospace" font-size="9" fill="${color}">${labels.join("")}</g></svg>`,
    ),
    left: 0,
    top: 0,
  });
  const png = await sharp({
    create: { width: sheetWidth, height: sheetHeight, channels: 4, background },
  })
    .composite(layers)
    .png()
    .toBuffer();
  for (const scale of [1, 4]) {
    const name = `weapons-${theme}-${scale}x.png`,
      bytes =
        scale === 1
          ? png
          : await sharp(png)
              .resize(sheetWidth * scale, sheetHeight * scale, { kernel: "nearest" })
              .png()
              .toBuffer();
    await writeFile(`${output}/${name}`, bytes);
    files.push({ name, bytes: bytes.length, sha256: hash(bytes) });
  }
}
const states = Buffer.from(`${JSON.stringify(records, null, 2)}\n`);
await writeFile(`${output}/accepted-states.json`, states);
files.push({ name: "accepted-states.json", bytes: states.length, sha256: hash(states) });
await writeFile(
  `${output}/sheets.json`,
  `${JSON.stringify({ weapons, ages, assetManifestSha256: hash(await readFile("public/assets/manifest.json")), scope: "Literal source compositions at five accepted right-facing horizontal solo weapon releases and two/four/six ticks later. Each column retains the current operative and only effects/projectiles/areas/grenades belonging to that release's action instance. The actor root is aligned across cells; other actions, actors and scenery are omitted. These are source sheets, not screenshots of a live browser or complete animation sequences.", files }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    status: "pass",
    weapons: records.map((r) => ({
      weapon: r.weapon,
      tick: r.releaseTick,
      effects: r.samples.map((s) => s.effects.length),
    })),
    files: files.length,
  }),
);

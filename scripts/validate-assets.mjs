import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = path.join(ROOT, "public");
const MANIFEST_PATH = path.join(PUBLIC, "assets/manifest.json");
const REQUIRED_ANIMATIONS = [
  "idle",
  "run-start",
  "run",
  "run-stop",
  "jump",
  "fall",
  "land",
  "crouch",
  "dodge",
  "melee",
  "fire",
  "reload",
  "hurt",
  "downed",
  "revive",
  "ability",
  "victory",
];

const failures = [];
const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
if (manifest.schemaVersion !== 1) failures.push("manifest schemaVersion must be 1");
if (!manifest.policy?.trim()) failures.push("manifest must state the asset policy");

const records = new Map();
for (const asset of manifest.assets ?? []) {
  if (records.has(asset.path)) failures.push(`duplicate manifest path: ${asset.path}`);
  records.set(asset.path, asset);
}

const actualPaths = (await walk(path.join(PUBLIC, "assets")))
  .map((file) => path.relative(PUBLIC, file).split(path.sep).join("/"))
  .filter((file) => file !== "assets/manifest.json")
  .sort();
const declaredPaths = [...records.keys()].sort();
for (const file of actualPaths.filter((candidate) => !records.has(candidate))) {
  failures.push(`asset lacks a manifest record: ${file}`);
}
for (const file of declaredPaths.filter((candidate) => !actualPaths.includes(candidate))) {
  failures.push(`manifest references a missing asset: ${file}`);
}

for (const [assetPath, asset] of records) {
  const source = manifest.sources?.[asset.source];
  if (!source) failures.push(`${assetPath}: unknown source ${asset.source}`);
  if (!asset.licence || asset.licence !== source?.licence) {
    failures.push(`${assetPath}: licence does not match its source record`);
  }
  const file = path.join(PUBLIC, assetPath);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    continue;
  }
  const fileStat = await stat(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (fileStat.size !== asset.bytes) failures.push(`${assetPath}: byte count changed`);
  if (digest !== asset.sha256) failures.push(`${assetPath}: SHA-256 changed`);
  if (!Number.isSafeInteger(asset.maxBytes) || fileStat.size > asset.maxBytes) {
    failures.push(`${assetPath}: exceeds or lacks a valid size budget`);
  }
  if (assetPath.endsWith(".png")) validatePng(assetPath, bytes, asset.png);
  if (assetPath.endsWith(".ogg") && bytes.subarray(0, 4).toString("ascii") !== "OggS") {
    failures.push(`${assetPath}: not an Ogg stream`);
  }
  if (asset.atlas) await validateAtlas(assetPath, asset.atlas, asset.png);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`asset validation: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${records.size} licensed assets and registered atlases.`);
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(target)));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function validatePng(assetPath, bytes, expected) {
  if (!expected) {
    failures.push(`${assetPath}: PNG metadata is missing`);
    return;
  }
  if (bytes.subarray(1, 4).toString("ascii") !== "PNG") {
    failures.push(`${assetPath}: invalid PNG signature`);
    return;
  }
  const actual = {
    colorType: bytes.readUInt8(25),
    height: bytes.readUInt32BE(20),
    width: bytes.readUInt32BE(16),
  };
  for (const key of ["width", "height", "colorType"]) {
    if (actual[key] !== expected[key]) failures.push(`${assetPath}: PNG ${key} changed`);
  }
}

async function validateAtlas(imagePath, atlasPath, expectedPng) {
  const atlasRecord = records.get(atlasPath);
  if (!atlasRecord) {
    failures.push(`${imagePath}: atlas ${atlasPath} lacks a manifest record`);
    return;
  }
  const atlas = JSON.parse(await readFile(path.join(PUBLIC, atlasPath), "utf8"));
  if (atlas.meta?.image !== path.basename(imagePath))
    failures.push(`${atlasPath}: image name mismatch`);
  if (atlas.meta?.size?.w !== expectedPng.width || atlas.meta?.size?.h !== expectedPng.height) {
    failures.push(`${atlasPath}: image dimensions mismatch`);
  }
  const frames = atlas.frames ?? {};
  for (const [name, value] of Object.entries(frames)) {
    const frame = value.frame;
    const values = [frame?.x, frame?.y, frame?.w, frame?.h];
    if (!values.every((candidate) => Number.isSafeInteger(candidate) && candidate >= 0)) {
      failures.push(`${atlasPath}: invalid frame ${name}`);
      continue;
    }
    if (
      frame.w === 0 ||
      frame.h === 0 ||
      frame.x + frame.w > expectedPng.width ||
      frame.y + frame.h > expectedPng.height
    ) {
      failures.push(`${atlasPath}: frame ${name} lies outside the image`);
    }
  }
  if (atlas.meta?.edgefall?.format === 2) {
    validateNativeAtlas(atlas, atlasPath);
    return;
  }
  const animations = atlas.meta?.edgefall?.animations ?? {};
  for (const tag of REQUIRED_ANIMATIONS) {
    const animationFrames = animations[tag];
    if (!Array.isArray(animationFrames) || animationFrames.length === 0) {
      failures.push(`${atlasPath}: missing animation tag ${tag}`);
      continue;
    }
    for (const frame of animationFrames) {
      if (!frames[frame])
        failures.push(`${atlasPath}: animation ${tag} references missing frame ${frame}`);
    }
  }
  for (const tag of Object.keys(animations)) {
    if (!REQUIRED_ANIMATIONS.includes(tag))
      failures.push(`${atlasPath}: undeclared animation tag ${tag}`);
  }
}

function validateNativeAtlas(atlas, atlasPath) {
  const data = atlas.meta.edgefall,
    frames = atlas.frames ?? {},
    sizes = new Set();
  const fail = (message) => failures.push(`${atlasPath}: ${message}`);
  if (
    data.approval !== "pending" ||
    !/^[a-z][a-z0-9-]+$/.test(data.sourceId) ||
    !/^[a-f0-9]{64}$/.test(data.sourceSha256)
  )
    fail("invalid native provenance");
  if (
    !Array.isArray(data.root) ||
    data.root.length !== 2 ||
    !data.root.every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    fail("invalid native root");
  const variants = data.variants ?? [];
  if (
    !Array.isArray(variants) ||
    variants.length < 1 ||
    variants.length > 4 ||
    new Set(variants).size !== variants.length ||
    !variants.every((id) => /^(base|p[1-4])$/.test(id))
  ) {
    fail("invalid native palettes");
    return;
  }
  const drawings = data.drawings ?? {},
    known = new Set();
  if (!Object.keys(drawings).length) fail("empty native drawings");
  for (const [id, drawing] of Object.entries(drawings)) {
    if (!["legs", "upper", "full-body"].includes(drawing.channel))
      fail(`invalid native channel ${id}`);
    if (
      drawing.contact &&
      (drawing.channel !== "legs" ||
        !["near", "far"].includes(drawing.contact.foot) ||
        !Array.isArray(drawing.contact.point) ||
        drawing.contact.point.length !== 2 ||
        !drawing.contact.point.every(Number.isSafeInteger) ||
        drawing.contact.point[1] !== 0)
    )
      fail(`invalid native contact ${id}`);
    for (const variant of variants) {
      const name = `${variant}/${id}`,
        value = frames[name],
        f = value?.frame;
      known.add(name);
      if (
        !f ||
        value.rotated !== false ||
        value.trimmed !== false ||
        value.sourceSize?.w !== f.w ||
        value.sourceSize?.h !== f.h ||
        value.spriteSourceSize?.x !== 0 ||
        value.spriteSourceSize?.y !== 0 ||
        value.spriteSourceSize?.w !== f.w ||
        value.spriteSourceSize?.h !== f.h
      ) {
        fail(`native frame must retain its canvas ${name}`);
        continue;
      }
      sizes.add(`${f.w}:${f.h}`);
      if (data.root?.[0] > f.w || data.root?.[1] > f.h) fail(`root outside ${name}`);
      for (const [socket, point] of Object.entries(drawing.sockets ?? {}))
        if (
          drawing.channel === "legs" ||
          !["muzzle", "hand", "grip"].includes(socket) ||
          !Array.isArray(point) ||
          point.length !== 2 ||
          !point.every(Number.isSafeInteger) ||
          point[0] + data.root[0] < 0 ||
          point[0] + data.root[0] > f.w ||
          point[1] + data.root[1] < 0 ||
          point[1] + data.root[1] > f.h
        )
          fail(`invalid native socket ${name}/${socket}`);
    }
  }
  if (sizes.size !== 1 || Object.keys(frames).some((name) => !known.has(name)))
    fail("native frame inventory differs from declared drawings/palettes");
  const rectangles = Object.values(frames)
    .map((value) => value.frame)
    .filter(Boolean);
  for (const [index, a] of rectangles.entries()) {
    if (
      a.x < 2 ||
      a.y < 2 ||
      a.x + a.w + 2 > atlas.meta.size.w ||
      a.y + a.h + 2 > atlas.meta.size.h
    )
      fail("native frame lacks edge padding");
    for (const b of rectangles.slice(index + 1))
      if (
        a.x - 2 < b.x + b.w + 2 &&
        a.x + a.w + 2 > b.x - 2 &&
        a.y - 2 < b.y + b.h + 2 &&
        a.y + a.h + 2 > b.y - 2
      )
        fail("native frames or their padding overlap");
  }
  const clips = new Set();
  for (const clip of data.clips ?? []) {
    if (
      !clip.id ||
      clips.has(clip.id) ||
      !["loop", "hold-last"].includes(clip.mode) ||
      !Array.isArray(clip.exposures) ||
      !clip.exposures.length
    ) {
      fail("invalid native clip");
      continue;
    }
    clips.add(clip.id);
    for (const e of clip.exposures)
      if (
        !Number.isSafeInteger(e.ticks) ||
        e.ticks < 1 ||
        e.ticks > 120 ||
        drawings[e.frame]?.channel !== clip.channel
      )
        fail(`invalid exposure in ${clip.id}`);
  }
  if (!clips.size) fail("empty native clips");
}

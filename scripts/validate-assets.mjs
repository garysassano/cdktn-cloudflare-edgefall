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
  console.log(`Validated ${records.size} licensed assets, including the complete animation atlas.`);
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

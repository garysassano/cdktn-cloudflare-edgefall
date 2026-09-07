import type { DestructibleDefinition } from "../combat/destructible.js";
import { pixels } from "../core/numeric.js";
import { footTerrain } from "../labs/foot-fixture.js";

/** One continuous original quay, from the loading apron to the lock engine. Coordinates are native pixels. */
export const BREAKWATER = {
  id: "breakwater-approach",
  title: "Breakwater Approach",
  width: 3072,
  height: 216,
  floor: 200,
  maxTicks: 3600,
  checkpoints: [
    { x: 48, y: 200 },
    { x: 1040, y: 200 },
    { x: 2240, y: 200 },
  ],
  enemies: [
    { id: 20, kind: "rifle", x: 704, y: 200, activateX: 432 },
    { id: 21, kind: "rifle", x: 768, y: 160, activateX: 496, supportId: 102 },
    { id: 22, kind: "shield", x: 960, y: 200, activateX: 688 },
    { id: 23, kind: "rifle", x: 1056, y: 200, activateX: 784 },
    { id: 24, kind: "shield", x: 1248, y: 200, activateX: 976 },
    { id: 25, kind: "rifle", x: 1696, y: 200, activateX: 1424 },
    { id: 26, kind: "rifle", x: 1968, y: 160, activateX: 1696, supportId: 104 },
    { id: 27, kind: "rifle", x: 2112, y: 200, activateX: 1840 },
  ],
  pickups: [
    { id: 300, weapon: "heavy-machine-gun", ammo: 150, x: 576, y: 200 },
    { id: 301, weapon: "shotgun", ammo: 24, x: 816, y: 200 },
    { id: 302, weapon: "flamethrower", ammo: 30, x: 1136, y: 200 },
    { id: 303, weapon: "sidearm", ammo: 0, x: 1392, y: 200 },
    { id: 304, weapon: "heavy-machine-gun", ammo: 150, x: 2712, y: 200 },
  ],
  tank: { id: 60, x: 1520, y: 200 },
  boss: {
    id: 500,
    x: 2848,
    y: 200,
    activateX: 2496,
    baseHealth: 36,
    healthPerPlayer: 24,
    windup: 45,
    burst: 60,
    recovery: 75,
    shotOffsets: [0, 15, 30, 45],
    muzzle: { x: -58, y: -23 },
    weakPoint: { x: -54, y: -34, w: 24, h: 20 },
  },
} as const;

export const BREAKWATER_TERRAIN = [
  footTerrain(100, 0, 200, BREAKWATER.width, 32),
  footTerrain(101, 208, 160, 128, 8, "one-way"),
  footTerrain(102, 720, 160, 128, 8, "one-way"),
  footTerrain(103, 1744, 168, 96, 32),
  footTerrain(104, 1920, 160, 128, 8, "one-way"),
  footTerrain(105, 2544, 160, 96, 8, "one-way"),
  footTerrain(106, BREAKWATER.boss.x - 40, 112, 80, 88),
  footTerrain(107, -16, 0, 16, 232),
  footTerrain(108, BREAKWATER.width, 0, 16, 232),
];
export const BREAKWATER_PROPS: readonly DestructibleDefinition[] = [
  {
    id: 200,
    definitionId: 2,
    rect: { x: pixels(1320), y: pixels(168), w: pixels(32), h: pixels(32) },
    health: 8,
  },
];

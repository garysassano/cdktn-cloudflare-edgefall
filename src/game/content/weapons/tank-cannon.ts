import { pixels } from "../../core/numeric.js";
import type { TankCannonProfile } from "../../vehicles/tank.js";
import type { AttackDefinition, ShapeDefinition } from "../schema.js";

/** The heavy shell flies straight; contact supplies one blast budget and no extra direct hit. */
export const CANNON_SHAPE: ShapeDefinition = {
  id: 22,
  rect: { x: pixels(-4), y: pixels(-4), w: pixels(8), h: pixels(8) },
};
export const CANNON_BLAST_SHAPE: ShapeDefinition = {
  id: 23,
  rect: { x: pixels(-56), y: pixels(-56), w: pixels(112), h: pixels(112) },
};
export const CANNON_ATTACK: AttackDefinition = {
  id: 19,
  kind: "explosion",
  shapeId: CANNON_BLAST_SHAPE.id,
  damage: 6,
  lifetimeTicks: 90,
  speed: pixels(12),
  maxTargets: 16,
  repeatDamageTicks: 0,
  material: "explosive",
};
export const CANNON_PROFILE: TankCannonProfile = {
  attackId: CANNON_ATTACK.id,
  bodyShapeId: CANNON_SHAPE.id,
  stock: 10,
  cadenceTicks: 45,
  blastRadius: pixels(56),
  fireTimelineIds: Array.from({ length: 8 }, (_, heading) => 240 + heading),
  releaseTick: 3,
  // The muzzle stays extended through release, then the barrel recoils and returns.
  recoil: [0, 0, 0, 0, 3, 4, 3, 2, 1, 0, 0, 0].map(pixels),
  hardpoint: { x: 0, y: pixels(-14) },
  headings: [
    [30, -14, 12, 0],
    [22, -36, 8, -8],
    [0, -44, 0, -12],
    [-22, -36, -8, -8],
    [-30, -14, -12, 0],
    [-22, 8, -8, 8],
    [0, 16, 0, 12],
    [22, 8, 8, 8],
  ].map(([x = 0, y = 0, vx = 0, vy = 0]) => ({
    muzzle: { x: pixels(x), y: pixels(y) },
    velocity: { x: pixels(vx), y: pixels(vy) },
  })),
};

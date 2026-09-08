import { type BeamProfile, validateBeamProfile } from "../../combat/beam.js";
import { pixels } from "../../core/numeric.js";
import type { AttackDefinition, ShapeDefinition, WeaponDefinition } from "../schema.js";

export const LASER_WEAPON: WeaponDefinition = {
  id: "laser",
  attackId: 18,
  timelineId: 230,
  cadenceTicks: 6,
  ammoPerAction: 1,
  pickupAmmo: 120,
  aimPolicy: "cardinal",
  visualFamily: "fixture-laser",
  audioFamily: "fixture-laser",
};
export const LASER_PROFILE: BeamProfile = { range: pixels(512), width: pixels(4), pulseTicks: 6 };
/** A long beam uses contiguous bounded segments; this is its maximum segment shape. */
export const LASER_SHAPE: ShapeDefinition = {
  id: 21,
  rect: { x: 0, y: -pixels(2), w: pixels(256), h: pixels(4) },
};
export const LASER_ATTACK: AttackDefinition = {
  id: LASER_WEAPON.attackId,
  kind: "beam",
  shapeId: LASER_SHAPE.id,
  damage: 2,
  lifetimeTicks: 6,
  speed: 0,
  maxTargets: 8,
  repeatDamageTicks: 6,
  material: "energy",
};
validateBeamProfile(LASER_PROFILE);

import { type RocketProfile, validateRocketProfile } from "../../combat/rocket.js";
import { pixels } from "../../core/numeric.js";
import type { AttackDefinition, ShapeDefinition, WeaponDefinition } from "../schema.js";

/** W07 engineering launcher values; final media and balance remain separate acceptance gates. */
export const ROCKET_WEAPON: WeaponDefinition = {
  id: "rocket-launcher",
  attackId: 17,
  timelineId: 220,
  cadenceTicks: 24,
  ammoPerAction: 1,
  pickupAmmo: 20,
  aimPolicy: "cardinal",
  visualFamily: "fixture-rocket",
  audioFamily: "fixture-rocket",
};
export const ROCKET_SHAPE: ShapeDefinition = {
  id: 19,
  rect: { x: -pixels(2), y: -pixels(2), w: pixels(4), h: pixels(4) },
};
export const ROCKET_BLAST_SHAPE: ShapeDefinition = {
  id: 20,
  rect: { x: -pixels(48), y: -pixels(48), w: pixels(96), h: pixels(96) },
};
export const ROCKET_PROFILE: RocketProfile = {
  bodyShapeId: ROCKET_SHAPE.id,
  launchSpeed: pixels(2),
  acceleration: 128,
  maximumSpeed: pixels(6),
  lifetimeTicks: 90,
  blastRadius: pixels(48),
  acquireRange: pixels(240),
  retainRange: pixels(256),
  acquireSteps: 2,
  retainSteps: 4,
  launchLeashSteps: 4,
  acquireIntervalTicks: 6,
  turnIntervalTicks: 3,
};
export const ROCKET_ATTACK: AttackDefinition = {
  id: ROCKET_WEAPON.attackId,
  kind: "explosion",
  shapeId: ROCKET_BLAST_SHAPE.id,
  damage: 4,
  lifetimeTicks: ROCKET_PROFILE.lifetimeTicks,
  speed: ROCKET_PROFILE.launchSpeed,
  maxTargets: 16,
  repeatDamageTicks: 0,
  material: "explosive",
};
validateRocketProfile(ROCKET_PROFILE);

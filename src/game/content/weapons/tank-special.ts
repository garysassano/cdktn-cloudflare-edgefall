import { pixels } from "../../core/numeric.js";
import type { TankSpecialProfile } from "../../vehicles/tank-special.js";
import type { AttackDefinition, ShapeDefinition } from "../schema.js";

export const TANK_SPECIAL_SHAPE: ShapeDefinition = {
  id: 24,
  rect: { x: pixels(-72), y: pixels(-72), w: pixels(144), h: pixels(144) },
};
export const TANK_SPECIAL_ATTACK: AttackDefinition = {
  id: 20,
  kind: "explosion",
  shapeId: TANK_SPECIAL_SHAPE.id,
  damage: 8,
  lifetimeTicks: 60,
  speed: pixels(6),
  maxTargets: 16,
  repeatDamageTicks: 0,
  material: "explosive",
};
export const TANK_SPECIAL_PROFILE: TankSpecialProfile = {
  armTicks: 30,
  attackId: TANK_SPECIAL_ATTACK.id,
  chargeTicks: TANK_SPECIAL_ATTACK.lifetimeTicks,
  speed: TANK_SPECIAL_ATTACK.speed,
  blastRadius: pixels(72),
};

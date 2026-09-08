import { divide } from "../../game/core/numeric.js";
import { worldSocket } from "../../game/physics/body.js";
import type { VehicleState } from "../../game/state.js";
import type { TankCannonProfile } from "../../game/vehicles/tank.js";

/** Barrel recoil follows the committed secondary cursor; its locked release pose owns the aim. */
export function tankCannonPose(tank: VehicleState, tick: number, profile: TankCannonProfile) {
  const action = tank.secondary.action,
    heading =
      action.kind === "fire" ? profile.fireTimelineIds.indexOf(action.definitionId) : tank.heading,
    exposure = profile.headings[heading];
  if (!exposure) throw new Error("Missing cannon presentation heading");
  const age = tick - action.stateStartTick,
    recoil = action.kind === "fire" ? (profile.recoil[age] ?? 0) : 0,
    root = worldSocket(tank.body, profile.hardpoint, 1),
    muzzle = worldSocket(tank.body, exposure.muzzle, 1),
    x = muzzle.x - root.x,
    y = muzzle.y - root.y,
    length = Math.max(Math.abs(x), Math.abs(y));
  if (length === 0) throw new Error("Empty cannon barrel");
  return {
    heading,
    recoil,
    root,
    muzzle: {
      x: muzzle.x - divide(recoil * x, length).quotient,
      y: muzzle.y - divide(recoil * y, length).quotient,
    },
  };
}

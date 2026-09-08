import type { VehicleState } from "../../game/state.js";

export type TankAirPhase = "launch" | "rise" | "apex" | "fall";
export const TANK_LAUNCH_TICKS = 2;
export const TANK_APEX_SPEED = 96;
export const TANK_TREAD_DISTANCE = 16 * 256;
export const TANK_LAND_TICKS = { light: 3, heavy: 5 } as const;
export interface TankMotion {
  id: number;
  strideQ: number;
  airPhase: TankAirPhase | null;
  airPhaseStartTick: number;
  landTick: number | null;
  impact: "light" | "heavy" | null;
}
const terminal = (tank: VehicleState) =>
  tank.lifecycle === "wreck" || tank.lifecycle === "destroying";
const phase = (tank: VehicleState): TankAirPhase =>
  Math.abs(tank.body.vy) <= TANK_APEX_SPEED ? "apex" : tank.body.vy < 0 ? "rise" : "fall";

export function initialTankMotion(tank: VehicleState, tick: number): TankMotion {
  return {
    id: tank.body.id,
    strideQ: 0,
    airPhase:
      tank.body.grounded || terminal(tank) ? null : tank.body.vy >= 0 ? "fall" : phase(tank),
    airPhaseStartTick: tick,
    landTick: null,
    impact: null,
  };
}

/** Cosmetic suspension follows accepted bodies; seat ownership does not reset the chassis. */
export function advanceTankMotion(
  before: VehicleState | undefined,
  tank: VehicleState,
  current: TankMotion | undefined,
  tick: number,
): TankMotion {
  if (!before || !current || before.body.id !== tank.body.id || current.id !== tank.body.id)
    return initialTankMotion(tank, tick);
  if (terminal(tank)) return initialTankMotion(tank, tick);
  let airPhase: TankAirPhase | null = null;
  if (!tank.body.grounded) {
    const launched =
      tank.body.vy < -TANK_APEX_SPEED && (before.body.grounded || before.body.vy >= 0);
    airPhase =
      launched ||
      (current.airPhase === "launch" &&
        tick - current.airPhaseStartTick < TANK_LAUNCH_TICKS &&
        tank.body.vy < -TANK_APEX_SPEED)
        ? "launch"
        : before.body.vy < -TANK_APEX_SPEED && tank.body.vy >= 0
          ? "fall"
          : phase(tank);
    if ((current.airPhase === "fall" || current.airPhase === null) && tank.body.vy >= 0)
      airPhase = "fall";
  }
  const landed = !before.body.grounded && tank.body.grounded;
  let landTick = landed ? tick : current.landTick,
    impact = landed ? (before.body.vy >= 4 * 256 ? "heavy" : "light") : current.impact;
  if (
    !tank.body.grounded ||
    (landTick !== null && impact && tick - landTick >= TANK_LAND_TICKS[impact])
  ) {
    landTick = null;
    impact = null;
  }
  return {
    id: tank.body.id,
    // Solver-owned velocity excludes platform carry and is clipped by walls.
    // Airborne tracks hold their last phase; stopping never snaps them to frame zero.
    strideQ:
      (current.strideQ + (tank.body.grounded ? Math.abs(tank.body.vx) : 0)) % TANK_TREAD_DISTANCE,
    airPhase,
    airPhaseStartTick: airPhase === current.airPhase ? current.airPhaseStartTick : tick,
    landTick,
    impact,
  };
}

import { TANK_PROFILE } from "../../game/labs/combat-content.js";
import type { VehicleState } from "../../game/state.js";

export interface TankFeedback {
  integrity: "intact" | "damaged" | "critical" | "charging" | "wreck";
  damageAgeTicks: number | null;
  hitFlash: boolean;
  hullTint: number;
  critical: boolean;
  warningBright: boolean;
}

/** Current accepted armor and its protection timer also reconstruct feedback after recovery. */
export function tankFeedback(tank: VehicleState, tick: number): TankFeedback {
  const integrity =
    tank.lifecycle === "wreck"
      ? "wreck"
      : tank.special.phase === "charging"
        ? "charging"
        : tank.armor === 1
          ? "critical"
          : tank.armor < TANK_PROFILE.definition.armor
            ? "damaged"
            : "intact";
  const damageAgeTicks =
    tank.armor > 0 && tank.armor < TANK_PROFILE.definition.armor && tank.invulnerableTicks > 0
      ? TANK_PROFILE.damageProtectionTicks - tank.invulnerableTicks
      : null;
  return {
    integrity,
    damageAgeTicks,
    hitFlash: damageAgeTicks !== null && damageAgeTicks < 6 && damageAgeTicks % 3 < 2,
    // Engineering modulation of the existing hull; final authored damage drawings remain separate.
    hullTint: integrity === "critical" ? 0xffb3a2 : integrity === "damaged" ? 0xd8cbb5 : 0xffffff,
    critical: integrity === "critical",
    warningBright: integrity === "critical" && tick % 60 < 30,
  };
}

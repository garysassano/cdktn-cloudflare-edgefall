import type { WeaponPickupDefinition } from "../combat/pickups.js";
import { integer, pixels } from "../core/numeric.js";
import type { WeaponId } from "../state.js";
import type { CombatScenario } from "./combat.js";

const SUPPLIES: ReadonlyArray<{ weaponId: WeaponId; ammo: number; x: number }> = [
  { weaponId: "heavy-machine-gun", ammo: 150, x: 90 },
  { weaponId: "shotgun", ammo: 24, x: 145 },
  { weaponId: "flamethrower", ammo: 30, x: 200 },
  { weaponId: "rocket-launcher", ammo: 20, x: 255 },
  { weaponId: "laser", ammo: 120, x: 310 },
];

/** Individual shared supplies. Static content IDs are scoped by the run epoch. */
export function combatPickupDefinitions(
  scenario: CombatScenario,
  players: number,
): WeaponPickupDefinition[] {
  integer(players, 1, 4, "combat supply party size");
  if (scenario !== "pickups" && scenario !== "support") return [];
  const definition = (
    id: number,
    sourceId: number,
    weaponId: WeaponId,
    ammo: number,
    x: number,
    y: number,
    supportId: number,
    expiresTick = 3600,
  ): WeaponPickupDefinition => ({
    id,
    claimId: id,
    sourceId,
    kind: "weapon",
    weaponId,
    ammo,
    ammoLimit: ammo,
    activationTick: 1,
    expiresTick,
    supportId,
    rect: { x: pixels(x - 12), y: pixels(y - 23), w: pixels(24), h: pixels(23) },
  });
  if (scenario === "support") return [definition(620, 505, "shotgun", 24, 250, 160, 104)];
  return [
    ...SUPPLIES.flatMap((supply, station) =>
      Array.from({ length: players }, (_, slot) =>
        definition(
          600 + station * 4 + slot,
          500 + station,
          supply.weaponId,
          supply.ammo,
          supply.x,
          200,
          100,
        ),
      ),
    ),
    // The rear item expires while the group travels forward, independently of any claim.
    definition(621, 506, "shotgun", 24, 12, 200, 100, 24),
  ];
}

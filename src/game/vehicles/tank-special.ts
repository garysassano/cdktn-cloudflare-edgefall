import { type HurtTarget, projectileImpact } from "../combat/projectile.js";
import { explosionHits } from "../combat/volume.js";
import type { MaterialSurface } from "../content/materials.js";
import type { AttackDefinition, ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer } from "../core/numeric.js";
import type { ControlledActor, VehicleSpecialState, VehicleState } from "../state.js";

export interface TankSpecialProfile {
  armTicks: number;
  attackId: number;
  chargeTicks: number;
  speed: number;
  blastRadius: number;
}
export const idleTankSpecial = (): VehicleSpecialState => ({
  phase: "ready",
  actionInstanceId: 0,
  ownerId: null,
  ownerControlEpoch: null,
  startTick: 0,
  commitTick: null,
  endTick: null,
  direction: 1,
});

/** Keep the last attempt's identity for accepted-state feedback and checkpoint validation. */
export function cancelTankSpecial(tank: VehicleState, tick: number) {
  if (tank.special.phase !== "arming") return;
  tank.special.phase = "canceled";
  tank.special.endTick = tick;
}

export function finishTankCharge(tank: VehicleState, tick: number) {
  if (tank.special.phase !== "charging") throw new Error("Inactive tank charge");
  tank.special.phase = "spent";
  tank.special.endTick = tick;
  tank.lifecycle = "wreck";
  tank.body.vx = tank.body.vy = tank.invulnerableTicks = 0;
}

/** The grounded solver moves the hull; its swept volume supplies one terminal blast budget. */
export function stepTankCharge(
  previous: VehicleState,
  tank: VehicleState,
  tick: number,
  definition: AttackDefinition,
  shape: ShapeDefinition,
  profile: TankSpecialProfile,
  terrain: readonly MaterialSurface[],
  hurtboxes: readonly HurtTarget[],
) {
  const special = tank.special;
  if (special.phase !== "charging" || special.commitTick === tick) return null;
  if (special.commitTick === null || special.ownerId === null)
    throw new Error("Missing charge owner");
  integer(tick - special.commitTick, 1, profile.chargeTicks, "tank charge age");
  const attack = {
    id: tank.body.id,
    ownerId: special.ownerId,
    team: 1,
    actionInstanceId: special.actionInstanceId,
    definitionId: definition.id,
    position: { x: previous.body.x, y: previous.body.y },
    velocity: { x: tank.body.x - previous.body.x, y: tank.body.y - previous.body.y },
    spawnTick: special.commitTick,
  };
  const contact = projectileImpact(attack, shape, 0, terrain, hurtboxes);
  const blocked = tank.body.contacts.some(
    (contact) => contact.normalX !== 0 || contact.normalY > 0,
  );
  if (!contact && !blocked && tick - special.commitTick < profile.chargeTicks) return null;
  const anchor = contact?.position ?? { x: tank.body.x, y: tank.body.y };
  // Blast visibility starts inside the hull, above its floor contact; feet-level rays can graze under walls.
  const point = {
    x: anchor.x + shape.rect.x + Math.trunc(shape.rect.w / 2),
    y: anchor.y + shape.rect.y + Math.trunc(shape.rect.h / 2),
  };
  const time = contact?.time ?? { numerator: 1, denominator: 1 };
  const impacts = explosionHits(
    attack,
    definition,
    point,
    profile.blastRadius,
    terrain,
    hurtboxes,
    {
      time,
      primaryTarget: contact?.entityId ?? null,
    },
  );
  if (contact) {
    tank.body.x = anchor.x;
    tank.body.y = anchor.y;
    tank.body.supportId = null;
    tank.body.grounded = false;
    tank.body.contacts = [];
  }
  finishTankCharge(tank, tick);
  return { position: point, impacts };
}

/** Public state is sufficient to reject impossible phases before prediction or rendering. */
export function validateTankSpecial(
  tank: VehicleState,
  tick: number,
  players: readonly ControlledActor[],
  profile: TankSpecialProfile,
) {
  const special = tank.special;
  const check = (ok: unknown) => {
    if (!ok) throw new Error("Tank special state");
  };
  check(["ready", "arming", "canceled", "charging", "spent"].includes(special.phase));
  check(special.direction === -1 || special.direction === 1);
  integer(special.startTick, 0, tick, "tank special start");
  integer(special.actionInstanceId, 0, COUNTER_LIMIT - 1, "tank special action");
  if (special.ownerId !== null) integer(special.ownerId, 1, COUNTER_LIMIT - 1, "special owner");
  if (special.ownerControlEpoch !== null)
    integer(special.ownerControlEpoch, 1, COUNTER_LIMIT - 1, "special owner epoch");
  if (special.commitTick !== null) integer(special.commitTick, 1, tick, "special commit tick");
  if (special.endTick !== null) integer(special.endTick, 1, tick, "special end tick");
  if (special.phase === "ready") {
    check(
      special.actionInstanceId === 0 &&
        special.ownerId === null &&
        special.ownerControlEpoch === null &&
        special.startTick === 0 &&
        special.commitTick === null &&
        special.endTick === null &&
        special.direction === 1,
    );
  } else {
    const owner = players.find((player) => player.playerId === special.ownerId);
    check(
      owner &&
        special.actionInstanceId > 0 &&
        special.startTick > 0 &&
        special.ownerControlEpoch !== null &&
        special.ownerControlEpoch > 0 &&
        special.ownerControlEpoch <= owner.controlEpoch,
    );
    if (special.phase === "arming") {
      check(
        tank.lifecycle === "occupied" &&
          tank.occupantId === special.ownerId &&
          tank.ownerControlEpoch === special.ownerControlEpoch &&
          owner?.vehicleSpecialTicks === tick - special.startTick + 1 &&
          tick - special.startTick < profile.armTicks - 1 &&
          special.commitTick === null &&
          special.endTick === null,
      );
    } else if (special.phase === "canceled") {
      check(
        special.commitTick === null &&
          special.endTick !== null &&
          special.endTick >= special.startTick &&
          special.endTick <= tick &&
          special.endTick < special.startTick + profile.armTicks,
      );
    } else {
      check(
        tank.armor === 0 &&
          tank.occupantId === null &&
          tank.reservedBy === null &&
          special.commitTick === special.startTick + profile.armTicks - 1 &&
          special.commitTick <= tick,
      );
      if (special.phase === "charging")
        check(
          tank.lifecycle === "destroying" &&
            special.endTick === null &&
            tick - (special.commitTick ?? 0) < profile.chargeTicks,
        );
      else
        check(
          tank.lifecycle === "wreck" &&
            special.endTick !== null &&
            special.endTick <= tick &&
            special.endTick > (special.commitTick ?? tick) &&
            special.endTick <= (special.commitTick ?? 0) + profile.chargeTicks,
        );
    }
  }
  check((tank.lifecycle === "destroying") === (special.phase === "charging"));
}

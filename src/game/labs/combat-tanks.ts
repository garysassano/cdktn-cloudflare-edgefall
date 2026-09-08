import { type LifeNotice, damagePlayer } from "../campaign/life.js";
import type { ActionOutcome } from "../combat/foot-actions.js";
import { type HurtTarget, muzzleBlocked } from "../combat/projectile.js";
import { nextCounter } from "../core/numeric.js";
import { Held } from "../input/types.js";
import { worldRect, worldSocket } from "../physics/body.js";
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import type { SweepTarget } from "../physics/sweep.js";
import {
  type TankState,
  attachTankDriver,
  idleTankAction,
  moveTank,
  releaseTank,
  requestTankExit,
  reserveTank,
  stepTankCannon,
  stepTankGun,
  stepTankTransfer,
  tankExitBody,
  tankOwner,
} from "../vehicles/tank.js";
import { cancelTankSpecial, finishTankCharge } from "../vehicles/tank-special.js";
import type { CombatCommand, CombatLab, CombatNotice } from "./combat.js";
import { COMBAT_ATTACKS, COMBAT_CATALOG, COMBAT_SHAPES, TANK_PROFILE } from "./combat-content.js";
import { FOOT_DEFINITION } from "./foot-fixture.js";

export type SeatReason = "board" | "exit" | "destroyed" | "disconnect" | "special";
export type SeatChanges = Map<number, SeatReason>;
export interface CombatTankConnections {
  connectedPlayerIds: readonly number[];
  releasePlayerIds: readonly number[];
}
const neutral = { held: 0, jumpPressed: false, firePressed: false, grenadePressed: false };
function exitShape() {
  const shape = FOOT_DEFINITION && COMBAT_SHAPES.get(FOOT_DEFINITION.standingShapeId);
  if (!shape) throw new Error("Missing tank ejection shape");
  return shape;
}

/** Damage, crush, fall and connection loss use the same bilateral ownership settlement. */
export function releaseCombatTank(
  world: CombatLab,
  tank: TankState,
  reason: SeatReason,
  changes: SeatChanges,
  lifeNotices: LifeNotice[],
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  const id = tankOwner(tank);
  if (reason === "destroyed") tank.armor = 0;
  if (id === null) {
    if (reason === "destroyed") tank.controlEpoch = nextCounter(tank.controlEpoch);
    tank.lifecycle = tank.armor === 0 ? "wreck" : "available";
    tank.action = idleTankAction(frame.tick);
    tank.secondary.action = idleTankAction(frame.tick);
    if (tank.armor === 0) tank.body.vx = tank.body.vy = tank.invulnerableTicks = 0;
    return;
  }
  const slot = world.players.findIndex((player) => player.playerId === id);
  const actor = world.players[slot];
  if (!actor) throw new Error("Missing tank release owner");
  const safe = releaseTank(tank, actor, frame.tick, TANK_PROFILE, exitShape(), index, frame);
  if (tank.armor === 0) tank.body.vx = tank.body.vy = tank.invulnerableTicks = 0;
  changes.set(id, reason);
  if (!safe || tank.body.y > TANK_PROFILE.fallBoundary) {
    const death = damagePlayer(actor, frame.tick, 1, "classic", "fall");
    world.players[slot] = death.actor;
    if (death.notice) lifeNotices.push(death.notice);
  }
}

export function advanceCombatTanks(
  world: CombatLab,
  commands: readonly CombatCommand[],
  connections: CombatTankConnections,
  changes: SeatChanges,
  lifeNotices: LifeNotice[],
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  const outcomes = new Map<
    number,
    { jumpAccepted: boolean; interact: ActionOutcome; special: ActionOutcome }
  >();
  for (const player of world.players) {
    if (
      player.vehicleId !== null &&
      !world.tanks.some(
        (tank) => tank.body.id === player.vehicleId && tankOwner(tank) === player.playerId,
      )
    )
      throw new Error("Combat vehicle owner mismatch");
    outcomes.set(player.playerId, {
      jumpAccepted: false,
      interact: "none",
      special: commands[player.slot]?.specialPressed ? "unavailable" : "none",
    });
  }
  for (const [tankIndex, before] of world.tanks.entries()) {
    if (before.lifecycle === "wreck") continue;
    const id = tankOwner(before),
      actor = world.players.find((player) => player.playerId === id),
      slot = actor?.slot;
    const connected = id !== null && connections.connectedPlayerIds.includes(id);
    const forced = id !== null && connections.releasePlayerIds.includes(id);
    const intent =
      connected && !forced && slot !== undefined ? (commands[slot] ?? neutral) : neutral;
    const moved = moveTank(before, intent, TANK_PROFILE, COMBAT_SHAPES, index, frame);
    const tank = moved.tank;
    world.tanks[tankIndex] = tank;
    if (actor) attachTankDriver(tank, actor, TANK_PROFILE);
    if (moved.fault && moved.fault.reason !== "crushed")
      throw new Error(`Combat tank: ${moved.fault.reason}`);
    if (moved.fault || tank.body.y > TANK_PROFILE.fallBoundary) {
      if (tank.special.phase === "charging") {
        // A crush or fall consumes the released hull without inventing an off-stage damage volume.
        finishTankCharge(tank, frame.tick);
        continue;
      }
      releaseCombatTank(world, tank, "destroyed", changes, lifeNotices, index, frame);
      continue;
    }
    if (id === null || !actor) continue;
    tank.disconnectedTicks = connected ? 0 : tank.disconnectedTicks + 1;
    if (forced || tank.disconnectedTicks >= TANK_PROFILE.disconnectGraceTicks) {
      releaseCombatTank(world, tank, "disconnect", changes, lifeNotices, index, frame);
      continue;
    }
    const outcome = outcomes.get(id);
    if (outcome) outcome.jumpAccepted = moved.jumpAccepted;
    const transfer = stepTankTransfer(
      tank,
      actor,
      frame.tick,
      TANK_PROFILE,
      COMBAT_CATALOG,
      exitShape(),
      index,
      frame,
    );
    if (transfer) changes.set(id, transfer === "board" ? "board" : "exit");
  }
  // All commands here are consumed at this authoritative tick. Equal-tick claims resolve by slot.
  for (const actor of [...world.players].sort((a, b) => a.slot - b.slot)) {
    const command = commands[actor.slot],
      outcome = outcomes.get(actor.playerId);
    if (!command?.interactPressed || !outcome) continue;
    outcome.interact = "unavailable";
    if (changes.has(actor.playerId) || !connections.connectedPlayerIds.includes(actor.playerId))
      continue;
    const owned = world.tanks.find((tank) => tankOwner(tank) === actor.playerId);
    if (owned) {
      if (
        requestTankExit(
          owned,
          actor,
          frame.tick,
          world.nextActionId,
          TANK_PROFILE,
          exitShape(),
          index,
          frame,
        )
      ) {
        changes.set(actor.playerId, "exit");
        world.nextActionId = nextCounter(world.nextActionId);
        outcome.interact = "applied";
      }
    } else {
      const candidates = [...world.tanks].sort(
        (a, b) =>
          Math.abs(a.body.x - actor.body.x) +
            Math.abs(a.body.y - actor.body.y) -
            Math.abs(b.body.x - actor.body.x) -
            Math.abs(b.body.y - actor.body.y) || a.body.id - b.body.id,
      );
      for (const tank of candidates) {
        if (
          !reserveTank(
            tank,
            actor,
            frame.tick,
            world.nextActionId,
            TANK_PROFILE,
            COMBAT_SHAPES,
            index,
            frame,
          )
        )
          continue;
        changes.set(actor.playerId, "board");
        world.nextActionId = nextCounter(world.nextActionId);
        outcome.interact = "applied";
        break;
      }
    }
  }
  for (const tank of world.tanks) {
    const ownerId = tankOwner(tank),
      actor = world.players.find((player) => player.playerId === ownerId);
    const command = actor && commands[actor.slot],
      outcome = actor && outcomes.get(actor.playerId);
    const permitted =
      actor?.life === "alive" &&
      tank.lifecycle === "occupied" &&
      !changes.has(actor.playerId) &&
      connections.connectedPlayerIds.includes(actor.playerId) &&
      !connections.releasePlayerIds.includes(actor.playerId) &&
      Boolean((command?.held ?? 0) & Held.VehicleSpecial);
    if (!permitted) {
      cancelTankSpecial(tank, frame.tick);
      if (actor) actor.vehicleSpecialTicks = 0;
      continue;
    }
    if (!actor || !command || !outcome) throw new Error("Missing special owner");
    if (command.specialPressed) {
      if (tank.special.phase === "arming") outcome.special = "cooldown";
      else {
        tank.special = {
          phase: "arming",
          actionInstanceId: world.nextActionId,
          ownerId: actor.playerId,
          ownerControlEpoch: actor.controlEpoch,
          startTick: frame.tick,
          commitTick: null,
          endTick: null,
          direction: tank.facing,
        };
        world.nextActionId = nextCounter(world.nextActionId);
        outcome.special = "applied";
      }
    }
    actor.vehicleSpecialTicks =
      tank.special.phase === "arming" ? frame.tick - tank.special.startTick + 1 : 0;
  }
  return outcomes;
}

/** Resolve damage first: a hit on the final hold tick cancels before the irreversible release. */
export function commitCombatSpecials(
  world: CombatLab,
  changes: SeatChanges,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  for (const tank of world.tanks) {
    const special = tank.special;
    if (
      special.phase !== "arming" ||
      frame.tick - special.startTick + 1 < TANK_PROFILE.special.armTicks
    )
      continue;
    const actor = world.players.find((player) => player.playerId === special.ownerId);
    if (
      actor?.life !== "alive" ||
      tank.lifecycle !== "occupied" ||
      !tankExitBody(tank, actor, TANK_PROFILE, exitShape(), index, frame)
    ) {
      cancelTankSpecial(tank, frame.tick);
      if (actor) actor.vehicleSpecialTicks = 0;
      continue;
    }
    const direction = tank.facing;
    if (!releaseTank(tank, actor, frame.tick, TANK_PROFILE, exitShape(), index, frame))
      throw new Error("Special ejection changed within one boundary");
    tank.special = {
      ...special,
      phase: "charging",
      commitTick: frame.tick,
      endTick: null,
      direction,
    };
    // This hull is now a released attack, consumed permanently and unavailable for boarding.
    tank.armor = tank.invulnerableTicks = 0;
    tank.lifecycle = "destroying";
    changes.set(actor.playerId, "special");
  }
}

export function fireCombatTanks(
  world: CombatLab,
  commands: readonly CombatCommand[],
  changes: SeatChanges,
  terrain: SweepTarget[],
) {
  const outcomes = new Map<number, { fire: ActionOutcome; grenade: ActionOutcome }>();
  for (const tank of world.tanks) {
    const ownerId = tank.occupantId;
    if (ownerId === null) continue;
    const actor = world.players.find((player) => player.playerId === ownerId),
      command = actor && commands[actor.slot];
    if (!actor || !command) throw new Error("Missing tank fire owner");
    const changed = changes.has(ownerId);
    const result = stepTankGun(
      tank,
      changed ? neutral : command,
      world.tick,
      world.nextActionId,
      TANK_PROFILE,
      COMBAT_CATALOG,
    );
    world.nextActionId = result.nextActionId;
    const cannon = stepTankCannon(
      tank,
      !changed && command.grenadePressed,
      world.tick,
      world.nextActionId,
      TANK_PROFILE,
      COMBAT_CATALOG,
    );
    world.nextActionId = cannon.nextActionId;
    outcomes.set(ownerId, {
      fire:
        changed && (command.firePressed || command.held & Held.Fire)
          ? "unavailable"
          : result.outcome,
      grenade: changed && command.grenadePressed ? "unavailable" : cannon.outcome,
    });
    for (const [secondary, release] of [
      [false, result],
      [true, cannon],
    ] as const) {
      const profile = secondary ? TANK_PROFILE.cannon : TANK_PROFILE;
      const action = secondary ? tank.secondary.action : tank.action;
      const feed = secondary ? tank.secondary : tank.weapon;
      for (const item of release.markers) {
        const socket = item.pose.sockets.find((socket) => socket.name === "muzzle"),
          definition = COMBAT_ATTACKS.get(item.marker.payloadId),
          heading = profile.headings[profile.fireTimelineIds.indexOf(action.definitionId)],
          shape =
            definition &&
            COMBAT_SHAPES.get(secondary ? TANK_PROFILE.cannon.bodyShapeId : definition.shapeId);
        if (!socket || !definition || !shape || !heading)
          throw new Error("Missing tank release content");
        const point = worldSocket(tank.body, socket.point, 1);
        const notice: CombatNotice = {
          kind: "sound",
          ownerId,
          actionInstanceId: item.actionInstanceId,
          markerIndex: item.markerIndex,
          source: {
            definitionId: definition.id,
            controlEpoch: actor.controlEpoch,
            shotOrdinal: feed.shotOrdinal,
            vehicleId: tank.body.id,
          },
          position: point,
          impact: null,
          targetId: null,
          beam: null,
        };
        if (item.marker.kind === "spawn-attack") {
          notice.kind = "shot";
          if (muzzleBlocked(worldSocket(tank.body, profile.hardpoint, 1), point, shape, terrain))
            notice.kind = "muzzle-blocked";
          else {
            if (world.projectiles.length >= 256)
              throw new Error("Tank projectile cap requires recovery");
            world.projectiles.push({
              id: world.nextEntityId,
              ownerId,
              team: 1,
              actionInstanceId: item.actionInstanceId,
              definitionId: definition.id,
              position: point,
              velocity: { ...heading.velocity },
              spawnTick: world.tick,
            });
            world.nextEntityId = nextCounter(world.nextEntityId);
          }
        } else if (item.marker.kind !== "sound") throw new Error("Unsupported tank gun marker");
        world.events.push(notice);
      }
    }
  }
  return outcomes;
}

export function tankCombatHurtboxes(tanks: TankState[], previous = tanks): HurtTarget[] {
  return tanks.flatMap((tank, i) => {
    if (tank.armor === 0) return [];
    const before = previous[i],
      shape = COMBAT_SHAPES.get(tank.body.shapeId);
    if (!before || before.body.id !== tank.body.id || !shape)
      throw new Error("Tank hurtbox identity");
    return [
      {
        id: tank.body.id * 2,
        entityId: tank.body.id,
        team: 1,
        kind: "body" as const,
        rect: worldRect(before.body, shape.rect, tank.facing),
        delta: { x: tank.body.x - before.body.x, y: tank.body.y - before.body.y },
      },
    ];
  });
}

/** Several causes at one boundary still advance a player's input generation exactly once. */
export function commitCombatSeats(current: CombatLab, world: CombatLab, changes: SeatChanges) {
  return [...changes]
    .sort(([a], [b]) => a - b)
    .map(([playerId, reason]) => {
      const before = current.players.find((actor) => actor.playerId === playerId),
        actor = world.players.find((actor) => actor.playerId === playerId);
      if (!before || !actor) throw new Error("Missing seat transfer generation");
      actor.controlEpoch = nextCounter(before.controlEpoch);
      const tank = world.tanks.find((tank) => tankOwner(tank) === playerId);
      if (tank) tank.ownerControlEpoch = actor.controlEpoch;
      return {
        kind: "seat" as const,
        playerId,
        vehicleId: actor.vehicleId,
        controlEpoch: actor.controlEpoch,
        reason,
      };
    });
}

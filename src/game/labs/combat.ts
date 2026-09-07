import { type GroundedEnemy, stepGroundedEnemy } from "../actors/grounded.js";
import {
  type RifleState,
  cancelRifle,
  createRifleState,
  stepRifleAttack,
} from "../actors/rifle.js";
import { type LifeNotice, damagePlayer, stepPlayerLife } from "../campaign/life.js";
import { stepFirearm } from "../combat/firearm.js";
import {
  type BallisticProjectile,
  type HurtTarget,
  type Impact,
  muzzleBlocked,
  sweepProjectile,
} from "../combat/projectile.js";
import { stepFootController } from "../controller/foot.js";
import { canonical } from "../core/canonical.js";
import { compareContactTime, integer, nextCounter, pixels, position } from "../core/numeric.js";
import {
  type EncounterDefinition,
  type EncounterEvent,
  EncounterLifecycle,
  type EncounterState,
} from "../encounters/lifecycle.js";
import { HELD_MASK } from "../input/types.js";
import { worldRect, worldSocket } from "../physics/body.js";
import { type CollisionFrame, CollisionGrid, CollisionIndex } from "../physics/grid.js";
import type { SweepTarget } from "../physics/sweep.js";
import type { ControlledActor, Point } from "../state.js";
import { COMBAT_ATTACKS, COMBAT_CATALOG, COMBAT_SHAPES, RIFLE_PROFILE } from "./combat-content.js";
import { FOOT_DEFINITION, footActor, footTerrain } from "./foot-fixture.js";

export const COMBAT_SCENARIOS = ["range", "wall", "shield", "rifle"] as const;
export type CombatScenario = (typeof COMBAT_SCENARIOS)[number];
export interface CombatCommand {
  held: number;
  jumpPressed: boolean;
  firePressed: boolean;
}
export interface CombatTarget {
  enemy: GroundedEnemy;
  health: number;
  shield: boolean;
  rifle: RifleState | null;
}
export interface CombatNotice {
  kind: "shot" | "sound" | "muzzle-blocked" | "impact" | "killed";
  ownerId: number;
  actionInstanceId: number;
  markerIndex: number;
  /** Captured when the marker fires; later damage may cancel the actor's action. */
  source:
    | { definitionId: number; controlEpoch: number; shotOrdinal: number }
    | { definitionId: number; timelineId: number }
    | null;
  position: Point;
  impact: Impact | null;
  targetId: number | null;
}
export interface CombatLab {
  format: 1;
  scenario: CombatScenario;
  tick: number;
  nextActionId: number;
  nextEntityId: number;
  eventSequence: number;
  players: ControlledActor[];
  targets: CombatTarget[];
  projectiles: BallisticProjectile[];
  encounter: EncounterState;
  events: CombatNotice[];
}
export const COMBAT_LAB_LIMIT = 3600;
export const COMBAT_ENTRY = {
  firstX: pixels(45),
  slotSpacing: pixels(4),
  y: pixels(200),
  fallBoundary: pixels(248),
} as const;
export function combatEntryContext(
  actor: ControlledActor,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  const shape = FOOT_DEFINITION && COMBAT_SHAPES.get(FOOT_DEFINITION.standingShapeId);
  if (!shape) throw new Error("Missing life entry shape");
  return {
    shape,
    anchors: [
      { x: COMBAT_ENTRY.firstX + actor.slot * COMBAT_ENTRY.slotSpacing, y: COMBAT_ENTRY.y },
    ],
    index,
    frame,
  };
}
export function combatTerrain(scenario: CombatScenario): SweepTarget[] {
  return [
    footTerrain(100, 0, 200, 384, 16),
    ...(scenario === "wall" ? [footTerrain(101, 140, 130, 3, 70)] : []),
  ];
}
export function combatEncounterDefinition(
  world: Pick<CombatLab, "players" | "targets">,
): EncounterDefinition {
  return {
    id: 1,
    participants: world.players.map((player) => player.playerId),
    members: world.targets.map(({ enemy }) => ({
      id: enemy.body.id,
      required: true,
      critical: false,
      retreatAllowed: false,
      watchdogTicks: 600,
      ambientCleanupTicks: null,
    })),
    objectives: [],
  };
}
function lifecycle(world: Pick<CombatLab, "players" | "targets">) {
  return new EncounterLifecycle(combatEncounterDefinition(world));
}
export function createCombatLab(scenario: CombatScenario, count = 1): CombatLab {
  if (!COMBAT_SCENARIOS.includes(scenario)) throw new Error("Unknown combat scenario");
  integer(count, 1, 4, "combat players");
  const players = Array.from({ length: count }, (_, slot) => {
    const actor = footActor(45 + slot * 4, 200);
    actor.playerId = actor.body.id = slot + 1;
    actor.slot = slot;
    if (slot === 1) actor.weapon = { ...actor.weapon, id: "heavy-machine-gun", ammo: 150 };
    return actor;
  });
  const targets: CombatTarget[] = Array.from({ length: 2 }, (_, index) => ({
    enemy: {
      body: { ...footActor(220 + index * 60, 200).body, id: 20 + index },
      facing: -1,
      geometryRevision: 1,
      life: "alive",
      removalReason: null,
      turns: 0,
    },
    health: 1,
    shield: scenario === "shield" && index === 0,
    rifle: scenario === "rifle" ? createRifleState() : null,
  }));
  return {
    format: 1,
    scenario,
    tick: 0,
    nextActionId: 1,
    nextEntityId: 1000,
    eventSequence: 0,
    players,
    targets,
    projectiles: [],
    encounter: lifecycle({ players, targets }).begin(),
    events: [],
  };
}
export function combatHurtboxes(targets: CombatTarget[], previous = targets): HurtTarget[] {
  return targets.flatMap((target, index) => {
    if (target.health === 0 || target.enemy.life !== "alive") return [];
    const body = target.enemy.body,
      before = previous[index]?.enemy.body;
    if (!before || before.id !== body.id) throw new Error("Target motion identity mismatch");
    const kinds = target.shield ? (["body", "shield"] as const) : (["body"] as const);
    return kinds.map((kind) => {
      const shape = COMBAT_SHAPES.get(kind === "body" ? 3 : 8);
      if (!shape) throw new Error("Missing target hurt shape");
      return {
        id: body.id * 2 + (kind === "shield" ? 1 : 0),
        entityId: body.id,
        team: 2,
        kind,
        rect: worldRect(before, shape.rect, target.enemy.facing),
        delta: { x: body.x - before.x, y: body.y - before.y },
      };
    });
  });
}
/** End-pose exposure with root motion over the tick. Protected entry is not a bullet shield. */
export function playerCombatHurtboxes(
  players: ControlledActor[],
  previous = players,
): HurtTarget[] {
  return players.flatMap((player, slot) => {
    if (player.life !== "alive" || player.invulnerableTicks > 0) return [];
    const before = previous[slot];
    const shape = COMBAT_SHAPES.get(
      player.body.shapeId === FOOT_DEFINITION?.crouchedShapeId ? 7 : 3,
    );
    if (!before || before.body.id !== player.body.id || !shape)
      throw new Error("Player hurtbox identity");
    return [
      {
        id: player.body.id * 2,
        entityId: player.body.id,
        team: 1,
        kind: "body" as const,
        rect: worldRect(before.body, shape.rect, player.facing),
        delta: { x: player.body.x - before.body.x, y: player.body.y - before.body.y },
      },
    ];
  });
}

/** Locomotion -> markers at the new boundary -> old-projectile sweeps -> damage -> ledger. */
export function stepCombatLab(current: CombatLab, commands: readonly CombatCommand[]): CombatLab {
  return advanceCombatLab(current, commands).state;
}
export function advanceCombatLab(current: CombatLab, commands: readonly CombatCommand[]) {
  integer(current.tick, 0, COMBAT_LAB_LIMIT - 1, "combat tick");
  if (commands.length !== current.players.length) throw new Error("Missing combat input owner");
  for (const command of commands) {
    integer(command.held, 0, HELD_MASK, "combat held mask");
    if (typeof command.firePressed !== "boolean" || typeof command.jumpPressed !== "boolean")
      throw new Error("Invalid combat edges");
  }
  const world = structuredClone(current);
  const tick = ++world.tick;
  world.events = [];
  const terrain = combatTerrain(world.scenario);
  const frame = { tick, geometryRevision: 1 };
  const index = new CollisionIndex(new CollisionGrid(terrain), [], frame);
  const encounterEvents: EncounterEvent[] = [];
  const lifeNotices: LifeNotice[] = [];
  const outcomes: Array<{
    playerId: number;
    jumpAccepted: boolean;
    fire: ReturnType<typeof stepFirearm>["outcome"];
  }> = [];
  for (const [slot, actor] of world.players.entries()) {
    const command = commands[slot];
    if (!command || !FOOT_DEFINITION) throw new Error("Missing combat controller");
    const life = stepPlayerLife(actor, tick, "classic", combatEntryContext(actor, index, frame));
    if (life.notice) lifeNotices.push(life.notice);
    const result = stepFootController(
      life.actor,
      command,
      FOOT_DEFINITION,
      COMBAT_SHAPES,
      index,
      frame,
    );
    if (result.status === "failed") throw new Error(`Combat body: ${result.physics.reason}`);
    world.players[slot] = result.actor;
    outcomes.push({
      playerId: actor.playerId,
      jumpAccepted:
        result.status === "complete" &&
        (result.jumpRequest === "consumed" || result.jumpRequest === "buffered"),
      fire: "none",
    });
  }
  for (const target of world.targets) {
    if (
      world.encounter.members.some(
        (member) => member.id === target.enemy.body.id && member.status === "pending",
      )
    )
      encounterEvents.push({
        kind: "activate",
        id: target.enemy.body.id,
        sequence: ++world.eventSequence,
        tick,
      });
    if (target.health === 0) continue;
    const shape = COMBAT_SHAPES.get(target.enemy.body.shapeId);
    if (!shape) throw new Error("Missing enemy body");
    const result = stepGroundedEnemy(
      target.enemy,
      {
        speed: target.rifle?.action.kind === "fire" ? 0 : 64,
        gravity: 55,
        terminalVelocity: 2048,
        bounds: { x: 0, y: 0, w: pixels(384), h: pixels(220) },
      },
      shape,
      index,
      frame,
    );
    if (result.status === "failed") throw new Error(`Combat enemy: ${result.physics.reason}`);
    target.enemy = result.enemy;
    if (target.enemy.removalReason) {
      target.health = 0;
      if (target.rifle) cancelRifle(target.rifle);
      encounterEvents.push({
        kind: "resolve",
        id: target.enemy.body.id,
        reason: target.enemy.removalReason,
        killerId: null,
        sequence: ++world.eventSequence,
        tick,
      });
    }
  }
  for (const [slot, actor] of world.players.entries()) {
    const command = commands[slot];
    if (!command) throw new Error("Missing firearm input");
    const result = stepFirearm(actor, command, tick, world.nextActionId, COMBAT_CATALOG);
    world.players[slot] = result.actor;
    world.nextActionId = result.nextActionId;
    const outcome = outcomes.find((item) => item.playerId === actor.playerId);
    if (!outcome) throw new Error("Missing combat action owner");
    outcome.fire = result.outcome;
    for (const item of result.markers) {
      const local = item.pose.sockets.find((socket) => socket.name === item.marker.socket)?.point;
      if (!local) throw new Error("Missing marker socket");
      const position = worldSocket(actor.body, local, actor.facing);
      const notice: CombatNotice = {
        kind: "sound",
        ownerId: actor.playerId,
        actionInstanceId: item.actionInstanceId,
        markerIndex: item.markerIndex,
        source: {
          definitionId: item.marker.payloadId,
          controlEpoch: result.actor.controlEpoch,
          shotOrdinal: result.actor.weapon.shotOrdinal,
        },
        position,
        impact: null,
        targetId: null,
      };
      if (item.marker.kind === "spawn-attack") {
        const definition = COMBAT_ATTACKS.get(item.marker.payloadId);
        const shape = definition && COMBAT_SHAPES.get(definition.shapeId);
        const hand = item.pose.sockets.find((socket) => socket.name === "hand")?.point;
        if (!definition || !shape || !hand) throw new Error("Missing release definition");
        notice.kind = "shot";
        if (muzzleBlocked(worldSocket(actor.body, hand, actor.facing), position, shape, terrain))
          notice.kind = "muzzle-blocked";
        else {
          if (world.projectiles.length >= 256) throw new Error("Projectile cap requires recovery");
          world.projectiles.push({
            id: world.nextEntityId,
            ownerId: actor.playerId,
            team: 1,
            actionInstanceId: item.actionInstanceId,
            definitionId: definition.id,
            position,
            velocity: {
              x: actor.aim === 0 ? definition.speed * actor.facing : 0,
              y: actor.aim === 1 ? -definition.speed : actor.aim === 2 ? definition.speed : 0,
            },
            spawnTick: tick,
          });
          world.nextEntityId = nextCounter(world.nextEntityId);
        }
      } else if (item.marker.kind !== "sound") throw new Error("Unsupported firearm marker");
      world.events.push(notice);
    }
  }
  for (const target of world.targets) {
    if (!target.rifle || target.health === 0) continue;
    const shape = COMBAT_SHAPES.get(4);
    if (!shape) throw new Error("Missing rifle projectile shape");
    const result = stepRifleAttack(
      target.rifle,
      target.enemy,
      world.players,
      tick,
      world.nextActionId,
      COMBAT_CATALOG,
      RIFLE_PROFILE,
      shape,
      terrain,
    );
    target.rifle = result.state;
    target.enemy.facing = result.facing;
    world.nextActionId = result.nextActionId;
    for (const item of result.markers) {
      const muzzle = item.pose.sockets.find((socket) => socket.name === "muzzle")?.point;
      const hand = item.pose.sockets.find((socket) => socket.name === "hand")?.point;
      const definition = COMBAT_ATTACKS.get(item.marker.payloadId);
      if (!muzzle || !hand || !definition) throw new Error("Missing rifle release content");
      const position = worldSocket(target.enemy.body, muzzle, target.enemy.facing);
      const notice: CombatNotice = {
        kind: "sound",
        ownerId: target.enemy.body.id,
        actionInstanceId: item.actionInstanceId,
        markerIndex: item.markerIndex,
        source: { definitionId: definition.id, timelineId: target.rifle.action.definitionId },
        position,
        impact: null,
        targetId: null,
      };
      if (item.marker.kind === "spawn-attack") {
        notice.kind = "shot";
        if (
          muzzleBlocked(
            worldSocket(target.enemy.body, hand, target.enemy.facing),
            position,
            shape,
            terrain,
          )
        )
          notice.kind = "muzzle-blocked";
        else {
          if (world.projectiles.length >= 256) throw new Error("Projectile cap requires recovery");
          world.projectiles.push({
            id: world.nextEntityId,
            ownerId: target.enemy.body.id,
            team: 2,
            actionInstanceId: item.actionInstanceId,
            definitionId: definition.id,
            position,
            velocity: {
              x: target.rifle.aim === 0 ? definition.speed * target.enemy.facing : 0,
              y: target.rifle.aim === 1 ? -definition.speed : 0,
            },
            spawnTick: tick,
          });
          world.nextEntityId = nextCounter(world.nextEntityId);
        }
      } else if (item.marker.kind !== "sound") throw new Error("Unsupported rifle marker");
      world.events.push(notice);
    }
  }
  const hurtboxes = [
    ...combatHurtboxes(world.targets, current.targets),
    ...playerCombatHurtboxes(world.players, current.players),
  ];
  const impacts: Impact[] = [];
  world.projectiles = world.projectiles.filter((projectile) => {
    const definition = COMBAT_ATTACKS.get(projectile.definitionId);
    const shape = definition && COMBAT_SHAPES.get(definition.shapeId);
    if (!definition || !shape) throw new Error("Missing projectile definition");
    if (tick - projectile.spawnTick > definition.lifetimeTicks) return false;
    // Birth occurs at this tick's end pose. Its first motion belongs to the following tick.
    if (projectile.spawnTick === tick) return true;
    const impact = sweepProjectile(projectile, definition, shape, terrain, hurtboxes);
    if (impact) {
      impacts.push(impact);
      return false;
    }
    projectile.position = {
      x: position(projectile.position.x + projectile.velocity.x),
      y: position(projectile.position.y + projectile.velocity.y),
    };
    return tick - projectile.spawnTick < definition.lifetimeTicks;
  });
  impacts.sort(
    (a, b) =>
      compareContactTime(
        a.time.numerator,
        a.time.denominator,
        b.time.numerator,
        b.time.denominator,
      ) ||
      a.actionInstanceId - b.actionInstanceId ||
      a.projectileId - b.projectileId ||
      a.colliderId - b.colliderId,
  );
  for (const impact of impacts) {
    const notice: CombatNotice = {
      kind: "impact",
      ownerId: impact.ownerId,
      actionInstanceId: impact.actionInstanceId,
      markerIndex: 0,
      source: null,
      position: impact.position,
      impact,
      targetId: impact.entityId,
    };
    world.events.push(notice);
    const slot = world.players.findIndex((player) => player.body.id === impact.entityId);
    const player = world.players[slot];
    if (player && impact.damage > 0) {
      const damage = damagePlayer(player, tick, impact.damage, "classic");
      world.players[slot] = damage.actor;
      if (damage.notice) {
        lifeNotices.push(damage.notice);
        world.events.push({ ...notice, kind: "killed" });
      }
      continue;
    }
    const target = world.targets.find((candidate) => candidate.enemy.body.id === impact.entityId);
    if (!target || target.health === 0 || impact.damage === 0) continue;
    target.health = Math.max(0, target.health - impact.damage);
    if (target.health === 0) {
      target.enemy.life = "removed";
      if (target.rifle) cancelRifle(target.rifle);
      world.events.push({ ...notice, kind: "killed" });
      encounterEvents.push({
        kind: "resolve",
        id: target.enemy.body.id,
        reason: "killed",
        killerId: impact.ownerId,
        sequence: ++world.eventSequence,
        tick,
      });
    }
  }
  for (const [slot, actor] of world.players.entries()) {
    // The range's authored lower kill boundary resolves real falls, not a client death command.
    if (actor.life !== "alive" || actor.body.y <= COMBAT_ENTRY.fallBoundary) continue;
    const death = damagePlayer(actor, tick, 1, "classic", "fall");
    world.players[slot] = death.actor;
    if (death.notice) lifeNotices.push(death.notice);
  }
  world.encounter = lifecycle(world).step(
    world.encounter,
    tick,
    encounterEvents,
    world.targets
      .filter((target) => target.health > 0)
      .map((target) => ({
        id: target.enemy.body.id,
        progressKey: canonical(target.enemy.body),
        unreachable: false,
      })),
    "throw",
  ).state;
  return { state: world, outcomes, lifeNotices };
}
export interface CombatRecording {
  format: 1;
  scenario: CombatScenario;
  players: number;
  commands: CombatCommand[][];
  finalState: string;
}
export function replayCombatLab(recording: CombatRecording) {
  if (
    recording.format !== 1 ||
    !Array.isArray(recording.commands) ||
    recording.commands.length > COMBAT_LAB_LIMIT
  )
    throw new Error("Invalid combat recording");
  let world = createCombatLab(recording.scenario, recording.players);
  for (const commands of recording.commands) world = stepCombatLab(world, commands);
  if (canonical(world) !== recording.finalState) throw new Error("Combat replay diverged");
  return world;
}

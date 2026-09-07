import { type GroundedEnemy, stepGroundedEnemy } from "../actors/grounded.js";
import {
  type RifleState,
  cancelRifle,
  createRifleState,
  stepRifleAttack,
} from "../actors/rifle.js";
import {
  type ShieldState,
  cancelShield,
  createShieldState,
  damageShield,
  shieldProtected,
  stepShield,
} from "../actors/shield.js";
import { type LifeNotice, damagePlayer, stepPlayerLife } from "../campaign/life.js";
import {
  type AreaAnchor,
  type AreaAttack,
  cancelArea,
  emitArea,
  stepArea,
} from "../combat/area-attack.js";
import {
  type DestructibleDefinition,
  type DestructibleState,
  createDestructible,
  damageDestructible,
  destructibleHurtboxes,
  detachDestroyedSupport,
} from "../combat/destructible.js";
import { firearmVelocity } from "../combat/firearm-aim.js";
import { type ActionOutcome, stepFootCombatAction } from "../combat/foot-actions.js";
import { type Grenade, grenadeLaunchVelocity, stepGrenade } from "../combat/grenade.js";
import {
  type BallisticProjectile,
  type HurtTarget,
  type Impact,
  muzzleBlocked,
  sweepProjectile,
} from "../combat/projectile.js";
import { actionPose } from "../combat/timeline.js";
import { type MeleeStrike, explosionHits, meleeHits } from "../combat/volume.js";
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
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import { type SweepTarget, displacementAtContact, earliestSweep } from "../physics/sweep.js";
import type { ControlledActor, Point } from "../state.js";
import { type TankState, createTank } from "../vehicles/tank.js";
import {
  AREA_PROFILES,
  COMBAT_ATTACKS,
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  FOOT_ACTION_PROFILES,
  GRENADE_PROFILE,
  RIFLE_PROFILE,
  SHIELD_PROFILE,
  TANK_PROFILE,
} from "./combat-content.js";
import {
  type CombatTankConnections,
  type SeatChanges,
  advanceCombatTanks,
  commitCombatSeats,
  fireCombatTanks,
  releaseCombatTank,
  tankCombatHurtboxes,
} from "./combat-tanks.js";
import {
  COMBAT_ORDNANCE,
  COMBAT_SUPPORT,
  combatCollisionIndex,
  combatGeometryRevision,
  combatTerrain,
} from "./combat-terrain.js";
import { FOOT_DEFINITION, footActor } from "./foot-fixture.js";

export { combatTerrain } from "./combat-terrain.js";

export const COMBAT_SCENARIOS = [
  "range",
  "wall",
  "shield",
  "rifle",
  "guard",
  "shotgun",
  "flame",
  "tank",
  "ordnance",
  "hmg",
  "support",
] as const;
export type CombatScenario = (typeof COMBAT_SCENARIOS)[number];
export interface CombatCommand {
  held: number;
  jumpPressed: boolean;
  firePressed: boolean;
  grenadePressed: boolean;
  interactPressed: boolean;
}
export interface CombatTarget {
  enemy: GroundedEnemy;
  health: number;
  shield: boolean;
  rifle: RifleState | null;
  guard: ShieldState | null;
}
/** Tick-local mission geometry and external damage targets, consumed by the same combat kernel. */
export interface CombatStage {
  terrain: SweepTarget[];
  destructibles: readonly DestructibleDefinition[];
  enemyBounds: { x: number; y: number; w: number; h: number };
  fallBoundary: number;
  entry: Point;
  activeEnemyIds: ReadonlySet<number>;
  extraHurtboxes: readonly HurtTarget[];
}
export interface CombatNotice {
  kind:
    | "shot"
    | "sound"
    | "muzzle-blocked"
    | "impact"
    | "killed"
    | "melee"
    | "throw"
    | "action-sound"
    | "explosion"
    | "shield-break"
    | "prop-destroyed";
  ownerId: number;
  actionInstanceId: number;
  markerIndex: number;
  /** Captured when the marker fires; later damage may cancel the actor's action. */
  source:
    | { definitionId: number; controlEpoch: number; shotOrdinal: number }
    | { definitionId: number; controlEpoch: number; shotOrdinal: number; vehicleId: number }
    | { definitionId: number; timelineId: number; stateStartTick: number }
    | { definitionId: number; spawnTick: number; sourceId: number }
    | null;
  position: Point;
  impact: Impact | null;
  targetId: number | null;
}
export interface CombatLab {
  format: 9;
  scenario: CombatScenario;
  tick: number;
  nextActionId: number;
  nextEntityId: number;
  eventSequence: number;
  players: ControlledActor[];
  tanks: TankState[];
  targets: CombatTarget[];
  props: DestructibleState[];
  projectiles: BallisticProjectile[];
  strikes: MeleeStrike[];
  grenades: Grenade[];
  areas: AreaAttack[];
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
export const COMBAT_TANK_DEPOT = {
  firstPlayerX: pixels(36),
  slotSpacing: pixels(56),
  vehicleOffsetX: pixels(24),
  y: pixels(200),
} as const;
export function combatEntryContext(
  actor: ControlledActor,
  index: CollisionIndex,
  frame: CollisionFrame,
  scenario: CombatScenario = "range",
) {
  if (!FOOT_DEFINITION) throw new Error("Missing life physics definition");
  const shape = COMBAT_SHAPES.get(FOOT_DEFINITION.standingShapeId);
  if (!shape) throw new Error("Missing life entry shape");
  const lift = scenario === "ordnance" ? index.get(COMBAT_ORDNANCE[0].id)?.rect : undefined;
  return {
    shape,
    definition: FOOT_DEFINITION,
    shapes: COMBAT_SHAPES,
    fallBoundary: COMBAT_ENTRY.fallBoundary,
    anchors: [
      {
        x:
          scenario === "tank"
            ? COMBAT_TANK_DEPOT.firstPlayerX + actor.slot * COMBAT_TANK_DEPOT.slotSpacing
            : COMBAT_ENTRY.firstX +
              actor.slot * COMBAT_ENTRY.slotSpacing +
              (lift ? lift.x - pixels(24) : 0),
        y: lift?.y ?? COMBAT_ENTRY.y,
      },
    ],
    index,
    frame,
  };
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
    const actor = footActor(
      scenario === "tank"
        ? (COMBAT_TANK_DEPOT.firstPlayerX + slot * COMBAT_TANK_DEPOT.slotSpacing) / 256
        : 45 + slot * 4,
      scenario === "ordnance" ? 160 : 200,
    );
    actor.playerId = actor.body.id = slot + 1;
    actor.slot = slot;
    if (scenario === "ordnance") actor.body.supportId = 102;
    if (slot === 1) actor.weapon = { ...actor.weapon, id: "heavy-machine-gun", ammo: 150 };
    if (scenario === "hmg") actor.weapon = { ...actor.weapon, id: "heavy-machine-gun", ammo: 150 };
    if (scenario === "shotgun") actor.weapon = { ...actor.weapon, id: "shotgun", ammo: 24 };
    if (scenario === "flame") actor.weapon = { ...actor.weapon, id: "flamethrower", ammo: 30 };
    return actor;
  });
  const props = scenario === "support" ? COMBAT_SUPPORT.map(createDestructible) : [];
  const targets: CombatTarget[] = Array.from({ length: 2 }, (_, index) => ({
    enemy: {
      body: {
        ...footActor(
          scenario === "support"
            ? 220 + index * 60
            : scenario === "ordnance"
              ? 340 + index * 26
              : scenario === "tank"
                ? 300 + index * 40
                : scenario === "shotgun"
                  ? 140 + index * 30
                  : (scenario === "guard" || scenario === "flame") && index === 0
                    ? 140
                    : scenario === "flame"
                      ? 220
                      : 220 + index * 60,
          scenario === "support" ? 160 : 200,
        ).body,
        ...(scenario === "support" ? { supportId: 104 } : {}),
        id: 20 + index,
      },
      facing: -1,
      geometryRevision: 1,
      life: "alive",
      removalReason: null,
      turns: 0,
    },
    health: 1,
    shield: scenario === "shield" && index === 0,
    rifle:
      scenario === "tank" ||
      scenario === "rifle" ||
      ((scenario === "guard" || scenario === "flame" || scenario === "support") && index === 1)
        ? createRifleState()
        : null,
    guard:
      (scenario === "guard" || scenario === "flame" || scenario === "support") && index === 0
        ? createShieldState(SHIELD_PROFILE)
        : null,
  }));
  return {
    format: 9,
    scenario,
    tick: 0,
    nextActionId: 1,
    nextEntityId: 1000,
    eventSequence: 0,
    players,
    tanks:
      scenario === "tank"
        ? players.map((actor) =>
            createTank(
              30 + actor.slot,
              {
                x:
                  COMBAT_TANK_DEPOT.firstPlayerX +
                  actor.slot * COMBAT_TANK_DEPOT.slotSpacing +
                  COMBAT_TANK_DEPOT.vehicleOffsetX,
                y: COMBAT_TANK_DEPOT.y,
              },
              100,
              TANK_PROFILE,
            ),
          )
        : [],
    targets,
    props,
    projectiles: [],
    strikes: [],
    grenades: [],
    areas: [],
    encounter: lifecycle({ players, targets }).begin(),
    events: [],
  };
}

export function combatAreaAnchor(
  world: Pick<CombatLab, "players" | "tick">,
  area: AreaAttack,
): AreaAnchor | null {
  const actor = world.players.find((actor) => actor.playerId === area.ownerId);
  if (
    actor?.life !== "alive" ||
    actor.vehicleId !== null ||
    actor.action.kind !== "fire" ||
    actor.action.actionInstanceId !== area.actionInstanceId
  )
    return null;
  const pose = actionPose(
    COMBAT_CATALOG,
    actor.action.definitionId,
    world.tick - actor.action.stateStartTick,
  );
  const socket = pose?.sockets.find((socket) => socket.name === "muzzle");
  if (!socket) throw new Error("Missing attached volume socket");
  return {
    origin: worldSocket(actor.body, socket.point, actor.facing),
    heading: actor.aim === 1 ? 1 : actor.aim === 2 ? 2 : actor.facing === 1 ? 0 : 3,
  };
}

function actionHand(actor: ControlledActor, tick: number) {
  const pose = actionPose(
    COMBAT_CATALOG,
    actor.action.definitionId,
    tick - actor.action.stateStartTick,
  );
  const socket = pose?.sockets.find((socket) => socket.name === "hand");
  if (!socket) throw new Error("Missing combat hand socket");
  return socket.point;
}
function appendShieldMarkers(
  world: CombatLab,
  target: CombatTarget,
  markers: ReturnType<typeof stepShield>["markers"],
) {
  const guard = target.guard;
  if (!guard || target.health === 0) return;
  for (const item of markers) {
    if (item.marker.kind === "face") continue;
    if (item.marker.kind !== "sound" && item.marker.kind !== "activate-hitbox")
      throw new Error("Unsupported shield marker");
    const socket = item.pose.sockets.find((socket) => socket.name === item.marker.socket);
    if (!socket) throw new Error("Missing shield marker socket");
    world.events.push({
      kind: item.marker.kind === "sound" ? "action-sound" : "melee",
      ownerId: target.enemy.body.id,
      actionInstanceId: item.actionInstanceId,
      markerIndex: item.markerIndex,
      source: {
        definitionId: item.marker.payloadId,
        timelineId: guard.action.definitionId,
        stateStartTick: guard.action.stateStartTick,
      },
      position: worldSocket(target.enemy.body, socket.point, target.enemy.facing),
      impact: null,
      targetId: null,
    });
  }
}
function meleeEligible(
  actor: ControlledActor,
  targets: CombatTarget[],
  terrain: SweepTarget[],
  tick: number,
  props: readonly DestructibleState[],
  definitions: readonly DestructibleDefinition[],
  extraHurtboxes: readonly HurtTarget[],
): boolean {
  const definition = COMBAT_ATTACKS.get(4),
    shape = COMBAT_SHAPES.get(9);
  if (!definition || !shape) throw new Error("Missing contextual melee content");
  const pose = COMBAT_CATALOG.poses.get(
    FOOT_ACTION_PROFILES.melee.timelineIds[actor.locomotion === "crouched" ? 1 : 0],
  );
  const socket = pose?.sockets.find((socket) => socket.name === "hand");
  if (!socket) throw new Error("Missing melee ready socket");
  const hand = worldSocket(actor.body, socket.point, actor.facing);
  return (
    actor.aim === 0 &&
    meleeHits(
      { id: actor.body.id, ownerId: actor.playerId, team: 1, actionInstanceId: 1, definitionId: 4 },
      definition,
      shape,
      hand,
      { x: 0, y: 0 },
      actor.facing,
      { x: actor.body.x, y: hand.y },
      terrain,
      [
        ...combatHurtboxes(targets, tick),
        ...destructibleHurtboxes(props, definitions),
        ...extraHurtboxes,
      ],
    ).some((hit) => hit.damage > 0)
  );
}
export function combatHurtboxes(
  targets: CombatTarget[],
  tick: number,
  previous = targets,
): HurtTarget[] {
  return targets.flatMap((target, index) => {
    if (target.health === 0 || target.enemy.life !== "alive") return [];
    const body = target.enemy.body,
      before = previous[index]?.enemy.body;
    if (!before || before.id !== body.id) throw new Error("Target motion identity mismatch");
    const protectedBody =
      target.shield ||
      (target.guard !== null && shieldProtected(target.guard, tick, SHIELD_PROFILE));
    const kinds = protectedBody ? (["body", "shield"] as const) : (["body"] as const);
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
    if (player.life !== "alive" || player.invulnerableTicks > 0 || player.vehicleId !== null)
      return [];
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
export function advanceCombatLab(
  current: CombatLab,
  commands: readonly CombatCommand[],
  connections: CombatTankConnections = {
    connectedPlayerIds: current.players.map((p) => p.playerId),
    releasePlayerIds: [],
  },
  stage?: CombatStage,
) {
  integer(current.tick, 0, COMBAT_LAB_LIMIT - 1, "combat tick");
  if (commands.length !== current.players.length) throw new Error("Missing combat input owner");
  for (const command of commands) {
    integer(command.held, 0, HELD_MASK, "combat held mask");
    if (
      typeof command.firePressed !== "boolean" ||
      typeof command.jumpPressed !== "boolean" ||
      typeof command.grenadePressed !== "boolean" ||
      typeof command.interactPressed !== "boolean"
    )
      throw new Error("Invalid combat edges");
  }
  const world = structuredClone(current);
  const tick = ++world.tick;
  world.events = [];
  const physicalTerrain = stage?.terrain ?? combatTerrain(world.scenario, tick, world.props);
  const active = (target: CombatTarget) => !stage || stage.activeEnemyIds.has(target.enemy.body.id);
  const destructibles = stage?.destructibles ?? COMBAT_SUPPORT;
  const terrain = physicalTerrain.filter(
    (target) => !world.props.some((prop) => prop.id === target.id),
  );
  const frame = { tick, geometryRevision: combatGeometryRevision(world.props) };
  const index = combatCollisionIndex(world.scenario, frame, world.props, physicalTerrain);
  const encounterEvents: EncounterEvent[] = [];
  const activatedIds = new Set<number>();
  const activateTarget = (id: number) => {
    if (
      !activatedIds.has(id) &&
      world.encounter.members.some((member) => member.id === id && member.status === "pending")
    ) {
      activatedIds.add(id);
      encounterEvents.push({ kind: "activate", id, sequence: ++world.eventSequence, tick });
    }
  };
  const lifeNotices: LifeNotice[] = [];
  const seatChanges: SeatChanges = new Map();
  const outcomes: Array<{
    playerId: number;
    jumpAccepted: boolean;
    fire: ActionOutcome;
    grenade: ActionOutcome;
    interact: ActionOutcome;
  }> = [];
  for (const [slot, actor] of world.players.entries()) {
    const command = commands[slot];
    if (!command || !FOOT_DEFINITION) throw new Error("Missing combat controller");
    const life = stepPlayerLife(actor, tick, "classic", {
      ...combatEntryContext(actor, index, frame, world.scenario),
      ...(stage
        ? {
            fallBoundary: stage.fallBoundary,
            anchors: [{ x: stage.entry.x + actor.slot * pixels(24), y: stage.entry.y }],
          }
        : {}),
    });
    if (life.notice) lifeNotices.push(life.notice);
    const result = stepFootController(
      life.actor,
      command,
      FOOT_DEFINITION,
      COMBAT_SHAPES,
      index,
      frame,
    );
    if (result.status === "failed") {
      if (result.physics.reason !== "crushed")
        throw new Error(`Combat body: ${result.physics.reason}`);
      const killed = damagePlayer(life.actor, tick, 1, "classic", "crush");
      world.players[slot] = killed.actor;
      if (killed.notice) lifeNotices.push(killed.notice);
    } else world.players[slot] = result.actor;
    outcomes.push({
      playerId: actor.playerId,
      jumpAccepted:
        result.status === "complete" &&
        (result.jumpRequest === "consumed" || result.jumpRequest === "buffered"),
      fire: "none",
      grenade: "none",
      interact: "none",
    });
  }
  const tankOutcomes = advanceCombatTanks(
    world,
    commands,
    connections,
    seatChanges,
    lifeNotices,
    index,
    frame,
  );
  for (const outcome of outcomes) {
    const tank = tankOutcomes.get(outcome.playerId);
    if (!tank) throw new Error("Missing tank input outcome");
    outcome.jumpAccepted ||= tank.jumpAccepted;
    outcome.interact = tank.interact;
  }
  for (const target of world.targets) {
    if (!active(target)) continue;
    activateTarget(target.enemy.body.id);
    if (target.health === 0) continue;
    const shieldStep =
      target.guard &&
      stepShield(
        target.guard,
        target.enemy,
        world.players,
        tick,
        world.nextActionId,
        COMBAT_CATALOG,
        SHIELD_PROFILE,
      );
    if (shieldStep) {
      target.guard = shieldStep.state;
      target.enemy.facing = shieldStep.state.facing;
      world.nextActionId = shieldStep.nextActionId;
    }
    const shape = COMBAT_SHAPES.get(target.enemy.body.shapeId);
    if (!shape) throw new Error("Missing enemy body");
    const result = stepGroundedEnemy(
      target.enemy,
      {
        speed: shieldStep ? shieldStep.speed : target.rifle?.action.kind === "fire" ? 0 : 64,
        turnAtBoundary: !target.guard && target.rifle?.action.kind !== "fire",
        gravity: 55,
        terminalVelocity: 2048,
        bounds: stage?.enemyBounds ?? { x: 0, y: 0, w: pixels(384), h: pixels(220) },
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
      if (target.guard) cancelShield(target.guard);
      encounterEvents.push({
        kind: "resolve",
        id: target.enemy.body.id,
        reason: target.enemy.removalReason,
        killerId: null,
        sequence: ++world.eventSequence,
        tick,
      });
    }
    if (shieldStep) appendShieldMarkers(world, target, shieldStep.markers);
  }
  for (const [slot, actor] of world.players.entries()) {
    const command = commands[slot];
    if (!command) throw new Error("Missing firearm input");
    const result = stepFootCombatAction(
      actor,
      seatChanges.has(actor.playerId)
        ? { held: 0, firePressed: false, grenadePressed: false }
        : command,
      tick,
      world.nextActionId,
      COMBAT_CATALOG,
      FOOT_ACTION_PROFILES,
      meleeEligible(
        actor,
        world.targets,
        terrain,
        tick,
        world.props,
        destructibles,
        stage?.extraHurtboxes ?? [],
      ),
    );
    world.players[slot] = result.actor;
    world.nextActionId = result.nextActionId;
    const outcome = outcomes.find((item) => item.playerId === actor.playerId);
    if (!outcome) throw new Error("Missing combat action owner");
    outcome.fire = result.fire;
    outcome.grenade = result.grenade;
    for (const item of result.markers) {
      const local = item.pose.sockets.find((socket) => socket.name === item.marker.socket)?.point;
      if (!local) throw new Error("Missing marker socket");
      const position = worldSocket(actor.body, local, actor.facing);
      if (item.marker.payloadId === 4 || item.marker.payloadId === 5) {
        const notice: CombatNotice = {
          kind: "action-sound",
          ownerId: actor.playerId,
          actionInstanceId: item.actionInstanceId,
          markerIndex: item.markerIndex,
          source: {
            definitionId: item.marker.payloadId,
            timelineId: result.actor.action.definitionId,
            stateStartTick: result.actor.action.stateStartTick,
          },
          position,
          impact: null,
          targetId: null,
        };
        if (item.marker.kind === "activate-hitbox") {
          notice.kind = "melee";
          world.strikes.push({
            id: world.nextEntityId,
            ownerId: actor.playerId,
            team: 1,
            actionInstanceId: item.actionInstanceId,
            definitionId: 4,
            spawnTick: tick,
            endTick: tick + (COMBAT_ATTACKS.get(4)?.lifetimeTicks ?? 0),
            hitIds: [],
          });
          world.nextEntityId = nextCounter(world.nextEntityId);
        } else if (item.marker.kind === "spawn-attack") {
          notice.kind = "throw";
          const shape = COMBAT_SHAPES.get(GRENADE_PROFILE.bodyShapeId);
          if (!shape) throw new Error("Missing grenade body");
          const handRoot = { x: actor.body.x, y: position.y };
          const delta = { x: position.x - handRoot.x, y: 0 };
          const blocking = earliestSweep(
            worldRect(handRoot, shape.rect, 1),
            delta,
            physicalTerrain.map((target) => ({
              ...target,
              rect: {
                ...target.rect,
                x: target.rect.x + target.delta.x,
                y: target.rect.y + target.delta.y,
              },
              delta: { x: 0, y: 0 },
            })),
          );
          if (blocking.overlaps.length) throw new Error("Grenade hand starts inside terrain");
          const contact = blocking.contacts[0];
          const releaseDelta = contact ? displacementAtContact(delta, contact.time) : delta;
          const release = { x: handRoot.x + releaseDelta.x, y: handRoot.y + releaseDelta.y };
          notice.position = release;
          const velocity = grenadeLaunchVelocity(actor, GRENADE_PROFILE, index, frame);
          world.grenades.push({
            id: world.nextEntityId,
            ownerId: actor.playerId,
            team: 1,
            actionInstanceId: item.actionInstanceId,
            definitionId: 5,
            spawnTick: tick,
            bounces: 0,
            body: {
              id: world.nextEntityId,
              x: release.x,
              y: release.y,
              vx: velocity.x,
              vy: velocity.y,
              remainderX: 0,
              remainderY: 0,
              shapeId: shape.id,
              grounded: false,
              supportId: null,
              contacts: [],
            },
          });
          world.nextEntityId = nextCounter(world.nextEntityId);
        } else if (item.marker.kind !== "sound") throw new Error("Unsupported foot action marker");
        world.events.push(notice);
        continue;
      }
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
        const areaProfile = AREA_PROFILES.get(definition.id);
        const clearance = areaProfile ? COMBAT_SHAPES.get(4) : shape;
        if (!clearance) throw new Error("Missing muzzle clearance shape");
        const blocked = muzzleBlocked(
          worldSocket(actor.body, hand, actor.facing),
          position,
          clearance,
          physicalTerrain,
        );
        if (areaProfile) {
          let area = world.areas.find((area) => area.actionInstanceId === item.actionInstanceId);
          if (!area) {
            if (world.areas.length >= 16) throw new Error("Area attack cap requires recovery");
            area = {
              id: world.nextEntityId,
              ownerId: actor.playerId,
              team: 1,
              actionInstanceId: item.actionInstanceId,
              definitionId: definition.id,
              startTick: result.actor.action.stateStartTick,
              emitted: 0,
              cancelledTick: null,
              lobes: [],
              hits: [],
            };
            world.areas.push(area);
            world.nextEntityId = nextCounter(world.nextEntityId);
          }
          emitArea(
            area,
            tick,
            areaProfile,
            {
              origin: position,
              heading: actor.aim === 1 ? 1 : actor.aim === 2 ? 2 : actor.facing === 1 ? 0 : 3,
            },
            blocked,
          );
          if (blocked) notice.kind = "muzzle-blocked";
        } else if (blocked) notice.kind = "muzzle-blocked";
        else {
          if (world.projectiles.length >= 256) throw new Error("Projectile cap requires recovery");
          world.projectiles.push({
            id: world.nextEntityId,
            ownerId: actor.playerId,
            team: 1,
            actionInstanceId: item.actionInstanceId,
            definitionId: definition.id,
            position,
            velocity: firearmVelocity(result.actor, definition.speed, COMBAT_CATALOG),
            spawnTick: tick,
          });
          world.nextEntityId = nextCounter(world.nextEntityId);
        }
      } else if (item.marker.kind !== "sound") throw new Error("Unsupported firearm marker");
      world.events.push(notice);
    }
  }
  const tankFire = fireCombatTanks(world, commands, seatChanges, physicalTerrain);
  for (const outcome of outcomes) {
    const fire = tankFire.get(outcome.playerId);
    if (fire !== undefined) outcome.fire = fire;
  }
  for (const target of world.targets) {
    if (!active(target) || !target.rifle || target.health === 0) continue;
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
      physicalTerrain,
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
        source: {
          definitionId: definition.id,
          timelineId: target.rifle.action.definitionId,
          stateStartTick: target.rifle.action.stateStartTick,
        },
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
            physicalTerrain,
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
    // Authored actors remain material before AI activation. A long-range round must
    // meet an intact shield before it can enter the body behind it.
    ...combatHurtboxes(world.targets, tick, current.targets),
    ...playerCombatHurtboxes(world.players, current.players),
    ...tankCombatHurtboxes(world.tanks, current.tanks),
    ...destructibleHurtboxes(world.props, destructibles),
    ...(stage?.extraHurtboxes ?? []),
  ];
  const impacts: Impact[] = [];
  world.areas = world.areas.flatMap((area) => {
    const definition = COMBAT_ATTACKS.get(area.definitionId),
      profile = AREA_PROFILES.get(area.definitionId);
    if (!definition || !profile) throw new Error("Missing area policy");
    const result = stepArea(
      area,
      tick,
      definition,
      profile,
      combatAreaAnchor(world, area),
      terrain,
      hurtboxes,
    );
    impacts.push(...result.impacts);
    return result.attack ? [result.attack] : [];
  });
  for (const target of world.targets) {
    const guard = target.guard;
    if (!active(target) || !guard || target.health === 0 || guard.phase !== "bash") continue;
    const age = tick - guard.action.stateStartTick;
    if (
      age < SHIELD_PROFILE.bashActiveTick ||
      age >= SHIELD_PROFILE.bashActiveTick + SHIELD_PROFILE.bashActiveTicks
    )
      continue;
    const pose = actionPose(COMBAT_CATALOG, guard.action.definitionId, age);
    const socket = pose?.sockets.find((socket) => socket.name === "hand");
    const definition = COMBAT_ATTACKS.get(6),
      shape = COMBAT_SHAPES.get(12);
    const previous = current.targets.find(
      (candidate) => candidate.enemy.body.id === target.enemy.body.id,
    );
    if (!socket || !definition || !shape || !previous) throw new Error("Missing bash volume");
    const moving = age > SHIELD_PROFILE.bashActiveTick;
    const body = moving ? previous.enemy.body : target.enemy.body;
    const hand = worldSocket(body, socket.point, guard.facing);
    const delta = moving
      ? { x: target.enemy.body.x - body.x, y: target.enemy.body.y - body.y }
      : { x: 0, y: 0 };
    const candidates = moving
      ? hurtboxes
      : hurtboxes.map((hurt) => ({
          ...hurt,
          rect: { ...hurt.rect, x: hurt.rect.x + hurt.delta.x, y: hurt.rect.y + hurt.delta.y },
          delta: { x: 0, y: 0 },
        }));
    const hits = meleeHits(
      {
        id: target.enemy.body.id,
        ownerId: target.enemy.body.id,
        team: 2,
        actionInstanceId: guard.action.actionInstanceId,
        definitionId: 6,
      },
      definition,
      shape,
      hand,
      delta,
      guard.facing,
      { x: body.x, y: hand.y },
      terrain,
      candidates,
      guard.hitIds,
    );
    for (const hit of hits) if (hit.entityId !== null) guard.hitIds.push(hit.entityId);
    guard.hitIds.sort((a, b) => a - b);
    impacts.push(...hits);
  }
  world.strikes = world.strikes.filter((strike) => {
    const owner = world.players.find((player) => player.playerId === strike.ownerId);
    const before = current.players.find((player) => player.playerId === strike.ownerId);
    if (!owner || !before) throw new Error("Missing melee owner");
    if (
      tick >= strike.endTick ||
      owner.life !== "alive" ||
      owner.action.actionInstanceId !== strike.actionInstanceId ||
      owner.action.kind !== "melee"
    )
      return false;
    const definition = COMBAT_ATTACKS.get(strike.definitionId),
      shape = definition && COMBAT_SHAPES.get(definition.shapeId);
    if (!definition || !shape) throw new Error("Missing melee volume");
    const hand = actionHand(owner, tick);
    const sameFacing = owner.facing === before.facing && strike.spawnTick !== tick;
    const start = worldSocket(sameFacing ? before.body : owner.body, hand, owner.facing);
    const delta = sameFacing
      ? { x: owner.body.x - before.body.x, y: owner.body.y - before.body.y }
      : { x: 0, y: 0 };
    const candidates = sameFacing
      ? hurtboxes
      : hurtboxes.map((target) => ({
          ...target,
          rect: {
            ...target.rect,
            x: target.rect.x + target.delta.x,
            y: target.rect.y + target.delta.y,
          },
          delta: { x: 0, y: 0 },
        }));
    const hits = meleeHits(
      strike,
      definition,
      shape,
      start,
      delta,
      owner.facing,
      { x: sameFacing ? before.body.x : owner.body.x, y: start.y },
      terrain,
      candidates,
      strike.hitIds,
    );
    for (const hit of hits) if (hit.entityId !== null) strike.hitIds.push(hit.entityId);
    strike.hitIds.sort((a, b) => a - b);
    impacts.push(...hits);
    return true;
  });
  world.grenades = world.grenades.filter((grenade) => {
    const shape = COMBAT_SHAPES.get(GRENADE_PROFILE.bodyShapeId),
      definition = COMBAT_ATTACKS.get(grenade.definitionId);
    if (!shape || !definition) throw new Error("Missing grenade policy");
    const result = stepGrenade(grenade, GRENADE_PROFILE, shape, index, frame);
    if (result.status === "active") {
      Object.assign(grenade, result.grenade);
      return true;
    }
    const position = result.position;
    if (result.status === "crushed") {
      const colliderId = result.colliderIds[0];
      if (colliderId === undefined) throw new Error("Grenade crush lacks a terrain witness");
      world.events.push({
        kind: "impact",
        ownerId: grenade.ownerId,
        actionInstanceId: grenade.actionInstanceId,
        markerIndex: 0,
        source: null,
        position,
        targetId: null,
        impact: {
          sourceId: grenade.id,
          definitionId: grenade.definitionId,
          actionInstanceId: grenade.actionInstanceId,
          ownerId: grenade.ownerId,
          colliderId,
          entityId: null,
          kind: "terrain",
          damage: 0,
          position,
          time: { numerator: 1, denominator: 1 },
        },
      });
      return false;
    }
    world.events.push({
      kind: "explosion",
      ownerId: grenade.ownerId,
      actionInstanceId: grenade.actionInstanceId,
      markerIndex: 0,
      source: {
        definitionId: grenade.definitionId,
        spawnTick: grenade.spawnTick,
        sourceId: grenade.id,
      },
      position,
      impact: null,
      targetId: null,
    });
    impacts.push(
      ...explosionHits(grenade, definition, position, GRENADE_PROFILE.radius, terrain, hurtboxes),
    );
    return false;
  });
  if (world.projectiles.length + world.grenades.length + world.strikes.length > 256)
    throw new Error("Attack entity budget requires recovery");
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
      a.sourceId - b.sourceId ||
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
    const prop = world.props.find((prop) => prop.id === impact.entityId);
    if (prop) {
      const attack = COMBAT_ATTACKS.get(impact.definitionId);
      if (!attack) throw new Error("Missing prop attack definition");
      if (damageDestructible(prop, impact, attack, tick))
        world.events.push({ ...notice, kind: "prop-destroyed" });
      continue;
    }
    const tank = world.tanks.find((tank) => tank.body.id === impact.entityId);
    if (tank) {
      if (impact.damage > 0 && tank.armor > 0 && tank.invulnerableTicks === 0) {
        tank.armor--;
        tank.invulnerableTicks = TANK_PROFILE.damageProtectionTicks;
        if (tank.armor === 0) {
          releaseCombatTank(world, tank, "destroyed", seatChanges, lifeNotices, index, frame);
          world.events.push({ ...notice, kind: "killed" });
        }
      }
      continue;
    }
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
    if (target && target.health > 0) activateTarget(target.enemy.body.id);
    if (target?.guard && target.health > 0 && impact.kind === "shield") {
      const definition = COMBAT_ATTACKS.get(impact.definitionId);
      if (!definition) throw new Error("Unknown shield damage definition");
      const damage = damageShield(
        target.guard,
        definition,
        tick,
        world.nextActionId,
        COMBAT_CATALOG,
        SHIELD_PROFILE,
      );
      target.guard = damage.state;
      world.nextActionId = damage.nextActionId;
      if (damage.broken) world.events.push({ ...notice, kind: "shield-break" });
      appendShieldMarkers(world, target, damage.markers);
    }
    if (!target || target.health === 0 || impact.damage === 0) continue;
    target.health = Math.max(0, target.health - impact.damage);
    if (target.health === 0) {
      target.enemy.life = "removed";
      if (target.rifle) cancelRifle(target.rifle);
      if (target.guard) cancelShield(target.guard);
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
  const geometryRevision = combatGeometryRevision(world.props);
  if (geometryRevision !== frame.geometryRevision) {
    const removed = new Set(world.props.filter((prop) => prop.health === 0).map((prop) => prop.id));
    for (const actor of world.players) {
      const detached = detachDestroyedSupport(actor.body, removed);
      actor.geometryRevision = geometryRevision;
      if (detached && actor.locomotion !== "seated") actor.locomotion = "airborne";
      if (actor.ignoredSupportId !== null && removed.has(actor.ignoredSupportId)) {
        actor.ignoredSupportId = null;
        actor.ignoredSupportTicks = 0;
      }
    }
    for (const { enemy } of world.targets) {
      detachDestroyedSupport(enemy.body, removed);
      enemy.geometryRevision = geometryRevision;
    }
    for (const tank of world.tanks) detachDestroyedSupport(tank.body, removed);
    for (const grenade of world.grenades) detachDestroyedSupport(grenade.body, removed);
  }
  for (const [slot, actor] of world.players.entries()) {
    // The range's authored lower kill boundary resolves real falls, not a client death command.
    if (
      actor.life !== "alive" ||
      actor.body.y <= (stage?.fallBoundary ?? COMBAT_ENTRY.fallBoundary)
    )
      continue;
    const death = damagePlayer(actor, tick, 1, "classic", "fall");
    world.players[slot] = death.actor;
    if (death.notice) lifeNotices.push(death.notice);
  }
  world.strikes = world.strikes.filter((strike) =>
    world.players.some(
      (player) =>
        player.playerId === strike.ownerId &&
        player.life === "alive" &&
        player.action.actionInstanceId === strike.actionInstanceId,
    ),
  );
  for (const area of world.areas) {
    const profile = AREA_PROFILES.get(area.definitionId);
    if (!profile) throw new Error("Missing area cancellation policy");
    if (!combatAreaAnchor(world, area)) cancelArea(area, tick, profile);
  }
  world.encounter = lifecycle(world).step(
    world.encounter,
    tick,
    encounterEvents,
    world.targets
      .filter(
        (target) => target.health > 0 && (active(target) || activatedIds.has(target.enemy.body.id)),
      )
      .map((target) => ({
        id: target.enemy.body.id,
        progressKey: canonical([
          target.enemy.body.x,
          target.enemy.body.y,
          target.enemy.body.vx,
          target.enemy.body.vy,
          target.enemy.body.supportId,
          target.enemy.facing,
        ]),
        unreachable: false,
      })),
    "throw",
  ).state;
  const seatEvents = commitCombatSeats(current, world, seatChanges);
  return { state: world, outcomes, lifeNotices, seatEvents, impacts };
}
export interface CombatRecording {
  format: 9;
  scenario: CombatScenario;
  players: number;
  commands: CombatCommand[][];
  finalState: string;
}
/** Optional inspector observations are isolated copies and cannot mutate the replay. */
export function replayCombatLab(recording: CombatRecording, observe?: (world: CombatLab) => void) {
  if (
    recording.format !== 9 ||
    !Array.isArray(recording.commands) ||
    recording.commands.length > COMBAT_LAB_LIMIT
  )
    throw new Error("Invalid combat recording");
  let world = createCombatLab(recording.scenario, recording.players);
  observe?.(structuredClone(world));
  for (const commands of recording.commands) {
    world = stepCombatLab(world, commands);
    observe?.(structuredClone(world));
  }
  if (canonical(world) !== recording.finalState) throw new Error("Combat replay diverged");
  return world;
}

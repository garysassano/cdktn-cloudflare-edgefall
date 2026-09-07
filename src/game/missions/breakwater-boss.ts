import type { HurtTarget, Impact } from "../combat/projectile.js";
import { nextCounter, pixels } from "../core/numeric.js";
import type { CombatLab, CombatNotice } from "../labs/combat.js";
import { BREAKWATER } from "./breakwater-content.js";

export interface LockEngine {
  health: number;
  phase: "dormant" | "windup" | "burst" | "recovery" | "destroyed";
  phaseStartTick: number;
  actionInstanceId: number;
  destroyedTick: number | null;
  killerId: number | null;
}
export function initialLockEngine(players: number): LockEngine {
  return {
    health: BREAKWATER.boss.baseHealth + BREAKWATER.boss.healthPerPlayer * players,
    phase: "dormant",
    phaseStartTick: 0,
    actionInstanceId: 0,
    destroyedTick: null,
    killerId: null,
  };
}
/** The closed machinery occludes every material; its front aperture admits damage during recovery. */
export function lockEngineHurtboxes(boss: LockEngine): HurtTarget[] {
  if (boss.phase === "dormant" || boss.phase === "destroyed") return [];
  const definition = BREAKWATER.boss;
  const box = (
    id: number,
    kind: HurtTarget["kind"],
    x: number,
    y: number,
    w: number,
    h: number,
  ): HurtTarget => ({
    id,
    entityId: definition.id,
    team: 2,
    kind,
    rect: { x: pixels(definition.x + x), y: pixels(definition.y + y), w: pixels(w), h: pixels(h) },
    delta: { x: 0, y: 0 },
  });
  if (boss.phase !== "recovery") return [box(1200, "shield", -56, -88, 112, 88)];
  return [
    box(1200, "shield", -56, -88, 112, 54),
    box(1201, "shield", -56, -14, 112, 14),
    box(1202, "shield", -30, -34, 86, 20),
    box(
      1203,
      "body",
      definition.weakPoint.x,
      definition.weakPoint.y,
      definition.weakPoint.w,
      definition.weakPoint.h,
    ),
  ];
}
/** Begin and emit before the common combat boundary; the new projectile moves on the next tick. */
export function advanceLockEngine(
  boss: LockEngine,
  world: CombatLab,
  leadX: number,
): CombatNotice[] {
  const tick = world.tick + 1,
    definition = BREAKWATER.boss;
  if (boss.phase === "destroyed") return [];
  const begin = (phase: LockEngine["phase"]) => {
    boss.phase = phase;
    boss.phaseStartTick = tick;
    if (phase === "windup") {
      boss.actionInstanceId = world.nextActionId;
      world.nextActionId = nextCounter(world.nextActionId);
    }
  };
  if (boss.phase === "dormant") {
    if (leadX < pixels(definition.activateX)) return [];
    begin("windup");
  }
  const age = tick - boss.phaseStartTick;
  if (boss.phase === "windup" && age >= definition.windup) begin("burst");
  else if (boss.phase === "burst" && age >= definition.burst) begin("recovery");
  else if (boss.phase === "recovery" && age >= definition.recovery) begin("windup");
  const shot = definition.shotOffsets.indexOf((tick - boss.phaseStartTick) as 0 | 15 | 30 | 45);
  if (boss.phase !== "burst" || shot < 0) return [];
  if (world.projectiles.length >= 256) throw new Error("Boss projectile budget exhausted");
  const position = {
    x: pixels(definition.x + definition.muzzle.x),
    y: pixels(definition.y + definition.muzzle.y),
  };
  world.projectiles.push({
    id: world.nextEntityId,
    ownerId: definition.id,
    team: 2,
    actionInstanceId: boss.actionInstanceId,
    definitionId: 3,
    position,
    velocity: { x: -pixels(3), y: 0 },
    spawnTick: tick,
  });
  world.nextEntityId = nextCounter(world.nextEntityId);
  return [
    {
      kind: "shot",
      ownerId: definition.id,
      actionInstanceId: boss.actionInstanceId,
      markerIndex: shot,
      source: { definitionId: 3, timelineId: 0, stateStartTick: boss.phaseStartTick },
      position,
      impact: null,
      targetId: null,
    },
  ];
}
export function damageLockEngine(
  boss: LockEngine,
  impacts: readonly Impact[],
  tick: number,
): CombatNotice[] {
  const notices: CombatNotice[] = [];
  for (const impact of impacts) {
    if (
      boss.health === 0 ||
      boss.phase !== "recovery" ||
      impact.entityId !== BREAKWATER.boss.id ||
      impact.kind !== "body" ||
      impact.damage <= 0
    )
      continue;
    boss.health = Math.max(0, boss.health - impact.damage);
    if (boss.health === 0) {
      boss.phase = "destroyed";
      boss.phaseStartTick = boss.destroyedTick = tick;
      boss.killerId = impact.ownerId;
      notices.push({
        kind: "killed",
        ownerId: impact.ownerId,
        actionInstanceId: impact.actionInstanceId,
        markerIndex: 0,
        source: null,
        position: impact.position,
        impact,
        targetId: BREAKWATER.boss.id,
      });
    }
  }
  return notices;
}

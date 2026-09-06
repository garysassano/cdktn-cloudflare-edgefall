import { type GroundedEnemy, stepGroundedEnemy } from "../actors/grounded.js";
import { type FootIntent, type FootStep, stepFootController } from "../controller/foot.js";
import { canonical } from "../core/canonical.js";
import { integer, pixels } from "../core/numeric.js";
import { HELD_MASK } from "../input/types.js";
import { CollisionGrid, CollisionIndex } from "../physics/grid.js";
import type { SweepTarget } from "../physics/sweep.js";
import type { ControlledActor } from "../state.js";
import { FOOT_DEFINITION, FOOT_SHAPES, footActor, footTerrain } from "./foot-fixture.js";

export const LAB_SCENARIOS = ["course", "moving-support", "crush", "enemy-ledge"] as const;
export type LabScenario = (typeof LAB_SCENARIOS)[number];
export const LAB_LIMIT = 3600;
export interface LabCommand extends FootIntent {
  removePlatform: boolean;
}
export interface LabState {
  scenario: LabScenario;
  tick: number;
  geometryRevision: number;
  removed: boolean;
  actor: ControlledActor;
  enemy: GroundedEnemy | null;
  resolvedEnemies: Array<{ id: number; reason: "crushed" | "out-of-bounds" }>;
  terrain: SweepTarget[];
  result: FootStep | null;
  stopped: string | null;
}
export interface LabRecording {
  format: 2;
  scenario: LabScenario;
  commands: LabCommand[];
  finalState: string;
}

function geometry(scenario: LabScenario, tick: number, removed: boolean): SweepTarget[] {
  if (scenario === "course")
    return [
      footTerrain(100, 0, 300, 230, 40),
      footTerrain(101, 280, 300, 360, 40),
      footTerrain(102, 130, 265, 70, 10),
      footTerrain(103, 340, 250, 90, 6, "one-way"),
      footTerrain(104, 465, 235, 12, 65),
      footTerrain(105, 560, 270, 80, 12),
    ];
  if (scenario === "crush")
    return [
      footTerrain(100, 0, 300, 640, 40),
      {
        ...footTerrain(110, 260, 210 + Math.min(tick, 65), 120, 12),
        delta: { x: 0, y: tick < 65 ? pixels(1) : 0 },
      },
    ];
  if (scenario === "enemy-ledge")
    return [
      footTerrain(100, 0, 300, 640, 40),
      ...(removed ? [] : [footTerrain(110, 200, 230, 160, 8)]),
    ];
  const phase = tick % 240;
  const x = 200 + (phase <= 120 ? phase : 240 - phase);
  const nextPhase = (tick + 1) % 240;
  const nextX = 200 + (nextPhase <= 120 ? nextPhase : 240 - nextPhase);
  return [
    footTerrain(100, 0, 300, 640, 40),
    ...(removed
      ? []
      : [
          { ...footTerrain(110, x, 230, 100, 8, "one-way"), delta: { x: pixels(nextX - x), y: 0 } },
        ]),
  ];
}
export function createControllerLab(scenario: LabScenario): LabState {
  if (!LAB_SCENARIOS.includes(scenario)) throw new Error("Unknown lab scenario");
  const actor = footActor(
    scenario === "course" ? 60 : scenario === "crush" ? 320 : 240,
    scenario === "moving-support" ? 230 : 300,
  );
  if (scenario === "moving-support") actor.body.supportId = 110;
  const enemyBody = footActor(240, 230).body;
  enemyBody.id = 2;
  enemyBody.supportId = 110;
  return {
    scenario,
    tick: 0,
    geometryRevision: 1,
    removed: false,
    actor,
    enemy:
      scenario === "enemy-ledge"
        ? {
            body: enemyBody,
            facing: 1,
            geometryRevision: 1,
            life: "alive",
            removalReason: null,
            turns: 0,
          }
        : null,
    resolvedEnemies: [],
    terrain: geometry(scenario, 0, false),
    result: null,
    stopped: null,
  };
}
export function stepControllerLab(state: LabState, command: LabCommand): LabState {
  if (state.stopped) return state;
  integer(command.held, 0, HELD_MASK, "lab held");
  if (typeof command.jumpPressed !== "boolean" || typeof command.removePlatform !== "boolean")
    throw new Error("Invalid lab command");
  if (!FOOT_DEFINITION) throw new Error("Missing lab actor definition");
  const removed =
    state.removed ||
    ((state.scenario === "moving-support" || state.scenario === "enemy-ledge") &&
      command.removePlatform);
  const revision = state.geometryRevision + Number(removed !== state.removed);
  const terrain = geometry(state.scenario, state.tick, removed);
  const frame = { tick: state.tick + 1, geometryRevision: revision };
  const index = new CollisionIndex(
    new CollisionGrid(terrain.filter((t) => t.delta.x === 0 && t.delta.y === 0)),
    terrain.filter((t) => t.delta.x !== 0 || t.delta.y !== 0),
    frame,
  );
  const result = stepFootController(
    { ...state.actor, geometryRevision: revision },
    command,
    FOOT_DEFINITION,
    FOOT_SHAPES,
    index,
    frame,
  );
  const actor = result.status === "complete" ? result.actor : state.actor;
  let enemy = state.enemy;
  let enemyFailure: string | null = null;
  const resolvedEnemies = [...state.resolvedEnemies];
  if (enemy) {
    const shape = FOOT_SHAPES.get(enemy.body.shapeId);
    if (!shape) throw new Error("Missing enemy shape");
    const enemyStep = stepGroundedEnemy(
      { ...enemy, geometryRevision: revision },
      {
        speed: pixels(1),
        gravity: FOOT_DEFINITION.gravity,
        terminalVelocity: FOOT_DEFINITION.terminalVelocity,
        bounds: { x: pixels(-30), y: pixels(-80), w: pixels(700), h: pixels(470) },
      },
      shape,
      index,
      frame,
    );
    if (enemyStep.status === "failed") enemyFailure = `enemy-${enemyStep.physics.reason}`;
    else {
      enemy = enemyStep.enemy;
      if (
        enemy.removalReason &&
        !resolvedEnemies.some((resolved) => resolved.id === enemy?.body.id)
      )
        resolvedEnemies.push({ id: enemy.body.id, reason: enemy.removalReason });
    }
  }
  const stopped =
    enemyFailure ??
    (result.status === "failed"
      ? result.physics.reason
      : actor.body.y > pixels(390)
        ? "kill-bound"
        : frame.tick >= LAB_LIMIT
          ? "recording-limit"
          : null);
  return {
    ...state,
    tick: frame.tick,
    geometryRevision: revision,
    removed,
    actor,
    enemy,
    resolvedEnemies,
    terrain: geometry(state.scenario, frame.tick, removed),
    result,
    stopped,
  };
}
export function labFingerprint(state: LabState): string {
  return canonical({
    scenario: state.scenario,
    tick: state.tick,
    geometryRevision: state.geometryRevision,
    removed: state.removed,
    actor: state.actor,
    enemy: state.enemy,
    resolvedEnemies: state.resolvedEnemies,
    stopped: state.stopped,
  });
}
export function replayControllerLab(recording: LabRecording): LabState {
  if (
    recording.format !== 2 ||
    !Array.isArray(recording.commands) ||
    recording.commands.length > LAB_LIMIT
  )
    throw new Error("Invalid lab recording");
  let state = createControllerLab(recording.scenario);
  for (const command of recording.commands) {
    if (state.stopped) throw new Error("Recording continues after stop");
    state = stepControllerLab(state, command);
  }
  if (labFingerprint(state) !== recording.finalState) throw new Error("Lab replay diverged");
  return state;
}

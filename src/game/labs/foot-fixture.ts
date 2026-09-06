import { CONTRACT_FIXTURE } from "../content/contract-fixture.js";
import { pixels } from "../core/numeric.js";
import type { SweepTarget } from "../physics/sweep.js";
import type { ControlledActor } from "../state.js";

export const FOOT_SHAPES = new Map(CONTRACT_FIXTURE.shapes.map((shape) => [shape.id, shape]));
export const FOOT_DEFINITION = CONTRACT_FIXTURE.actors[0];
if (!FOOT_DEFINITION) throw new Error("Missing foot fixture definition");

export function footActor(x = 0, y = 0): ControlledActor {
  return {
    body: {
      id: 1,
      x: pixels(x),
      y: pixels(y),
      vx: 0,
      vy: 0,
      remainderX: 0,
      remainderY: 0,
      shapeId: 1,
      supportId: 100,
      grounded: true,
      contacts: [],
    },
    playerId: 1,
    slot: 0,
    controlEpoch: 1,
    life: "alive",
    locomotion: "grounded",
    action: {
      kind: "ready",
      actionInstanceId: 0,
      stateStartTick: 0,
      definitionId: 0,
      nextMarkerIndex: 0,
    },
    facing: 1,
    aim: 0,
    jumpBufferTicks: 0,
    coyoteTicks: 4,
    ignoredSupportId: null,
    ignoredSupportTicks: 0,
    invulnerableTicks: 0,
    reboardCooldownTicks: 0,
    vehicleSpecialTicks: 0,
    vehicleId: null,
    weapon: { id: "sidearm", ammo: 0, cooldownTicks: 0, shotOrdinal: 0, lastActionInstanceId: 0 },
    grenadeStock: 10,
    grenadeCooldownTicks: 0,
    meleeCooldownTicks: 0,
    geometryRevision: 1,
    health: 1,
    lives: 3,
    lastRallyMission: 0,
    processedEdgeIds: [0, 0, 0, 0, 0],
  };
}
export function footTerrain(
  id: number,
  x: number,
  y: number,
  w: number,
  h: number,
  kind: SweepTarget["kind"] = "solid",
): SweepTarget {
  return {
    id,
    rect: { x: pixels(x), y: pixels(y), w: pixels(w), h: pixels(h) },
    kind,
    delta: { x: 0, y: 0 },
  };
}
export const FOOT_FLOOR = footTerrain(100, -200, 0, 400, 16);

import artifact from "../../game/content/compiled/navigation.json" with { type: "json" };
import type { ActorDefinition, ShapeDefinition } from "../../game/content/schema.js";
import { stepFootController } from "../../game/controller/foot.js";
import { Edge, type EdgeResult, type InputCommand } from "../../game/input/types.js";
import { footActor } from "../../game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../../game/physics/grid.js";
import type { SweepTarget } from "../../game/physics/sweep.js";
import type { ControlledActor } from "../../game/state.js";
import { PROBE_IDENTITY, createRoomWorkload } from "./room-workload.js";

/** Real content/media identity; simulation provenance remains explicitly local-probe-only. */
export const CONTROLLER_IDENTITY = {
  ...PROBE_IDENTITY,
  contentHash: artifact.contentHash,
  presentationBuild: artifact.graphicsHash,
};
export const CONTROLLER_TERRAIN = artifact.gameplay.terrain as SweepTarget[];
const shapes = new Map<number, ShapeDefinition>(
  artifact.gameplay.definitions.shapes.map((s) => [s.id, s]),
);
const definition = artifact.gameplay.definitions.actors.find(
  (a) => a.id === artifact.gameplay.entry.actorId,
) as ActorDefinition | undefined;
if (!definition) throw new Error("Missing compiled controller definition");
const grid = new CollisionGrid(CONTROLLER_TERRAIN);
export function createControllerWorkload() {
  const world = createRoomWorkload(1);
  world.players = Array.from(
    { length: 4 },
    (_, slot) =>
      ({
        ...footActor(),
        ...structuredClone(artifact.gameplay.entry.actor),
        playerId: slot + 1,
        slot,
        controlEpoch: 1,
        body: {
          ...structuredClone(artifact.gameplay.entry.actor.body),
          id: slot + 1,
          x: artifact.gameplay.entry.actor.body.x + slot * 3 * 256,
        },
      }) as ControlledActor,
  );
  world.enemies = [];
  world.projectiles = [];
  world.platforms = [];
  world.vehicles = [];
  world.threats = [];
  world.campaign.remainingEnemies = 0;
  return world;
}
/** Used identically by the room adapter and browser prediction; one command advances one tick. */
export function stepNetworkController(actor: ControlledActor, command: InputCommand, tick: number) {
  if (!definition || command.controlEpoch !== actor.controlEpoch)
    throw new Error("Controller epoch/policy mismatch");
  const frame = { tick, geometryRevision: 1 };
  const result = stepFootController(
    actor,
    { held: command.held, jumpPressed: command.edges.some((e) => e.kind === Edge.Jump) },
    definition,
    shapes,
    new CollisionIndex(grid, [], frame),
    frame,
  );
  if (result.status === "failed") throw new Error(`Controller physics: ${result.physics.reason}`);
  const next = result.actor;
  next.processedEdgeIds = [...actor.processedEdgeIds];
  for (const edge of command.edges) next.processedEdgeIds[edge.kind - 1] = edge.id;
  if (next.body.y > 390 * 256) next.life = "death";
  let jumpHandled = false;
  const edges: EdgeResult[] = command.edges.map((edge) => {
    const applied =
      edge.kind === Edge.Jump &&
      !jumpHandled &&
      result.status === "complete" &&
      (result.jumpRequest === "consumed" || result.jumpRequest === "buffered");
    if (edge.kind === Edge.Jump) jumpHandled = true;
    return { ...edge, outcome: applied ? "applied" : "unavailable" };
  });
  return { actor: next, edges };
}

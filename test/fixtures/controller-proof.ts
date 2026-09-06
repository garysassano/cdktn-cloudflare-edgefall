import { stepFootController } from "../../src/game/controller/foot.js";
import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import { Held } from "../../src/game/input/types.js";
import { CollisionGrid, CollisionIndex } from "../../src/game/physics/grid.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import type { FullSnapshot, SnapshotContext } from "../../src/shared/protocol/snapshot-schema.js";
import {
  FOOT_DEFINITION,
  FOOT_FLOOR,
  FOOT_SHAPES,
  footActor,
  footTerrain,
} from "./foot-fixture.js";

/** Normalized input and boundary-event fixture, not the production room or browser mapper. */
export function controllerProof(restoreAfterTick?: number) {
  if (!FOOT_DEFINITION) throw new Error("Missing controller definition");
  let actor = footActor(-10, -30);
  actor.body.supportId = 101;
  const fixed = new CollisionGrid([
    FOOT_FLOOR,
    footTerrain(102, -210, -180, 10, 196),
    footTerrain(103, 200, -180, 10, 196),
    footTerrain(104, -40, -130, 80, 8),
  ]);
  const platform = footTerrain(101, -60, -30, 120, 8, "one-way");
  let traceHash = "00000000";
  let encodedBytes = 0;
  let jumpEdges = 0;
  const counts = { jump: 0, drop: 0, land: 0, "leave-support": 0 };
  const checkpoints: Array<{
    tick: number;
    hash: string;
    x: number;
    y: number;
    shapeId: number;
    supportId: number | null;
    geometryRevision: number;
  }> = [];
  for (let tick = 1; tick <= 1200; tick++) {
    const geometryRevision = tick < 900 ? 1 : 2;
    // The external world applies a topology revision before stepping its actors.
    actor.geometryRevision = geometryRevision;
    platform.delta.x = pixels(Math.floor((tick - 1) / 60) % 2 === 0 ? 1 : -1);
    const index = new CollisionIndex(fixed, tick < 900 ? [platform] : [], {
      tick,
      geometryRevision,
    });
    const phase = tick % 240;
    const held =
      tick < 60
        ? 0
        : tick < 100
          ? Held.Down
          : phase < 100
            ? Held.Right
            : phase < 200
              ? Held.Left
              : Held.Down;
    const jumpPressed = tick === 60 || (tick >= 100 && tick % 45 === 10);
    const result = stepFootController(
      actor,
      { held, jumpPressed },
      FOOT_DEFINITION,
      FOOT_SHAPES,
      index,
      { tick, geometryRevision },
    );
    if (result.status !== "complete")
      throw new Error(`Controller proof tick ${tick}: ${JSON.stringify(result)}`);
    actor = result.actor;
    // Edge cursors belong to the world/admission owner, not the movement component.
    if (jumpPressed) actor.processedEdgeIds[0] = ++jumpEdges;
    for (const event of result.events) counts[event.kind]++;
    platform.rect.x += platform.delta.x;
    const snapshot: FullSnapshot = {
      runEpoch: 1,
      connectionEpoch: 2,
      snapshotId: tick,
      tick,
      baselineEventCursor: 0,
      geometryRevision,
      stateHash: Number.parseInt(stateHash({ actor, geometryRevision, tick }), 16),
      roomMode: "playing",
      camera: { x: 0, y: 0 },
      campaign: {
        ruleset: "classic",
        mission: 1,
        checkpointId: 1,
        continuesRemaining: 3,
        continuesUsed: 0,
        phase: "playing",
        encounterId: 1,
        remainingEnemies: 0,
      },
      acknowledgments: [
        {
          playerId: 1,
          connectionEpoch: 2,
          controlEpoch: 1,
          lastProcessedSequence: tick,
          appliedAtServerTick: tick,
          processedEdgeIds: [...actor.processedEdgeIds],
        },
      ],
      players: [actor],
      vehicles: [],
      enemies: [],
      projectiles: [],
      threats: [],
      platforms:
        tick < 900
          ? [
              {
                id: 101,
                x: platform.rect.x,
                y: platform.rect.y,
                vx: platform.delta.x,
                vy: 0,
                shapeId: 7,
                trajectoryId: 1,
                trajectoryTick: tick,
              },
            ]
          : [],
      removedIds: tick < 900 ? [] : [101],
    };
    const context: SnapshotContext = {
      runEpoch: 1,
      connectionEpoch: 2,
      playerId: 1,
      geometryRevision,
      shapeIds: new Set([1, 2, 3, 4, 5, 6, 7]),
    };
    const encoded = encodeSnapshot(snapshot, context);
    const decoded = decodeSnapshot(encoded, context);
    const restored = decoded.players[0];
    if (!restored || canonical(restored) !== canonical(actor))
      throw new Error(`Controller snapshot mismatch at ${tick}`);
    encodedBytes += encoded.byteLength;
    traceHash = stateHash({ previous: traceHash, snapshot: decoded, events: result.events });
    if (tick % 60 === 0 || [599, 601, 899, 901].includes(tick))
      checkpoints.push({
        tick,
        hash: traceHash,
        x: actor.body.x,
        y: actor.body.y,
        shapeId: actor.body.shapeId,
        supportId: actor.body.supportId,
        geometryRevision,
      });
    if (tick === restoreAfterTick) {
      actor = restored;
      jumpEdges = actor.processedEdgeIds[0];
    }
  }
  return { ticks: 1200, traceHash, encodedBytes, jumpEdges, counts, checkpoints };
}

export function controllerBoundaryProof() {
  const definition = FOOT_DEFINITION;
  if (!definition) throw new Error("Missing controller definition");
  const run = (
    actor: ReturnType<typeof footActor>,
    terrain: ReturnType<typeof footTerrain>[],
    tick: number,
    jumpPressed = false,
  ) => {
    const frame = { tick, geometryRevision: actor.geometryRevision };
    const index = new CollisionIndex(
      new CollisionGrid(terrain.filter((target) => target.delta.x === 0 && target.delta.y === 0)),
      terrain.filter((target) => target.delta.x !== 0 || target.delta.y !== 0),
      frame,
    );
    const result = stepFootController(
      actor,
      { held: 0, jumpPressed },
      definition,
      FOOT_SHAPES,
      index,
      frame,
    );
    if (result.status !== "complete")
      throw new Error(`Boundary controller failure: ${JSON.stringify(result)}`);
    return result;
  };
  const roof = footTerrain(101, -20, -40, 40, 15);
  const crouched = footActor();
  crouched.body.shapeId = 2;
  crouched.locomotion = "crouched";
  const blockedStand = run(crouched, [FOOT_FLOOR, roof], 1);
  const clearanceJump = run(
    blockedStand.actor,
    [FOOT_FLOOR, { ...roof, delta: { x: 0, y: pixels(-20) } }],
    2,
    true,
  );
  const risen = { ...roof, rect: { ...roof.rect, y: roof.rect.y - pixels(20) } };
  const airborne = run(clearanceJump.actor, [FOOT_FLOOR, risen], 3);
  const carrier = { ...FOOT_FLOOR, delta: { x: pixels(2), y: 0 } };
  const carried = run(footActor(), [carrier], 1);
  const removal = run({ ...carried.actor, geometryRevision: 2 }, [], 2);
  const cases = [
    { name: "blocked-stand", result: blockedStand },
    { name: "end-clearance-jump", result: clearanceJump },
    { name: "buffered-airborne", result: airborne },
    { name: "carried", result: carried },
    { name: "removed-support", result: removal },
  ];
  return { cases, traceHash: stateHash(cases) };
}

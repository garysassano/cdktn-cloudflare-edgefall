import { stateHash } from "../../src/game/core/canonical.js";
import { type AppliedInput, Edge, Held, type InputCommand } from "../../src/game/input/types.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import type { FullSnapshot, SnapshotContext } from "../../src/shared/protocol/snapshot-schema.js";
import { collisionProof } from "./collision-proof.js";
import { controllerBoundaryProof, controllerProof } from "./controller-proof.js";
import { groundedProof, seamProof } from "./grounded-proof.js";
import { movementProof, movingCasesProof } from "./movement-proof.js";
import { navigationProof } from "./navigation-proof.js";
import goldens from "./protocol-v3/snapshot-golden.json" with { type: "json" };
import { spatialProof } from "./spatial-proof.js";
import { traversalProof } from "./traversal-proof.js";

/** Portable conformance workload, not a substitute for the future movement/combat simulation. */
export function contractProof() {
  const context: SnapshotContext = {
    runEpoch: 1,
    connectionEpoch: 2,
    playerId: 1,
    geometryRevision: 7,
    shapeIds: new Set([1, 2, 3, 4]),
  };
  const snapshots = goldens.map((golden) => {
    const bytes = encodeSnapshot(golden.snapshot as FullSnapshot, context);
    const decoded = decodeSnapshot(bytes, context);
    return {
      name: golden.name,
      hex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
      stateHash: stateHash(decoded),
    };
  });
  const stream = new InputStream({
    runEpoch: 1,
    connectionEpoch: 2,
    playerId: 1,
    controlEpoch: 2,
    baselineServerTick: 100,
  });
  const command: InputCommand = {
    sequence: 1,
    clientTick: 0,
    controlEpoch: 2,
    held: Held.Right | Held.Fire,
    aim: 0,
    edges: [
      { kind: Edge.Jump, id: 1 },
      { kind: Edge.FireOnset, id: 1 },
    ],
  };
  const packet = encodeInputBatch({
    runEpoch: 1,
    connectionEpoch: 2,
    packetSequence: 1,
    snapshotAck: 0,
    eventAck: 0,
    commands: [command],
  });
  const admitted = stream.receive(packet, 0, 100);
  const process = (input: AppliedInput) =>
    input.command.edges.map((edge) => ({
      ...edge,
      outcome: edge.kind === Edge.FireOnset ? ("cooldown" as const) : ("applied" as const),
    }));
  const trace = [stream.processTick(101, 16, process)];
  const duplicate = stream.receive(packet, 100, 101);
  trace.push(stream.processTick(102, 200, process), stream.processTick(103, 250, process));
  return {
    snapshots,
    admitted,
    duplicate,
    trace,
    collision: collisionProof(),
    movement: movementProof(),
    controller: controllerProof(),
    grounded: groundedProof(),
    restoredGrounded: groundedProof(600),
    seams: seamProof(),
    navigation: navigationProof(),
    traversal: traversalProof(),
    controllerBoundaries: controllerBoundaryProof(),
    restoredController: controllerProof(599),
    spatial: spatialProof(),
    indexedMovement: ([32, 64] as const).map((cellPixels) => ({
      cellPixels,
      ...movementProof(undefined, cellPixels),
    })),
    movingCases: movingCasesProof(),
    restoredMovement: [239, 601, 899].map((tick) => ({
      restoredAfterTick: tick,
      ...movementProof(tick),
    })),
  };
}

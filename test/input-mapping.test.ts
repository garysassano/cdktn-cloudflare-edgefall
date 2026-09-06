import { describe, expect, it } from "vitest";
import {
  createControllerWorkload,
  stepNetworkController,
} from "../src/shared/diagnostics/controller-workload.js";
import { ControllerPrediction } from "../src/shared/prediction/controller.js";
import { decodeInputMapping, mappingForSnapshot } from "../src/shared/protocol/input-mapping.js";
import { mappedPredictionProof } from "./fixtures/mapped-prediction-proof.js";

function fixture() {
  const world = createControllerWorkload();
  const actor = world.players[0],
    acknowledgment = world.acknowledgments[0];
  if (!actor || !acknowledgment) throw new Error("Missing actor");
  const baseline = {
    runEpoch: 1,
    connectionEpoch: 1,
    tick: 0,
    snapshotId: world.snapshotId,
    actor,
    acknowledgment,
  };
  const mapping = mappingForSnapshot(world, 1);
  const prediction = new ControllerPrediction(
    baseline,
    (a, c, t) => stepNetworkController(a, c, t).actor,
    mapping,
  );
  return { world, baseline, mapping, prediction };
}
const command = {
  sequence: 1,
  clientTick: 0,
  controlEpoch: 1,
  held: 0,
  aim: 0 as const,
  edges: [],
};
describe("authoritative input mapping", () => {
  it("replays a delayed jump after the authoritative held-repeat tick without duplicating it", () => {
    const proof = mappedPredictionProof();
    expect(proof.applied).toEqual([
      { tick: 1, sequence: 1, repeated: false },
      { tick: 2, sequence: 0, repeated: true },
      { tick: 3, sequence: 2, repeated: false },
    ]);
    expect(proof.mapping).toMatchObject({ snapshotTick: 3, nextSequence: 3, nextCommandTick: 4 });
    expect(proof.replayed).toBe(1);
    expect(proof.predictedTick).toBe(4);
    expect(proof.edgeCursor).toBe(1);
  });
  it("rejects mappings for a different owner, snapshot or command prefix", () => {
    for (const field of [
      "playerId",
      "connectionEpoch",
      "runEpoch",
      "snapshotId",
      "nextSequence",
    ] as const) {
      const { baseline, mapping, prediction } = fixture();
      expect(() =>
        prediction.reconcile(baseline, { ...mapping, [field]: mapping[field] + 1 }),
      ).toThrow();
      expect(prediction.requiresResync).toBe(true);
    }
  });
  it("does not silently fall back to an old mapping when the paired frame is missing", () => {
    const { baseline, prediction } = fixture();
    expect(() => prediction.reconcile(baseline)).toThrow(/Missing/);
  });
  it("requires a fresh baseline when pending input drifts beyond the bounded adjustment", () => {
    const { baseline, mapping, prediction } = fixture();
    prediction.submit(command);
    expect(() =>
      prediction.reconcile(
        { ...baseline, tick: 7 },
        { ...mapping, snapshotTick: 7, nextCommandTick: 8 },
      ),
    ).toThrow(/fresh baseline/);
  });
  it("keeps a stopped-input observer synchronized but requires reset before it resumes capture", () => {
    const { baseline, mapping, prediction } = fixture();
    prediction.reconcile(
      { ...baseline, tick: 100 },
      { ...mapping, snapshotTick: 100, nextCommandTick: 101 },
    );
    expect(prediction.tick).toBe(100);
    expect(() => prediction.submit(command)).toThrow(/fresh baseline/);
  });
  it("bounds and validates mapping control frames", () => {
    const { mapping } = fixture();
    expect(decodeInputMapping(JSON.stringify(mapping))).toEqual(mapping);
    for (const raw of [
      "x".repeat(513),
      "null",
      "[]",
      "{",
      JSON.stringify({ ...mapping, extra: 1 }),
      JSON.stringify({ ...mapping, nextCommandTick: 0 }),
      JSON.stringify({ ...mapping, nextSequence: 1.5 }),
    ])
      expect(() => decodeInputMapping(raw)).toThrow();
  });
});

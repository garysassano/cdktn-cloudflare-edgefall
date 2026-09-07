import { describe, expect, it } from "vitest";
import { COUNTER_LIMIT } from "../src/game/core/numeric.js";
import { Edge } from "../src/game/input/types.js";
import { InputCapture, inputSequenceLimit } from "../src/shared/input/capture.js";
import { inputFlowProof } from "./fixtures/input-flow-proof.js";

describe("snapshot-bounded input transport", () => {
  it.each([0, 720])(
    "retains the 127th command and short taps across a room stall from baseline %s",
    (baseline) => {
      const { unsafe, safe } = inputFlowProof(baseline);
      expect(unsafe).toMatchObject({
        status: "rejected",
        tick: baseline + 120,
        rejected: [125, 126, 127],
        priorQueue: 4,
        retainedQueue: 4,
        acknowledgment: { lastProcessedSequence: 120 },
        requiresResync: true,
      });
      expect(unsafe.error).toContain("Client exceeds server-owned input lead");
      expect(safe).toMatchObject({
        firstLimit: 126,
        firstBatch: [125, 126],
        releasedLimit: 129,
        finalTick: baseline + 130,
        commands: 129,
        duplicate: true,
        acknowledgment: { lastProcessedSequence: 129 },
        requiresResync: false,
      });
      expect(safe.released.map((command) => command.sequence)).toEqual([127, 128, 129]);
      expect(safe.released[0]).toEqual(safe.deferred);
      expect(safe.appliedEdges).toEqual([
        { tick: baseline + 127, sequence: 127, kind: Edge.Jump, id: 1 },
        { tick: baseline + 127, sequence: 127, kind: Edge.FireOnset, id: 1 },
      ]);
    },
  );

  it("keeps forced flushes within authority's window without consuming frame tokens while blocked", () => {
    const input = new InputCapture(1);
    for (let index = 0; index < 10; index++) input.capture(0);
    for (let index = 0; index < 20; index++) expect(input.takeBatch(0, 0, true)).toBeNull();
    for (let sequence = 1; sequence <= 10; sequence++)
      expect(input.takeBatch(0, sequence, true)?.map((command) => command.sequence)).toEqual([
        sequence,
      ]);
    expect(input.pending).toBe(0);
  });

  it("uses the issued baseline and validated snapshot, including the reserved counter boundary", () => {
    expect(inputSequenceLimit(720, 720)).toBe(6);
    expect(inputSequenceLimit(720, 723)).toBe(9);
    expect(inputSequenceLimit(COUNTER_LIMIT - 4, COUNTER_LIMIT - 2)).toBe(3);
    expect(() => inputSequenceLimit(720, 719)).toThrow("validated snapshot");
    expect(() => inputSequenceLimit(720, Number.NaN)).toThrow("validated snapshot");
  });

  it("rejects invalid credit without removing retained commands", () => {
    for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, COUNTER_LIMIT]) {
      const input = new InputCapture(1);
      input.capture(0);
      expect(() => input.takeBatch(0, limit, true)).toThrow("send window");
      expect(input.pending).toBe(1);
      expect(input.requiresResync).toBe(true);
    }
  });
});

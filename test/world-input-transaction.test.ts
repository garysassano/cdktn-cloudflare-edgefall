import { describe, expect, it } from "vitest";
import { Edge, Held } from "../src/game/input/types.js";
import { encodeInputBatch } from "../src/shared/protocol/codec.js";
import { InputStream, type PreparedPlayerTick } from "../src/shared/protocol/input-stream.js";
import { worldCombatProof } from "./fixtures/world-combat-proof.js";

function fixture() {
  return Array.from({ length: 4 }, (_, slot) => {
    const stream = new InputStream({
      runEpoch: 1,
      connectionEpoch: slot + 1,
      playerId: slot + 1,
      controlEpoch: 1,
      baselineServerTick: 0,
    });
    stream.receive(
      encodeInputBatch({
        runEpoch: 1,
        connectionEpoch: slot + 1,
        packetSequence: 1,
        snapshotAck: 0,
        eventAck: 0,
        commands: [
          {
            sequence: 1,
            clientTick: 0,
            controlEpoch: 1,
            held: Held.Fire,
            aim: 0,
            edges: [{ kind: Edge.FireOnset, id: 1 }],
          },
        ],
      }),
      0,
      0,
    );
    return stream;
  });
}
function accepted(prepared: readonly PreparedPlayerTick[]) {
  return prepared.map(({ input }) => ({
    playerId: input.playerId,
    edgeResults: input.command.edges.map((edge) => ({ ...edge, outcome: "applied" as const })),
  }));
}
describe("world input transaction", () => {
  it("commits real combat snapshots and preserves the last accepted world when the next tick aborts", () => {
    expect(worldCombatProof()).toMatchObject({
      ticks: 120,
      phase: "complete",
      shots: [15, 24, 15, 15],
      nextActionId: 70,
      abortAtTick: 121,
    });
  });
  it("exposes all normalized inputs before committing any owner and commits in stable player order", () => {
    const streams = fixture();
    const result = InputStream.processWorldTick([...streams].reverse(), 1, 16, (prepared) => {
      expect(prepared.map((item) => item.input.playerId)).toEqual([1, 2, 3, 4]);
      expect(streams.map((stream) => stream.acknowledgment.lastProcessedSequence)).toEqual([
        0, 0, 0, 0,
      ]);
      expect(prepared.map((item) => item.acknowledgment.lastProcessedSequence)).toEqual([
        1, 1, 1, 1,
      ]);
      return { state: { tick: 1, events: ["four shots"] }, outcomes: accepted(prepared).reverse() };
    });
    expect(result.processed.map((item) => item.acknowledgment.lastProcessedSequence)).toEqual([
      1, 1, 1, 1,
    ]);
    expect(streams.map((stream) => stream.queuedCommands)).toEqual([0, 0, 0, 0]);
    expect(result.state.events).toEqual(["four shots"]);
  });
  it.each(["throw", "missing-owner", "last-edge", "duplicate-owner"])(
    "leaves every queue/ack intact and stops the cohort after %s",
    (failure) => {
      const streams = fixture();
      let published = { tick: 0, events: [] as string[] };
      expect(() => {
        const result = InputStream.processWorldTick(streams, 1, 16, (prepared) => {
          const outcomes = accepted(prepared);
          if (failure === "throw") throw new Error("World encoding failed");
          if (failure === "missing-owner") outcomes.pop();
          if (failure === "duplicate-owner" && outcomes[3]) outcomes[3].playerId = 1;
          if (failure === "last-edge" && outcomes[3]) outcomes[3].edgeResults = [];
          return { state: { tick: 1, events: ["unpublished"] }, outcomes };
        });
        published = result.state;
      }).toThrow();
      expect(published).toEqual({ tick: 0, events: [] });
      for (const stream of streams) {
        expect(stream.acknowledgment.lastProcessedSequence).toBe(0);
        expect(stream.queuedCommands).toBe(1);
        expect(stream.requiresResync).toBe(true);
      }
    },
  );
  it("protects staged journal/ack data from callback mutation", () => {
    const streams = fixture();
    const result = InputStream.processWorldTick(streams, 1, 16, (prepared) => {
      const outcomes = accepted(prepared);
      for (const item of prepared) {
        item.input.command.held = 0;
        item.acknowledgment.lastProcessedSequence = 900;
      }
      return { state: null, outcomes };
    });
    expect(
      result.processed.every(
        (item) =>
          item.input.command.held === Held.Fire && item.acknowledgment.lastProcessedSequence === 1,
      ),
    ).toBe(true);
  });
  it("guards other owners from reentrant mutation while evaluating the world", () => {
    const streams = fixture();
    expect(() =>
      InputStream.processWorldTick(streams, 1, 16, () => {
        streams[3]?.setControlEpoch(2);
        return { state: null, outcomes: [] };
      }),
    ).toThrow(/reentered/);
    expect(
      streams.every((stream) => stream.requiresResync && stream.acknowledgment.controlEpoch === 1),
    ).toBe(true);
  });
  it("retains explicit stale edge rejection in a shared transaction", () => {
    const streams = fixture();
    const result = InputStream.processWorldTick(streams, 1, 250, (prepared) => {
      expect(
        prepared.every(
          (item) => item.input.command.held === 0 && item.input.command.edges.length === 0,
        ),
      ).toBe(true);
      return { state: null, outcomes: accepted(prepared) };
    });
    expect(
      result.processed.every(
        (item) =>
          item.edgeResults[0]?.outcome === "stale" && item.acknowledgment.processedEdgeIds[4] === 1,
      ),
    ).toBe(true);
  });
});

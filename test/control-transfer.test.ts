import { describe, expect, it } from "vitest";
import { Edge, Held, type InputCommand } from "../src/game/input/types.js";
import { createControllerWorkload } from "../src/shared/diagnostics/controller-workload.js";
import { InputCapture } from "../src/shared/input/capture.js";
import { ControllerPrediction } from "../src/shared/prediction/controller.js";
import { encodeInputBatch } from "../src/shared/protocol/codec.js";
import { InputStream, type PreparedPlayerTick } from "../src/shared/protocol/input-stream.js";

const command = (sequence: number, controlEpoch = 1): InputCommand => ({
  sequence,
  clientTick: sequence - 1,
  controlEpoch,
  held: Held.Right | Held.Fire,
  aim: 0,
  edges: [{ kind: Edge.FireOnset, id: sequence }],
});
const accepted = (prepared: readonly PreparedPlayerTick[]) =>
  prepared.map(({ input }) => ({
    playerId: input.playerId,
    edgeResults: input.command.edges.map((edge) => ({ ...edge, outcome: "applied" as const })),
  }));
function cohort() {
  return Array.from({ length: 4 }, (_, slot) => {
    const stream = new InputStream({
      runEpoch: 1,
      connectionEpoch: 1,
      playerId: slot + 1,
      controlEpoch: 1,
      baselineServerTick: 0,
    });
    stream.receive(
      encodeInputBatch({
        runEpoch: 1,
        connectionEpoch: 1,
        packetSequence: 1,
        snapshotAck: 0,
        eventAck: 0,
        commands: [command(1), command(2)],
      }),
      0,
      0,
    );
    return stream;
  });
}
describe("atomic controller ownership handoff", () => {
  it("publishes the new epoch with consumption, drains old edges and waits for new-owner intent", () => {
    const streams = cohort();
    const first = InputStream.processWorldTick(streams, 1, 16, (prepared) => ({
      state: 1,
      outcomes: accepted(prepared).map((outcome) => ({ ...outcome, controlEpoch: 2 })),
    }));
    expect(
      first.processed.every(
        (item) =>
          item.acknowledgment.controlEpoch === 2 && item.acknowledgment.lastProcessedSequence === 1,
      ),
    ).toBe(true);
    const old = InputStream.processWorldTick(streams, 2, 32, (prepared) => ({
      state: 2,
      outcomes: accepted(prepared),
    }));
    expect(
      old.processed.every(
        (item) =>
          item.input.outcome === "old-control" &&
          item.input.command.held === 0 &&
          item.edgeResults[0]?.outcome === "old-control",
      ),
    ).toBe(true);
    const neutral = InputStream.processWorldTick(streams, 3, 48, (prepared) => ({
      state: 3,
      outcomes: accepted(prepared),
    }));
    expect(
      neutral.processed.every(
        (item) => item.input.command.held === 0 && item.acknowledgment.controlEpoch === 2,
      ),
    ).toBe(true);
    for (const stream of streams)
      stream.receive(
        encodeInputBatch({
          runEpoch: 1,
          connectionEpoch: 1,
          packetSequence: 2,
          snapshotAck: 0,
          eventAck: 0,
          commands: [command(3, 2)],
        }),
        49,
        3,
      );
    const fresh = InputStream.processWorldTick(streams, 4, 64, (prepared) => ({
      state: 4,
      outcomes: accepted(prepared),
    }));
    expect(
      fresh.processed.every(
        (item) =>
          item.input.outcome === "applied" &&
          item.input.command.held === (Held.Right | Held.Fire) &&
          item.acknowledgment.processedEdgeIds[4] === 3,
      ),
    ).toBe(true);
  });

  it("rolls every owner back if any handoff generation is invalid", () => {
    const streams = cohort(),
      before = streams.map((stream) => stream.acknowledgment);
    expect(() =>
      InputStream.processWorldTick(streams, 1, 16, (prepared) => ({
        state: 1,
        outcomes: accepted(prepared).map((outcome, index) => ({
          ...outcome,
          controlEpoch: index === 3 ? 3 : 2,
        })),
      })),
    ).toThrow(/increment once/);
    expect(streams.map((stream) => stream.acknowledgment)).toEqual(before);
    expect(streams.every((stream) => stream.requiresResync)).toBe(true);
  });

  it("keeps old command identity while starting fresh samples without pre-transfer action edges", () => {
    const capture = new InputCapture(1);
    capture.press("fire", { held: Held.Fire, edge: Edge.FireOnset });
    const old = capture.capture(0);
    capture.press("grenade", { edge: Edge.Grenade });
    capture.advanceControlEpoch(2);
    const fresh = capture.capture(0);
    expect(fresh).toMatchObject({
      sequence: 2,
      clientTick: 1,
      controlEpoch: 2,
      held: Held.Fire,
      edges: [],
    });
    expect(capture.takeBatch(0, true)).toEqual([old, fresh]);
    capture.release("grenade");
    capture.press("grenade", { edge: Edge.Grenade });
    expect(capture.capture(0).edges).toEqual([{ kind: Edge.Grenade, id: 2 }]);
  });

  it("restores seat ownership and replays pending old-mode commands as neutral input", () => {
    const world = createControllerWorkload(),
      actor = world.players[0],
      acknowledgment = world.acknowledgments[0];
    if (!actor || !acknowledgment) throw new Error("Missing owner");
    const initial = { runEpoch: 1, connectionEpoch: 1, tick: 0, actor, acknowledgment };
    const seen: InputCommand[] = [];
    const prediction = new ControllerPrediction(initial, (current, intent) => {
      seen.push(intent);
      return {
        ...current,
        body: { ...current.body, x: current.body.x + (intent.held & Held.Right ? 1 : 0) },
      };
    });
    prediction.submit({ ...command(1), edges: [] });
    prediction.submit(command(2));
    const seated = structuredClone(initial);
    seated.tick = 1;
    seated.actor.controlEpoch = seated.acknowledgment.controlEpoch = 2;
    seated.actor.vehicleId = 30;
    seated.actor.locomotion = "seated";
    seated.actor.body.x = 1000;
    seated.acknowledgment.lastProcessedSequence = seated.acknowledgment.appliedAtServerTick = 1;
    prediction.reconcile(seated);
    expect(prediction.actor.body.x).toBe(1000);
    expect(seen.at(-1)).toMatchObject({ sequence: 2, controlEpoch: 2, held: 0, edges: [] });
    prediction.submit({ ...command(3, 2), edges: [] });
    expect(prediction.actor.body.x).toBe(1001);
    const unowned = structuredClone(seated);
    unowned.actor.vehicleId = null;
    expect(() => prediction.reconcile(unowned)).toThrow(/ownership/);
  });
});

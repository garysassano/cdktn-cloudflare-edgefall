import { describe, expect, it } from "vitest";
import { COUNTER_LIMIT } from "../src/game/core/numeric.js";
import {
  type AppliedInput,
  Edge,
  type EdgeResult,
  Held,
  type InputCommand,
} from "../src/game/input/types.js";
import { encodeInputBatch } from "../src/shared/protocol/codec.js";
import { InputStream } from "../src/shared/protocol/input-stream.js";
import type { InputBatch } from "../src/shared/protocol/schema.js";

const options = {
  runEpoch: 1,
  connectionEpoch: 2,
  playerId: 3,
  controlEpoch: 1,
  baselineServerTick: 100,
};
const command = (sequence = 1, patch: Partial<InputCommand> = {}): InputCommand => ({
  sequence,
  clientTick: sequence - 1,
  controlEpoch: 1,
  held: Held.Fire | Held.Right,
  aim: 0,
  edges: [],
  ...patch,
});
const batch = (
  commands: InputCommand[],
  packetSequence = 1,
  patch: Partial<InputBatch> = {},
): Uint8Array =>
  encodeInputBatch({
    runEpoch: 1,
    connectionEpoch: 2,
    packetSequence,
    snapshotAck: 0,
    eventAck: 0,
    commands,
    ...patch,
  });
const applied = (input: AppliedInput): EdgeResult[] =>
  input.command.edges.map((edge) => ({ ...edge, outcome: "applied" }));

describe("bounded processed input stream", () => {
  it("drains pre-pause packets without applying commands or renewing a lease, preserving immutable packet checks", () => {
    const stream = new InputStream(options);
    stream.recordSent(1, 0);
    stream.receive(batch([command(1)]), 0, 100);
    stream.processTick(101, 16, applied);
    const before = stream.acknowledgment;
    const late = batch([command(2, { edges: [{ kind: Edge.FireOnset, id: 1 }] })], 2, {
      snapshotAck: 1,
    });
    expect(stream.receive(late, 17, 101, "drain-paused")).toEqual({
      admitted: 0,
      duplicate: false,
      renewed: false,
    });
    expect(stream.queuedCommands).toBe(0);
    expect(stream.acknowledgment).toEqual(before);
    expect(stream.deliveryAcknowledgments.snapshot).toBe(1);
    expect(stream.receive(late, 18, 101, "drain-paused").duplicate).toBe(true);
    expect(() =>
      stream.receive(batch([command(2)], 2, { snapshotAck: 1 }), 19, 101, "drain-paused"),
    ).toThrow("Changed duplicate packet");
  });
  it("does not acknowledge receipt, consumes at most one command each tick, and acknowledges rejected actions", () => {
    const stream = new InputStream(options);
    const first = command(1, {
      edges: [
        { kind: Edge.FireOnset, id: 1 },
        { kind: Edge.Grenade, id: 1 },
      ],
    });
    stream.receive(batch([first, command(2), command(3)]), 0, 100);
    expect(stream.queuedCommands).toBe(3);
    expect(stream.acknowledgment.lastProcessedSequence).toBe(0);
    const tick = stream.processTick(101, 16, (input) => {
      expect(stream.acknowledgment.lastProcessedSequence).toBe(0);
      expect(input.command).toEqual(first);
      return input.command.edges.map((edge) => ({
        ...edge,
        outcome: edge.kind === Edge.Grenade ? "unavailable" : "cooldown",
      }));
    });
    expect(tick.acknowledgment).toMatchObject({
      lastProcessedSequence: 1,
      appliedAtServerTick: 101,
      processedEdgeIds: [0, 1, 0, 0, 1],
    });
    expect(tick.edgeResults.map((edge) => edge.outcome)).toEqual(["cooldown", "unavailable"]);
    expect(stream.queuedCommands).toBe(2);
    expect(() => stream.processTick(101, 16, applied)).toThrow(/one input step/);
    expect(stream.processTick(102, 32, applied).acknowledgment.lastProcessedSequence).toBe(2);
  });

  it("deduplicates unchanged packets/commands without replaying edges or renewing liveness", () => {
    const stream = new InputStream(options);
    const input = command(1, { edges: [{ kind: Edge.Jump, id: 1 }] });
    const packet = batch([input]);
    stream.receive(packet, 0, 100);
    expect(stream.processTick(101, 16, applied).edgeResults).toHaveLength(1);
    expect(stream.receive(packet, 100, 101)).toEqual({
      admitted: 0,
      duplicate: true,
      renewed: false,
    });
    expect(stream.receive(batch([input], 2), 150, 101)).toEqual({
      admitted: 0,
      duplicate: false,
      renewed: false,
    });
    const repeat = stream.processTick(102, 200, applied);
    expect(repeat.input.repeatedHeld).toBe(true);
    expect(repeat.input.command.held).toBe(input.held);
    expect(repeat.input.command.edges).toEqual([]);
    expect(repeat.input.submittedCommand).toBeNull();
    const neutral = stream.processTick(103, 250, applied);
    expect(neutral.input.command.held).toBe(0);
    expect(neutral.neutralized).toBe(true);
    expect(neutral.acknowledgment.lastProcessedSequence).toBe(1);
  });

  it("never lets acknowledgment-only packets renew control", () => {
    const stream = new InputStream(options);
    stream.receive(batch([command()]), 0, 100);
    stream.processTick(101, 1, applied);
    stream.recordSent(7, 11);
    expect(stream.receive(batch([], 2, { snapshotAck: 7, eventAck: 11 }), 249, 101).renewed).toBe(
      false,
    );
    expect(stream.deliveryAcknowledgments).toEqual({ snapshot: 7, event: 11 });
    expect(stream.processTick(102, 250, applied).input.command.held).toBe(0);
  });

  it("acknowledges stale/old-seat edges as no-ops without permitting them to fire later", () => {
    const stream = new InputStream(options);
    const cmd = command(1, {
      edges: [
        { kind: Edge.Interact, id: 1 },
        { kind: Edge.FireOnset, id: 1 },
      ],
    });
    stream.receive(batch([cmd]), 0, 100);
    stream.setControlEpoch(2);
    const old = stream.processTick(101, 16, applied);
    expect(old.input.command.held).toBe(0);
    expect(old.input.submittedCommand).toEqual(cmd);
    expect(old.input.command.edges).toEqual([]);
    expect(old.edgeResults.every((edge) => edge.outcome === "old-control")).toBe(true);
    expect(old.acknowledgment).toMatchObject({
      controlEpoch: 2,
      lastProcessedSequence: 1,
      processedEdgeIds: [0, 0, 1, 0, 1],
    });
    stream.receive(
      batch([command(2, { controlEpoch: 2, edges: [{ kind: Edge.Grenade, id: 1 }] })], 2),
      20,
      101,
    );
    const stale = stream.processTick(102, 270, applied);
    expect(stale.input.outcome).toBe("stale");
    expect(stale.edgeResults).toEqual([{ kind: Edge.Grenade, id: 1, outcome: "stale" }]);
    expect(stale.acknowledgment.lastProcessedSequence).toBe(2);
    expect(stream.processTick(103, 280, applied).input.command.held).toBe(0);
  });

  it("rejects old client time without renewing the lease even when packets arrive now", () => {
    const stream = new InputStream(options);
    for (let tick = 101; tick <= 116; tick++) stream.processTick(tick, tick, applied);
    expect(stream.receive(batch([command()]), 120, 116).renewed).toBe(false);
    const result = stream.processTick(117, 121, applied);
    expect(result.input.outcome).toBe("stale");
    expect(result.acknowledgment.lastProcessedSequence).toBe(1);
  });

  it("rejects changed duplicate identities, cross-command edge reuse, gaps and unissued epochs atomically", () => {
    const cases = [
      () => batch([command(1, { held: 0 })], 1),
      () => batch([command(1, { held: 0 })], 2),
      () => batch([command(3)], 2),
      () => batch([command(2, { edges: [{ kind: Edge.Jump, id: 1 }] })], 2),
      () => batch([command(2, { edges: [{ kind: Edge.Jump, id: 258 }] })], 2),
      () => batch([command(2, { controlEpoch: 2 })], 2),
      () => batch([command(2)], 3),
    ];
    for (const packet of cases) {
      const stream = new InputStream(options);
      stream.receive(batch([command(1, { edges: [{ kind: Edge.Jump, id: 1 }] })]), 0, 100);
      expect(() => stream.receive(packet(), 1, 100)).toThrow();
      expect(stream.queuedCommands).toBe(1);
      expect(stream.acknowledgment.lastProcessedSequence).toBe(0);
      expect(stream.requiresResync).toBe(true);
      expect(() => stream.processTick(101, 2, applied)).toThrow(/fresh baseline/);
    }
  });

  it("validates the last command before admitting an earlier valid command", () => {
    const stream = new InputStream(options);
    const cmds = [command(1), command(2, { controlEpoch: 2 })];
    expect(() => stream.receive(batch(cmds), 0, 100)).toThrow(/Unissued/);
    expect(stream.queuedCommands).toBe(0);
    expect(stream.deliveryAcknowledgments).toEqual({ snapshot: 0, event: 0 });
  });

  it("rejects acknowledgments for unsent snapshots/events and frames from an old socket/run", () => {
    for (const patch of [
      { snapshotAck: 5 },
      { eventAck: 1 },
      { connectionEpoch: 1 },
      { runEpoch: 2 },
    ]) {
      const stream = new InputStream(options);
      stream.recordSent(7, 0);
      expect(() => stream.receive(batch([command()], 1, patch), 0, 100)).toThrow();
      expect(stream.queuedCommands).toBe(0);
      expect(stream.acknowledgment.lastProcessedSequence).toBe(0);
    }
  });

  it("bounds the queue, future lead, history and all counters", () => {
    const stream = new InputStream(options);
    for (let tick = 101; tick <= 300; tick++) stream.processTick(tick, tick, applied);
    for (let packet = 1; packet <= 40; packet++)
      stream.receive(
        batch(
          [0, 1, 2].map((i) => command((packet - 1) * 3 + i + 1)),
          packet,
        ),
        300,
        300,
      );
    expect(stream.queuedCommands).toBe(120);
    expect(() => stream.receive(batch([command(121)], 41), 300, 300)).toThrow(/queue limit/);
    expect(stream.queuedCommands).toBe(120);
    const ahead = new InputStream(options);
    ahead.receive(batch([command(1), command(2), command(3)]), 0, 100);
    ahead.receive(batch([command(4), command(5), command(6)], 2), 0, 100);
    expect(() => ahead.receive(batch([command(7)], 3), 0, 100)).toThrow(/lead/);
    expect(() => new InputStream({ ...options, connectionEpoch: COUNTER_LIMIT })).toThrow();
    const history = new InputStream(options);
    for (let packet = 1; packet <= 181; packet++) history.receive(batch([], packet), packet, 100);
    expect(() => history.receive(batch([]), 182, 100)).toThrow(/history/);
  });

  it("does not expose mutable admission/ack state to simulation and fails closed on uncertain application", () => {
    const stream = new InputStream(options);
    stream.receive(batch([command(1, { edges: [{ kind: Edge.Jump, id: 1 }] })]), 0, 100);
    const ack = stream.acknowledgment;
    ack.processedEdgeIds[0] = 99;
    expect(stream.acknowledgment.processedEdgeIds[0]).toBe(0);
    const result = stream.processTick(101, 1, (input) => {
      const edges = applied(input);
      input.command.held = 0;
      input.submittedCommand?.edges.splice(0);
      return edges;
    });
    expect(result.input.command.held).toBe(Held.Fire | Held.Right);
    expect(result.input.submittedCommand?.edges).toHaveLength(1);
    expect(stream.processTick(102, 2, applied).input.command.held).toBe(Held.Fire | Held.Right);
    stream.receive(batch([command(2)], 2), 3, 102);
    expect(() =>
      stream.processTick(103, 4, () => {
        throw new Error("kernel failed");
      }),
    ).toThrow(/kernel failed/);
    expect(stream.acknowledgment.lastProcessedSequence).toBe(1);
    expect(stream.requiresResync).toBe(true);
  });

  it("does not advance cursors if an edge is omitted or misidentified by the simulation", () => {
    const stream = new InputStream(options);
    stream.receive(batch([command(1, { edges: [{ kind: Edge.Jump, id: 1 }] })]), 0, 100);
    expect(() => stream.processTick(101, 1, () => [])).toThrow(/every delivered edge/);
    expect(stream.acknowledgment.lastProcessedSequence).toBe(0);
    expect(stream.requiresResync).toBe(true);
  });
});

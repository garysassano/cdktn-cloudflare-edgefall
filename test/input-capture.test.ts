import { describe, expect, it } from "vitest";
import { Edge, Held } from "../src/game/input/types.js";
import { InputCapture, MAX_CAPTURE_EDGES } from "../src/shared/input/capture.js";
import { decodeInputBatch, encodeInputBatch } from "../src/shared/protocol/codec.js";
import { inputCaptureProof } from "./fixtures/input-capture-proof.js";

describe("independent input capture", () => {
  it("runs the portable short-tap/batch/neutralization trace without snapshots", () => {
    const proof = inputCaptureProof();
    expect(proof.ticks).toBe(60);
    expect(proof.heldTicks).toEqual([19, 20, 21, 22, 23]);
    expect(proof.edges).toEqual([
      { tick: 1, kind: Edge.FireOnset, id: 1 },
      { tick: 7, kind: Edge.Jump, id: 1 },
      { tick: 7, kind: Edge.Grenade, id: 1 },
      { tick: 16, kind: Edge.FireOnset, id: 2 },
    ]);
  });
  it("retains a press/release between ticks, without held fire or duplicate onset", () => {
    const input = new InputCapture(1);
    input.press("fire", { held: Held.Fire, edge: Edge.FireOnset });
    input.press("fire", { held: Held.Fire, edge: Edge.FireOnset });
    input.release("fire");
    const command = input.capture(0);
    expect(command.held).toBe(0);
    expect(command.edges).toEqual([{ kind: Edge.FireOnset, id: 1 }]);
    expect(input.takeBatch(16)).toEqual([command]);
    expect(input.capture(0).edges).toEqual([]);
  });
  it("keeps aliases held until all physical sources release", () => {
    const input = new InputCapture(1);
    const binding = { held: Held.Fire, edge: Edge.FireOnset };
    input.press("key", binding);
    input.press("pad", binding);
    input.release("key");
    expect(input.capture(0)).toMatchObject({
      held: Held.Fire,
      edges: [{ kind: Edge.FireOnset, id: 1 }],
    });
    input.release("pad");
    input.press("key", binding);
    expect(input.capture(0).edges).toEqual([{ kind: Edge.FireOnset, id: 2 }]);
  });
  it("preserves quick repeated and simultaneous edges in order across bounded binary batches", () => {
    const input = new InputCapture(7);
    for (let i = 0; i < 10; i++) {
      input.press("jump", { edge: Edge.Jump });
      input.release("jump");
    }
    input.press("grenade", { edge: Edge.Grenade });
    input.press("interact", { edge: Edge.Interact });
    const first = input.capture(1),
      second = input.capture(2);
    expect(first.edges).toHaveLength(8);
    expect(second.edges).toEqual([
      { kind: Edge.Jump, id: 9 },
      { kind: Edge.Jump, id: 10 },
      { kind: Edge.Grenade, id: 1 },
      { kind: Edge.Interact, id: 1 },
    ]);
    const batch = {
      runEpoch: 1,
      connectionEpoch: 1,
      packetSequence: 1,
      snapshotAck: 0,
      eventAck: 0,
      commands: input.takeBatch(33) ?? [],
    };
    expect(decodeInputBatch(encodeInputBatch(batch), { runEpoch: 1, connectionEpoch: 1 })).toEqual(
      batch,
    );
    expect(batch.commands.map((c) => [c.sequence, c.clientTick, c.controlEpoch])).toEqual([
      [1, 0, 7],
      [2, 1, 7],
    ]);
  });
  it("captures 60 ticks without receiving snapshots and sends normal input at 20 Hz", () => {
    const input = new InputCapture(1);
    const frames = [];
    for (let tick = 1; tick <= 60; tick++) {
      input.capture(0);
      const batch = input.takeBatch((tick * 1000) / 60);
      if (batch) frames.push(batch);
    }
    expect(frames).toHaveLength(20);
    expect(frames.flat().map((c) => c.sequence)).toEqual(
      Array.from({ length: 60 }, (_, i) => i + 1),
    );
    expect(input.pending).toBe(0);
  });
  it("neutralizes unsampled intent while preserving already captured command identity", () => {
    const input = new InputCapture(1);
    input.press("right", { held: Held.Right });
    const before = input.capture(0);
    input.press("jump", { edge: Edge.Jump });
    input.neutralize();
    expect(input.capture(0)).toMatchObject({ held: 0, edges: [] });
    expect(input.takeBatch(20, true)?.[0]).toEqual(before);
    input.press("jump", { edge: Edge.Jump });
    expect(input.capture(0).edges).toEqual([{ kind: Edge.Jump, id: 2 }]);
  });
  it("applies the frame token budget without discarding queued edges", () => {
    const input = new InputCapture(1);
    for (let i = 0; i < 10; i++) {
      input.capture(0);
      expect(input.takeBatch(0, true)).toHaveLength(1);
    }
    input.press("jump", { edge: Edge.Jump });
    input.capture(0);
    expect(input.takeBatch(0, true)).toBeNull();
    expect(input.pending).toBe(1);
    expect(input.takeBatch(34)?.[0]?.edges).toEqual([{ kind: Edge.Jump, id: 1 }]);
  });
  it("fails explicitly on edge or command overflow without evicting captured history", () => {
    const edges = new InputCapture(1);
    for (let i = 0; i < MAX_CAPTURE_EDGES; i++) {
      edges.press("jump", { edge: Edge.Jump });
      edges.release("jump");
    }
    expect(() => edges.press("jump", { edge: Edge.Jump })).toThrow(/queue bound/);
    expect(edges.requiresResync).toBe(true);
    expect(edges.pendingEdges).toBe(MAX_CAPTURE_EDGES);
    const commands = new InputCapture(1);
    for (let i = 0; i < 120; i++) commands.capture(0);
    expect(() => commands.capture(0)).toThrow(/queue bound/);
    expect(commands.pending).toBe(120);
    expect(commands.requiresResync).toBe(true);
  });
  it("does not allow transport-clock regression to refill tokens", () => {
    const input = new InputCapture(1);
    input.takeBatch(50);
    expect(() => input.takeBatch(49)).toThrow(/clock/);
    expect(input.requiresResync).toBe(true);
  });
  it("does not expose mutable commands retained for later sending", () => {
    const input = new InputCapture(1);
    input.press("jump", { edge: Edge.Jump });
    const local = input.capture(0);
    local.held = Held.Left;
    const edge = local.edges[0];
    if (!edge) throw new Error("Missing captured edge");
    edge.id = 9;
    expect(input.takeBatch(0)?.[0]).toMatchObject({ held: 0, edges: [{ kind: Edge.Jump, id: 1 }] });
  });
});

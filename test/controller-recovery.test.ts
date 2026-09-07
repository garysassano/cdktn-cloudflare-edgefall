import { describe, expect, it } from "vitest";
import { COUNTER_LIMIT } from "../src/game/core/numeric.js";
import {
  controllerPeerContext,
  recoverControllerWorld,
} from "../src/shared/diagnostics/controller-recovery.js";
import {
  CONTROLLER_IDENTITY,
  CONTROLLER_INPUT_PREFILL_TICKS,
  createControllerWorkload,
  stepNetworkController,
} from "../src/shared/diagnostics/controller-workload.js";
import { InputCapture } from "../src/shared/input/capture.js";
import { ControllerPrediction } from "../src/shared/prediction/controller.js";
import { decodeInitialSnapshot } from "../src/shared/protocol/baseline.js";
import { encodeInputBatch } from "../src/shared/protocol/codec.js";
import type { Handshake } from "../src/shared/protocol/handshake.js";
import { InputStream } from "../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";

describe("controller room recovery boundary", () => {
  it("leaves one tick of startup headroom while retaining the six-tick admission ceiling", () => {
    expect(CONTROLLER_INPUT_PREFILL_TICKS).toBe(5);
    const stream = new InputStream({
      runEpoch: 1,
      connectionEpoch: 1,
      playerId: 1,
      controlEpoch: 1,
      baselineServerTick: 0,
    });
    const capture = new InputCapture(1);
    for (let i = 0; i < CONTROLLER_INPUT_PREFILL_TICKS; i++) capture.capture(0);
    let packetSequence = 0;
    const send = () =>
      stream.receive(
        encodeInputBatch({
          runEpoch: 1,
          connectionEpoch: 1,
          packetSequence: ++packetSequence,
          snapshotAck: 0,
          eventAck: 0,
          commands: capture.takeBatch(0, true) ?? [],
        }),
        0,
        0,
      );
    send();
    send();
    capture.capture(0);
    expect(send().admitted).toBe(1); // First client tick may arrive before the first room tick.
    capture.capture(0);
    expect(send).toThrow(/lead/);
    expect(stream.acknowledgment.lastProcessedSequence).toBe(0);
  });
  it("installs only the exact fresh baseline promised by the welcome", () => {
    const current = createControllerWorkload();
    current.tick = 47;
    const world = recoverControllerWorld(current),
      context = controllerPeerContext(world, 0);
    world.connectionEpoch = context.connectionEpoch;
    const welcome: Handshake = {
      ...CONTROLLER_IDENTITY,
      type: "welcome",
      protocolMajor: 3,
      protocolMinor: 3,
      runId: "local-room-workload",
      runEpoch: world.runEpoch,
      connectionEpoch: context.connectionEpoch,
      playerId: 1,
      entityId: 1,
      simulationHz: 60,
      snapshotHz: 20,
      initialServerTick: 47,
      capabilities: 0,
      baselineSnapshotId: world.snapshotId,
      baselineEventCursor: 0,
      buildId: "4".repeat(64),
    };
    const bytes = encodeSnapshot(world, context);
    expect(decodeInitialSnapshot(bytes, welcome, context).tick).toBe(47);
    for (const field of [
      "initialServerTick",
      "baselineSnapshotId",
      "baselineEventCursor",
      "entityId",
    ] as const)
      expect(() =>
        decodeInitialSnapshot(bytes, { ...welcome, [field]: welcome[field] + 1 }, context),
      ).toThrow(/baseline/);
    const ack = world.acknowledgments[0];
    if (!ack) throw new Error("Missing ack");
    ack.lastProcessedSequence = 1;
    ack.appliedAtServerTick = 47;
    expect(() => decodeInitialSnapshot(encodeSnapshot(world, context), welcome, context)).toThrow(
      /baseline/,
    );
  });
  it("preserves world/physics and rotates every input owner atomically", () => {
    const world = createControllerWorkload();
    world.tick = 47;
    world.roomMode = "recovering";
    for (const actor of world.players) actor.jumpBufferTicks = 3;
    const original = structuredClone(world),
      recovered = recoverControllerWorld(world);
    expect(world).toEqual(original);
    expect(recovered.tick).toBe(47);
    expect(recovered.runEpoch).toBe(2);
    expect(recovered.roomMode).toBe("loading");
    expect(recovered.players.map((a) => a.body)).toEqual(world.players.map((a) => a.body));
    expect(recovered.campaign).toEqual(world.campaign);
    for (const actor of recovered.players) {
      expect(actor.controlEpoch).toBe(2);
      expect(actor.jumpBufferTicks).toBe(0);
      const ack = recovered.acknowledgments.find((a) => a.playerId === actor.playerId);
      expect(ack).toMatchObject({
        lastProcessedSequence: 0,
        appliedAtServerTick: 0,
        controlEpoch: 2,
        processedEdgeIds: [0, 0, 0, 0, 0],
      });
    }
  });
  it("installs a binary baseline and maps fresh input after a nonzero recovered tick", () => {
    const current = createControllerWorkload();
    current.tick = 47;
    const recovered = recoverControllerWorld(current),
      context = controllerPeerContext(recovered, 0);
    recovered.connectionEpoch = context.connectionEpoch;
    const snapshot = decodeSnapshot(encodeSnapshot(recovered, context), context);
    const actor = snapshot.players[0],
      acknowledgment = snapshot.acknowledgments[0];
    if (!actor || !acknowledgment) throw new Error("Missing actor");
    const capture = new InputCapture(actor.controlEpoch);
    const prediction = new ControllerPrediction(
      { ...context, tick: snapshot.tick, actor, acknowledgment },
      (a, c, t) => stepNetworkController(a, c, t).actor,
    );
    const stream = new InputStream({
      ...context,
      controlEpoch: actor.controlEpoch,
      baselineServerTick: snapshot.tick,
    });
    const command = capture.capture(0);
    prediction.submit(command);
    stream.receive(
      encodeInputBatch({
        ...context,
        packetSequence: 1,
        snapshotAck: 0,
        eventAck: 0,
        commands: [command],
      }),
      0,
      47,
    );
    const applied = stream.processTick(
      48,
      17,
      (input) => stepNetworkController(actor, input.command, 48).edges,
    );
    expect(applied.acknowledgment.lastProcessedSequence).toBe(1);
    expect(applied.acknowledgment.appliedAtServerTick).toBe(48);
    expect(prediction.tick).toBe(48);
  });
  it("rejects packets from the old run without advancing the fresh acknowledgment", () => {
    const current = createControllerWorkload(),
      recovered = recoverControllerWorld(current);
    const context = controllerPeerContext(recovered, 0);
    const stream = new InputStream({ ...context, controlEpoch: 2, baselineServerTick: 0 });
    expect(() =>
      stream.receive(
        encodeInputBatch({
          runEpoch: 1,
          connectionEpoch: 1,
          packetSequence: 1,
          snapshotAck: 0,
          eventAck: 0,
          commands: [],
        }),
        0,
        0,
      ),
    ).toThrow();
    expect(stream.acknowledgment.lastProcessedSequence).toBe(0);
    expect(stream.queuedCommands).toBe(0);
  });
  it("does not mutate the original on exhausted counters or unsupported vehicle ownership", () => {
    const world = createControllerWorkload();
    world.runEpoch = COUNTER_LIMIT - 1;
    const original = structuredClone(world);
    expect(() => recoverControllerWorld(world)).toThrow();
    expect(world).toEqual(original);
    world.runEpoch = 1;
    const actor = world.players[0];
    if (!actor) throw new Error("Missing actor");
    actor.vehicleId = 9;
    expect(() => recoverControllerWorld(world)).toThrow(/vehicle/);
    expect(actor.vehicleId).toBe(9);
  });
});

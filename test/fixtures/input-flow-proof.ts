import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held, type InputCommand } from "../../src/game/input/types.js";
import { InputCapture, inputSequenceLimit } from "../../src/shared/input/capture.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";

/** Ordered transport fixture for the captured 120/127 lead failure; no wall-clock cadence claim. */
export function inputFlowProof(initialServerTick = 0) {
  function run(limited: boolean) {
    const input = new InputCapture(1);
    const identity = { runEpoch: 1, connectionEpoch: 1 };
    const stream = new InputStream({
      ...identity,
      playerId: 1,
      controlEpoch: 1,
      baselineServerTick: initialServerTick,
    });
    let serverTick = initialServerTick,
      snapshotTick = initialServerTick,
      packetSequence = 0,
      nowMs = 0;
    const captured: InputCommand[] = [],
      sent: InputCommand[] = [],
      edges: Array<{ tick: number; sequence: number; kind: number; id: number }> = [];
    const capture = () => {
      const command = input.capture(0);
      captured.push(command);
      return command;
    };
    const packet = (commands: InputCommand[]) =>
      encodeInputBatch({
        ...identity,
        packetSequence: ++packetSequence,
        snapshotAck: 0,
        eventAck: 0,
        commands,
      });
    const send = () => {
      nowMs += 50;
      const commands = input.takeBatch(
        nowMs,
        inputSequenceLimit(initialServerTick, snapshotTick),
        true,
      );
      if (!commands) throw new Error("Expected eligible transport prefix");
      stream.receive(packet(commands), nowMs, serverTick);
      sent.push(...commands);
      return commands;
    };
    const step = () => {
      nowMs += 17;
      const result = stream.processTick(++serverTick, nowMs, (applied) => {
        for (const edge of applied.command.edges)
          edges.push({ tick: serverTick, sequence: applied.command.sequence, ...edge });
        return applied.command.edges.map((edge) => ({ ...edge, outcome: "applied" as const }));
      });
      return result;
    };
    for (let group = 0; group < 40; group++) {
      for (let index = 0; index < 3; index++) capture();
      send();
      for (let index = 0; index < 3; index++) step();
      snapshotTick = serverTick;
    }
    for (let index = 0; index < 4; index++) capture();
    send();
    send();
    capture();
    capture();
    // Both taps finish before capture and must survive a closed transport window.
    input.press("jump", { edge: Edge.Jump });
    input.release("jump");
    input.press("fire", { held: Held.Fire, edge: Edge.FireOnset });
    input.release("fire");
    const deferred = capture();
    const through = inputSequenceLimit(initialServerTick, snapshotTick);
    nowMs += 50;
    const commands = input.takeBatch(nowMs, limited ? through : input.sequence, true);
    if (!commands) throw new Error("Missing late batch");
    const priorQueue = stream.queuedCommands;
    try {
      stream.receive(packet(commands), nowMs, serverTick);
    } catch (error) {
      if (limited) throw error;
      return {
        status: "rejected" as const,
        error: String(error),
        tick: serverTick,
        rejected: commands.map((command) => command.sequence),
        priorQueue,
        retainedQueue: stream.queuedCommands,
        acknowledgment: stream.acknowledgment,
        requiresResync: stream.requiresResync,
      };
    }
    sent.push(...commands);
    const closedWindow = input.takeBatch(nowMs, through, true),
      blockedCommands = input.pending;
    if (closedWindow !== null || blockedCommands !== 1)
      throw new Error("Closed window lost or sent its tail");
    input.neutralize(); // Stopping raw intent does not rewrite captured identities.
    capture();
    capture();
    for (let index = 0; index < 3; index++) step();
    snapshotTick = serverTick;
    const released = send();
    const duplicate = stream.receive(
      encodeInputBatch({
        ...identity,
        packetSequence,
        snapshotAck: 0,
        eventAck: 0,
        commands: released,
      }),
      ++nowMs,
      serverTick,
    );
    for (let index = 0; index < 7; index++) step();
    if (
      canonical(captured) !== canonical(sent) ||
      input.pending !== 0 ||
      stream.queuedCommands !== 0
    )
      throw new Error("Input flow changed or lost a captured command");
    return {
      status: "pass" as const,
      firstLimit: through,
      firstBatch: commands.map((command) => command.sequence),
      blockedCommands,
      deferred,
      releasedLimit: inputSequenceLimit(initialServerTick, snapshotTick),
      released,
      duplicate: duplicate.duplicate,
      finalTick: serverTick,
      acknowledgment: stream.acknowledgment,
      appliedEdges: edges,
      commands: captured.length,
      traceHash: stateHash({ captured, sent, edges, acknowledgment: stream.acknowledgment }),
      requiresResync: stream.requiresResync,
    };
  }
  const unsafe = run(false),
    safe = run(true);
  if (unsafe.status !== "rejected" || safe.status !== "pass")
    throw new Error("Input flow control mismatch");
  return { initialServerTick, unsafe, safe };
}

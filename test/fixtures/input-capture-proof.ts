import { stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held, type InputCommand } from "../../src/game/input/types.js";
import { InputCapture } from "../../src/shared/input/capture.js";
import { decodeInputBatch, encodeInputBatch } from "../../src/shared/protocol/codec.js";

/** Portable event/tick/transport ordering; no snapshot receipt drives capture. */
export function inputCaptureProof() {
  const input = new InputCapture(1),
    frames: InputCommand[][] = [];
  for (let tick = 1; tick <= 60; tick++) {
    if (tick === 2 || tick === 17) {
      input.press("fire", { held: Held.Fire, edge: Edge.FireOnset });
      input.release("fire"); // Both events occurred since the previous capture.
    }
    if (tick === 8) {
      input.press("jump", { edge: Edge.Jump });
      input.release("jump");
      input.press("grenade", { edge: Edge.Grenade });
      input.release("grenade");
    }
    if (tick === 20) input.press("left", { held: Held.Left });
    if (tick === 25) input.neutralize();
    input.capture(0);
    const commands = input.takeBatch((tick * 1000) / 60, input.sequence);
    if (commands) {
      const packet = encodeInputBatch({
        runEpoch: 1,
        connectionEpoch: 1,
        packetSequence: frames.length + 1,
        snapshotAck: 0,
        eventAck: 0,
        commands,
      });
      frames.push(decodeInputBatch(packet, { runEpoch: 1, connectionEpoch: 1 }).commands);
    }
  }
  const remainder = input.takeBatch(1001, input.sequence, true);
  if (remainder) frames.push(remainder);
  const commands = frames.flat();
  if (commands.length !== 60 || input.pending !== 0) throw new Error("Lost captured command");
  return {
    ticks: commands.length,
    frames: frames.length,
    traceHash: stateHash(commands),
    edges: commands.flatMap((c) => c.edges.map((edge) => ({ tick: c.clientTick, ...edge }))),
    heldTicks: commands.filter((c) => c.held !== 0).map((c) => c.clientTick),
  };
}

import { describe, expect, it } from "vitest";
import { Edge, Held, type InputCommand } from "../src/game/input/types.js";
import {
  createControllerWorkload,
  stepNetworkController,
} from "../src/shared/diagnostics/controller-workload.js";
import {
  ControllerPrediction,
  type PredictionBaseline,
} from "../src/shared/prediction/controller.js";
import { predictionProof } from "./fixtures/prediction-proof.js";

function baseline(): PredictionBaseline {
  const world = createControllerWorkload();
  const actor = world.players[0],
    acknowledgment = world.acknowledgments[0];
  if (!actor || !acknowledgment) throw new Error("Missing player");
  return { runEpoch: 1, connectionEpoch: 1, tick: 0, actor, acknowledgment };
}
const command = (sequence: number, held = 0, jump = false): InputCommand => ({
  sequence,
  clientTick: sequence - 1,
  controlEpoch: 1,
  held,
  aim: 0,
  edges: jump ? [{ kind: Edge.Jump, id: 1 }] : [],
});
const step = (actor: PredictionBaseline["actor"], command: InputCommand, tick: number) =>
  stepNetworkController(actor, command, tick).actor;
function authoritative(initial: PredictionBaseline, commands: InputCommand[]): PredictionBaseline {
  const result = structuredClone(initial);
  for (const cmd of commands) {
    result.actor = step(result.actor, cmd, ++result.tick);
    result.acknowledgment.lastProcessedSequence = cmd.sequence;
    result.acknowledgment.appliedAtServerTick = result.tick;
    result.acknowledgment.processedEdgeIds = [...result.actor.processedEdgeIds];
  }
  return result;
}
describe("full controller prediction", () => {
  it("restores the snapshot boundary and replays only unconsumed input, including jump and crouch", () => {
    const initial = baseline(),
      prediction = new ControllerPrediction(initial, step);
    const commands = Array.from({ length: 9 }, (_, i) =>
      command(i + 1, i < 3 ? Held.Right : Held.Down, i === 0),
    );
    for (const c of commands) prediction.submit(c);
    const expected = authoritative(initial, commands);
    const result = prediction.reconcile(authoritative(initial, commands.slice(0, 3)));
    expect(result.replayed).toBe(6);
    expect(result.correction?.changed).toBe(false);
    expect(prediction.actor).toEqual(expected.actor);
    expect(prediction.tick).toBe(9);
    expect(prediction.actor.body.y).toBeLessThan(initial.actor.body.y);
    expect(prediction.actor.processedEdgeIds[0]).toBe(1);
  });
  it("corrects vertical state without replaying an acknowledged rejected jump", () => {
    const initial = baseline(),
      prediction = new ControllerPrediction(initial, step);
    const commands = [command(1, 0, true), command(2), command(3)];
    for (const c of commands) prediction.submit(c);
    const snapshot = authoritative(initial, [command(1)]);
    snapshot.acknowledgment.processedEdgeIds[0] = 1;
    snapshot.actor.processedEdgeIds[0] = 1;
    const result = prediction.reconcile(snapshot);
    expect(result.correction?.y).toBe(1375);
    expect(result.replayed).toBe(2);
    expect(prediction.actor.body.y).toBe(initial.actor.body.y);
    expect(prediction.actor.body.grounded).toBe(true);
  });
  it("uses snapshot tick after server held repetition, and requires a new mapping before more input", () => {
    const initial = baseline(),
      prediction = new ControllerPrediction(initial, step),
      first = command(1, Held.Right);
    prediction.submit(first);
    const snapshot = authoritative(initial, [first]);
    for (let tick = 2; tick <= 5; tick++)
      snapshot.actor = step(snapshot.actor, { ...first, edges: [] }, tick);
    snapshot.tick = 5;
    prediction.reconcile(snapshot);
    expect(prediction.actor.body.x).toBe(initial.actor.body.x + 5 * 768);
    expect(prediction.tick).toBe(5);
    expect(() => prediction.submit(command(2))).toThrow(/authoritative|missing/);
    expect(prediction.requiresResync).toBe(true);
  });
  it("does not remap unacknowledged commands into time already covered by authority", () => {
    const initial = baseline(),
      prediction = new ControllerPrediction(initial, step);
    prediction.submit(command(1));
    prediction.submit(command(2, 0, true));
    const snapshot = { ...initial, tick: 2 };
    expect(() => prediction.reconcile(snapshot)).toThrow("overlaps restored snapshot");
    expect(prediction.requiresResync).toBe(true);
  });
  it("rejects history overflow instead of dropping old commands", () => {
    const prediction = new ControllerPrediction(baseline(), step);
    for (let n = 1; n <= 120; n++) prediction.submit(command(n));
    expect(() => prediction.submit(command(121))).toThrow("history limit");
    expect(prediction.pending).toBe(120);
    expect(prediction.requiresResync).toBe(true);
  });
  it("rejects changed geometry/lifecycle, unsent acknowledgments, and reused edges", () => {
    for (const change of ["geometry", "death", "ack"]) {
      const initial = baseline(),
        prediction = new ControllerPrediction(initial, step),
        snapshot = structuredClone(initial);
      if (change === "geometry") snapshot.actor.geometryRevision++;
      if (change === "death") snapshot.actor.life = "death";
      if (change === "ack") snapshot.acknowledgment.lastProcessedSequence = 1;
      expect(() => prediction.reconcile(snapshot)).toThrow();
      expect(prediction.requiresResync).toBe(true);
    }
    const prediction = new ControllerPrediction(baseline(), step);
    prediction.submit(command(1, 0, true));
    expect(() => prediction.submit(command(2, 0, true))).toThrow("edge identity reused");
  });
  it("rejects acknowledgments for an edge outside the consumed command prefix", () => {
    const initial = baseline(),
      prediction = new ControllerPrediction(initial, step);
    prediction.submit(command(1));
    prediction.submit(command(2, 0, true));
    const snapshot = authoritative(initial, [command(1)]);
    snapshot.acknowledgment.processedEdgeIds[0] = 1;
    expect(() => prediction.reconcile(snapshot)).toThrow("edge was not consumed");
  });
  it("round-trips four real controller streams and reconciles every full snapshot", () => {
    const proof = predictionProof();
    expect(proof.reconciliations).toBe(240);
    expect(proof.bytes).toBe(1432);
    expect(proof.coverage.every((p) => p.crouched && p.pending === 6)).toBe(true);
  });
  it("acknowledges extra same-tick jump edges without granting extra physical jumps", () => {
    const initial = baseline(),
      cmd = command(1, 0, true);
    cmd.edges.push({ kind: Edge.Jump, id: 2 });
    const result = stepNetworkController(initial.actor, cmd, 1);
    expect(result.edges.map((e) => e.outcome)).toEqual(["applied", "unavailable"]);
    expect(result.actor.body.y).toBe(initial.actor.body.y - 1375);
    expect(result.actor.processedEdgeIds[0]).toBe(2);
  });
});

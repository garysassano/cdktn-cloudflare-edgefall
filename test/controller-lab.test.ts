import { describe, expect, it } from "vitest";
import { Held } from "../src/game/input/types.js";
import {
  type LabCommand,
  createControllerLab,
  labFingerprint,
  replayControllerLab,
  stepControllerLab,
} from "../src/game/labs/controller.js";
import { encounterProof } from "./fixtures/encounter-proof.js";

const neutral: LabCommand = {
  held: 0,
  jumpPressed: false,
  startTraversal: false,
  removePlatform: false,
};
describe("rendered controller laboratory world", () => {
  it("carries, removes support at a new revision and replays the recorded world command", () => {
    let state = createControllerLab("moving-support");
    const startX = state.actor.body.x;
    const commands = Array.from({ length: 90 }, (_, tick) => ({
      ...neutral,
      startTraversal: false,
      removePlatform: tick === 20,
    }));
    for (const command of commands) state = stepControllerLab(state, command);
    expect(state.actor.body.x).toBe(startX + 20 * 256);
    expect(state.actor.body.supportId).toBe(100);
    expect(state.geometryRevision).toBe(2);
    expect(state.terrain.some((t) => t.id === 110)).toBe(false);
    expect(
      labFingerprint(
        replayControllerLab({
          format: 6,
          scenario: state.scenario,
          commands,
          finalState: labFingerprint(state),
        }),
      ),
    ).toBe(labFingerprint(state));
  });
  it("halts on a closing ceiling instead of accepting a partial crushed actor", () => {
    let state = createControllerLab("crush");
    for (let tick = 0; tick < 100 && !state.stopped; tick++)
      state = stepControllerLab(state, neutral);
    expect(state.stopped).toBe("crushed");
    expect(state.actor.body.y).toBe(300 * 256);
    expect(stepControllerLab(state, neutral)).toBe(state);
  });
  it("records a real course fall at the kill bound and rejects extra replay ticks", () => {
    let state = createControllerLab("course");
    const commands: LabCommand[] = [];
    while (!state.stopped && commands.length < 200) {
      const command = { ...neutral, held: Held.Left };
      commands.push(command);
      state = stepControllerLab(state, command);
    }
    expect(state.stopped).toBe("kill-bound");
    expect(() =>
      replayControllerLab({
        format: 6,
        scenario: "course",
        commands: [...commands, neutral],
        finalState: labFingerprint(state),
      }),
    ).toThrow("after stop");
    expect(() =>
      replayControllerLab({ format: 6, scenario: "course", commands: [], finalState: "wrong" }),
    ).toThrow("diverged");
  });
  it("routes an independent enemy and replays a changed collision catalog", () => {
    for (const remove of [false, true]) {
      let state = createControllerLab("enemy-route");
      const commands: LabCommand[] = [];
      for (let tick = 0; tick < 150; tick++) {
        const command = {
          ...neutral,
          jumpPressed: tick === 0,
          removePlatform: remove && tick === 60,
        };
        commands.push(command);
        state = stepControllerLab(state, command);
        expect(state.stopped).toBe(null);
        if (tick === 0) expect(state.actor.body.y).toBe(300 * 256 - 1375);
        if (tick === 60 && remove) {
          expect(state.navigatingEnemy?.reason).toBe("geometry");
          expect(state.navigatingEnemy?.plan).toBe(null);
        }
      }
      expect(state.navigatingEnemy?.actor).not.toHaveProperty("playerId");
      expect(state.navigatingEnemy?.status).toBe(remove ? "unreachable" : "arrived");
      expect(state.navigatingEnemy?.actor.body.supportId).toBe(remove ? 101 : 102);
      expect(state.actor.body.x).toBe(80 * 256);
      expect(
        labFingerprint(
          replayControllerLab({
            format: 6,
            scenario: "enemy-route",
            commands,
            finalState: labFingerprint(state),
          }),
        ),
      ).toBe(labFingerprint(state));
    }
  });
  it("completes a real environmental removal once and restores the entire lab every tick", () => {
    const proof = encounterProof();
    expect(proof.notices.filter((n) => n.kind === "complete")).toHaveLength(1);
    expect(proof.checkpoints.at(-1)?.enemy?.removalReason).toBe("out-of-bounds");
    expect(proof.checkpoints.at(-1)?.encounter?.receipts).toHaveLength(2);
  });
  it("records a physical solver failure without accepting a partial enemy or clearing its obligation", () => {
    const initial = createControllerLab("encounter-clear");
    if (!initial.enemy) throw new Error("Missing enemy");
    initial.enemy.body.y += 2 * 256;
    const result = stepControllerLab(initial, neutral);
    expect(result.stopped).toBe("enemy-initial-overlap");
    expect(result.enemy?.body).toEqual(initial.enemy.body);
    expect(result.encounter?.phase).toBe("failed");
    expect(result.encounter?.failure?.cause).toBe("initial-overlap");
    expect(result.encounter?.members[0]?.status).toBe("alive");
    expect(result.resolvedEnemies).toEqual([]);
  });
});

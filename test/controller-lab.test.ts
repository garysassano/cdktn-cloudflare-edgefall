import { describe, expect, it } from "vitest";
import { Held } from "../src/game/input/types.js";
import {
  type LabCommand,
  createControllerLab,
  labFingerprint,
  replayControllerLab,
  stepControllerLab,
} from "../src/game/labs/controller.js";

const neutral: LabCommand = { held: 0, jumpPressed: false, removePlatform: false };
describe("rendered controller laboratory world", () => {
  it("carries, removes support at a new revision and replays the recorded world command", () => {
    let state = createControllerLab("moving-support");
    const startX = state.actor.body.x;
    const commands = Array.from({ length: 90 }, (_, tick) => ({
      ...neutral,
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
          format: 1,
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
        format: 1,
        scenario: "course",
        commands: [...commands, neutral],
        finalState: labFingerprint(state),
      }),
    ).toThrow("after stop");
    expect(() =>
      replayControllerLab({ format: 1, scenario: "course", commands: [], finalState: "wrong" }),
    ).toThrow("diverged");
  });
});

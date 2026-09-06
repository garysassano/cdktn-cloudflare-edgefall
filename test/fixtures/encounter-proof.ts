import { stateHash } from "../../src/game/core/canonical.js";
import { EncounterLifecycle } from "../../src/game/encounters/lifecycle.js";
import {
  type LabCommand,
  createControllerLab,
  labFingerprint,
  replayControllerLab,
  stepControllerLab,
} from "../../src/game/labs/controller.js";

export function encounterProof() {
  let state = createControllerLab("encounter-clear");
  let traceHash = "00000000";
  const commands: LabCommand[] = [];
  const notices = [];
  const checkpoints = [];
  for (let tick = 1; tick <= 120; tick++) {
    const command = {
      held: 0,
      jumpPressed: tick === 1,
      removePlatform: tick === 11,
      startTraversal: false,
    };
    commands.push(command);
    const restored = stepControllerLab(JSON.parse(JSON.stringify(state)), command);
    state = stepControllerLab(state, command);
    if (state.stopped || labFingerprint(restored) !== labFingerprint(state))
      throw new Error("Encounter world restore failed");
    traceHash = stateHash({ traceHash, state: labFingerprint(state) });
    notices.push(...state.encounterNotices);
    if ([1, 10, 11, 30, 60, 120].includes(tick))
      checkpoints.push({ tick, enemy: state.enemy, encounter: state.encounter });
  }
  const finalState = labFingerprint(state);
  replayControllerLab({ format: 6, scenario: "encounter-clear", commands, finalState });
  if (
    state.encounter?.phase !== "complete" ||
    state.encounter.kills.some((k) => k.count !== 0) ||
    notices.filter((n) => n.kind === "complete").length !== 1
  )
    throw new Error("Environmental encounter completion failed");
  const boss = new EncounterLifecycle({
    id: 99,
    participants: [1],
    members: [
      {
        id: 42,
        required: true,
        critical: true,
        retreatAllowed: false,
        watchdogTicks: 60,
        ambientCleanupTicks: null,
      },
    ],
    objectives: [],
  });
  const failure = boss.step(
    boss.begin(),
    1,
    [
      { sequence: 1, tick: 1, kind: "activate", id: 42 },
      { sequence: 2, tick: 1, kind: "resolve", id: 42, reason: "out-of-bounds", killerId: null },
    ],
    [],
  );
  if (failure.state.phase !== "failed") throw new Error("Critical pose loss failed open");
  return { ticks: state.tick, traceHash, notices, checkpoints, failure };
}

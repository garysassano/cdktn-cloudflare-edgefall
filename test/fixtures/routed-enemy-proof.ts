import { stateHash } from "../../src/game/core/canonical.js";
import {
  type LabCommand,
  createControllerLab,
  labFingerprint,
  replayControllerLab,
  stepControllerLab,
} from "../../src/game/labs/controller.js";

export function routedEnemyProof() {
  return [false, true].map((remove) => {
    let state = createControllerLab("enemy-route");
    let traceHash = "00000000";
    const commands: LabCommand[] = [];
    const checkpoints = [];
    for (let tick = 0; tick < 150; tick++) {
      const command = {
        held: 0,
        jumpPressed: tick === 0,
        startTraversal: false,
        removePlatform: remove && tick === 60,
      };
      commands.push(command);
      state = stepControllerLab(state, command);
      if (state.stopped) throw new Error(`Routed enemy fixture stopped: ${state.stopped}`);
      traceHash = stateHash({ traceHash, state: labFingerprint(state) });
      if ([0, 59, 60, 116, 149].includes(tick))
        checkpoints.push({
          tick: state.tick,
          enemy: state.navigatingEnemy,
          events: state.enemyNavigationEvents,
        });
    }
    const finalState = labFingerprint(state);
    replayControllerLab({ format: 6, scenario: "enemy-route", commands, finalState });
    if (
      state.navigatingEnemy?.status !== (remove ? "unreachable" : "arrived") ||
      state.navigatingEnemy.actor.body.supportId !== (remove ? 101 : 102)
    )
      throw new Error("Wrong routed enemy outcome");
    return { remove, ticks: state.tick, traceHash, checkpoints, finalState };
  });
}

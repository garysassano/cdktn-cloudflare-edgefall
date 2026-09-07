import type { LifeNotice } from "../../src/game/campaign/life.js";
import { stateHash } from "../../src/game/core/canonical.js";
import { Held } from "../../src/game/input/types.js";
import { advanceCombatLab, createCombatLab } from "../../src/game/labs/combat.js";

/** Actual controller motion off the authored range floor; no injected player-death command. */
export function playerLifeProof() {
  let state = createCombatLab("range"),
    restored = structuredClone(state);
  const hashes: string[] = [],
    notices: LifeNotice[] = [],
    checkpoints: Array<{ tick: number; life: string; since: number; lives: number }> = [];
  for (let tick = 1; tick <= 900; tick++) {
    const commands = [{ held: Held.Right, jumpPressed: false, firePressed: false }];
    const result = advanceCombatLab(state, commands);
    const replay = advanceCombatLab(restored, commands);
    state = result.state;
    restored = replay.state;
    if (
      stateHash(state) !== stateHash(restored) ||
      stateHash(result.lifeNotices) !== stateHash(replay.lifeNotices)
    )
      throw new Error(`Player life replay mismatch at ${tick}`);
    const player = state.players[0];
    if (!player) throw new Error("Missing life proof player");
    if (
      result.lifeNotices.length ||
      (player.life !== "alive" && tick - player.lifeStartTick === 6)
    ) {
      restored = JSON.parse(JSON.stringify(restored));
      checkpoints.push({
        tick,
        life: player.life,
        since: player.lifeStartTick,
        lives: player.lives,
      });
    }
    notices.push(...result.lifeNotices);
    hashes.push(stateHash(state));
    if (player.life === "spectating") break;
  }
  const player = state.players[0];
  if (
    player?.life !== "spectating" ||
    player.lives !== 0 ||
    notices.filter((notice) => notice.kind === "death").length !== 3
  )
    throw new Error("Three real falls did not consume exactly three lives");
  return {
    tick: state.tick,
    notices,
    checkpoints,
    player,
    traceHash: stateHash(hashes),
    finalHash: stateHash(state),
  };
}

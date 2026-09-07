import { canonical, stateHash } from "../../src/game/core/canonical.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../../src/shared/diagnostics/combat-checkpoint.js";
import { combatEventContext } from "../../src/shared/diagnostics/combat-events.js";
import {
  combatRuntimeHash,
  createCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { combatPeerContext } from "../../src/shared/diagnostics/combat-workload.js";
import { eventBatches } from "../../src/shared/protocol/event-stream.js";
import { decodeEventBatch, encodeEventBatch } from "../../src/shared/protocol/events.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

export const recordRifleRecovery = () => recordCombatInputs(createCombatRuntime("rifle"), 180, 0);

/** Real admitted inputs and hostile impacts, portable across Node, Chromium and workerd. */
export async function rifleRecoveryProof() {
  const { states, entries, state, reconciliations } = recordRifleRecovery();
  const identity = await combatArchiveIdentity();
  const firstDeath = states.find((state) =>
    state.combat.players.some((player) => player.life === "death"),
  );
  if (!firstDeath) throw new Error("Rifle fixture did not reach hostile damage");
  const checkpoints = [];
  for (const tick of [
    12,
    28,
    37,
    firstDeath.combat.tick,
    firstDeath.combat.tick + 30,
    firstDeath.combat.tick + 42,
  ]) {
    const original = states[tick],
      accepted = states[tick + 15];
    if (!original || !accepted) throw new Error("Missing rifle checkpoint boundary");
    const raw = await encodeCombatCheckpoint(original, identity);
    const restored = await decodeCombatCheckpoint(raw, identity);
    if (canonical(original) !== canonical(restored)) throw new Error("Rifle checkpoint diverged");
    const segment = await encodeCombatJournalSegment(
      original,
      entries.slice(tick, tick + 15),
      identity,
    );
    const resumed = await restoreCombatJournalSegment(restored, segment, identity);
    if (canonical(resumed) !== canonical(accepted)) throw new Error("Rifle replay diverged");
    const context = combatPeerContext(resumed.snapshot, 0);
    if (
      canonical(decodeSnapshot(encodeSnapshot(resumed.snapshot, context), context)) !==
      canonical(resumed.snapshot)
    )
      throw new Error("Rifle snapshot diverged");
    const eventContext = combatEventContext(context);
    const batches = eventBatches(
      resumed.history,
      original.history.cursor,
      eventContext.connectionEpoch,
    );
    if (!batches) throw new Error("Rifle checkpoint lost the event prefix");
    for (const batch of batches) {
      if (
        canonical(decodeEventBatch(encodeEventBatch(batch, eventContext), eventContext)) !==
        canonical(batch)
      )
        throw new Error("Enemy event wire identity diverged");
    }
    checkpoints.push({
      tick,
      checkpointBytes: new TextEncoder().encode(raw).byteLength,
      markerCursors: restored.combat.targets.map((target) => target.rifle?.action.nextMarkerIndex),
      targets: restored.combat.targets.map((target) => target.rifle?.targetId),
      threats: restored.snapshot.threats.length,
      resumedTick: resumed.combat.tick,
      hash: combatRuntimeHash(resumed),
      players: restored.combat.players.map(({ life, lives, invulnerableTicks }) => ({
        life,
        lives,
        invulnerableTicks,
      })),
    });
  }
  const firstBurst = states
    .slice(0, 73)
    .filter((state) =>
      state.combat.events.some((event) => event.ownerId === 20 && event.kind === "shot"),
    )
    .map((state) => state.combat.tick);
  if (canonical(firstBurst) !== canonical([25, 31, 37]))
    throw new Error("Authored rifle release changed");
  return {
    ticks: state.combat.tick,
    reconciliations,
    firstBurst,
    remainingFirstBurst: firstBurst.filter((tick) => tick > 28),
    firstDeathTick: firstDeath.combat.tick,
    checkpoints,
    stateHash: combatRuntimeHash(state),
    traceHash: stateHash(states.map(combatRuntimeHash)),
    scope:
      "Engineering rifle scenario; server hit outcomes correct movement prediction, no client prediction of hostile collisions or authored mission acceptance",
  };
}

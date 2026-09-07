import { canonical } from "../../src/game/core/canonical.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../../src/shared/diagnostics/combat-checkpoint.js";
import { transitionCombatRuntime } from "../../src/shared/diagnostics/combat-recovery.js";
import {
  combatRuntimeHash,
  createCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { controllerPeerContext } from "../../src/shared/diagnostics/controller-recovery.js";
import { probeContext } from "../../src/shared/diagnostics/room-workload.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

/** Four real admitted input streams walk and fire off the range floor until their lives run out. */
export function recordPlayerLifeRecovery() {
  const { state, states, entries } = recordCombatInputs(createCombatRuntime(), 900);
  if (!state.combat.players.every((player) => player.life === "spectating" && player.lives === 0))
    throw new Error("Missing exhausted party");
  const death = states.find((s) => s.combat.players[0]?.life === "death")?.combat.tick;
  const entry = states.find((s) => s.combat.players[0]?.life === "respawning")?.combat.tick;
  if (death === undefined || entry === undefined)
    throw new Error("Missing death or entry boundary");
  return { states, entries, death, entry, finalTick: state.combat.tick };
}
export async function playerLifeRecoveryProof() {
  const identity = await combatArchiveIdentity(),
    fixture = recordPlayerLifeRecovery();
  const checkpoints = [];
  for (const tick of [fixture.death + 6, fixture.entry + 6, fixture.finalTick]) {
    const captured = fixture.states[tick],
      through = Math.min(tick + 15, fixture.finalTick);
    if (!captured) throw new Error("Missing life checkpoint");
    const raw = await encodeCombatCheckpoint(captured, identity);
    let restored = await decodeCombatCheckpoint(raw, identity);
    if (canonical(restored) !== canonical(captured)) throw new Error("Life checkpoint mismatch");
    if (through > tick) {
      const segment = await encodeCombatJournalSegment(
        captured,
        fixture.entries.slice(tick, through),
        identity,
      );
      restored = await restoreCombatJournalSegment(restored, segment, identity);
    }
    if (canonical(restored) !== canonical(fixture.states[through]))
      throw new Error("Life journal continuation mismatch");
    const baseline = decodeSnapshot(
      encodeSnapshot(restored.snapshot, probeContext(0)),
      probeContext(0),
    );
    if (canonical(baseline.players) !== canonical(restored.combat.players))
      throw new Error("Life baseline lost state");
    checkpoints.push({
      tick,
      through,
      players: baseline.players.map((p) => ({
        playerId: p.playerId,
        life: p.life,
        lifeStartTick: p.lifeStartTick,
        deathBody: p.deathBody,
        lives: p.lives,
        invulnerableTicks: p.invulnerableTicks,
        weapon: p.weapon,
      })),
      bytes: new TextEncoder().encode(raw).byteLength,
      stateHash: combatRuntimeHash(restored),
    });
  }
  const wipe = fixture.states.at(-1);
  if (wipe?.campaign.state.phase !== "wipe") throw new Error("Missing actual campaign wipe");
  const continued = transitionCombatRuntime(wipe, "continue");
  const reset = await decodeCombatCheckpoint(
    await encodeCombatCheckpoint(continued, identity),
    identity,
  );
  if (canonical(reset) !== canonical(continued)) throw new Error("Continue checkpoint mismatch");
  const running = transitionCombatRuntime(reset, "start");
  const replay = recordCombatInputs(running, 15);
  const restored = await restoreCombatJournalSegment(
    running,
    await encodeCombatJournalSegment(running, replay.entries, identity),
    identity,
  );
  if (canonical(restored) !== canonical(replay.state))
    throw new Error("Continued input journal mismatch");
  const context = controllerPeerContext(restored.snapshot, 0);
  const baseline = decodeSnapshot(encodeSnapshot(restored.snapshot, context), context);
  if (canonical(baseline.players) !== canonical(restored.combat.players))
    throw new Error("Continued baseline mismatch");
  return {
    deathTick: fixture.death,
    entryTick: fixture.entry,
    finalTick: fixture.finalTick,
    checkpoints,
    continue: {
      wipeTick: wipe.combat.tick,
      runEpoch: continued.snapshot.runEpoch,
      campaign: restored.campaign,
      checkpointHash: combatRuntimeHash(continued),
      restoredHash: combatRuntimeHash(restored),
      through: restored.combat.tick,
      reconciliations: replay.reconciliations,
      players: baseline.players.map(
        ({ playerId, life, lifeStartTick, lives, invulnerableTicks, weapon }) => ({
          playerId,
          life,
          lifeStartTick,
          lives,
          invulnerableTicks,
          weapon,
        }),
      ),
    },
    scope:
      "Four admitted input streams, life/continue baselines, journal replay and reconciled life transitions; diagnostic checkpoint reset, no authored campaign or enemy damage",
  };
}

import { canonical } from "../../src/game/core/canonical.js";
import { Edge, Held } from "../../src/game/input/types.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../../src/shared/diagnostics/combat-checkpoint.js";
import {
  type CombatJournalTick,
  combatRuntimeHash,
  createCombatRuntime,
  stageCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { predictCombatMovement } from "../../src/shared/diagnostics/combat-workload.js";
import { probeContext } from "../../src/shared/diagnostics/room-workload.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

/** Four real admitted input streams walk and fire off the range floor until their lives run out. */
export function recordPlayerLifeRecovery() {
  let state = createCombatRuntime();
  const states = [structuredClone(state)],
    entries: CombatJournalTick[] = [];
  const streams = state.combat.players.map(
    (actor) =>
      new InputStream({ ...probeContext(actor.slot), controlEpoch: 1, baselineServerTick: 0 }),
  );
  for (let tick = 1; tick <= 900; tick++) {
    const predictions = [];
    for (const [slot, stream] of streams.entries()) {
      const command = {
        sequence: tick,
        clientTick: tick - 1,
        controlEpoch: 1,
        held: Held.Right | Held.Fire,
        aim: 0 as const,
        edges: tick === 1 ? [{ kind: Edge.FireOnset, id: 1 }] : [],
      };
      stream.receive(
        encodeInputBatch({
          ...probeContext(slot),
          packetSequence: tick,
          snapshotAck: 0,
          eventAck: 0,
          commands: [command],
        }),
        tick * 16,
        tick - 1,
      );
      const player = state.combat.players[slot];
      if (!player) throw new Error("Missing life recovery player");
      predictions.push(predictCombatMovement(player, command, tick));
    }
    let journal: CombatJournalTick | undefined;
    const committed = InputStream.processWorldTick(streams, tick, tick * 16, (prepared) => {
      const candidate = stageCombatRuntime(state, prepared);
      journal = candidate.journal;
      return candidate;
    });
    state = committed.state;
    if (!journal) throw new Error("Missing life journal");
    for (const [slot, player] of state.combat.players.entries()) {
      const prediction = predictions[slot];
      if (
        !prediction ||
        canonical([
          prediction.body,
          prediction.life,
          prediction.lifeStartTick,
          prediction.lives,
          prediction.invulnerableTicks,
        ]) !==
          canonical([
            player.body,
            player.life,
            player.lifeStartTick,
            player.lives,
            player.invulnerableTicks,
          ])
      )
        throw new Error(`Life movement prediction mismatch at ${tick}/${slot}`);
    }
    entries.push(journal);
    states.push(structuredClone(state));
    if (state.combat.players.every((player) => player.life === "spectating")) break;
  }
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
        lives: p.lives,
        invulnerableTicks: p.invulnerableTicks,
        weapon: p.weapon,
      })),
      bytes: new TextEncoder().encode(raw).byteLength,
      stateHash: combatRuntimeHash(restored),
    });
  }
  return {
    deathTick: fixture.death,
    entryTick: fixture.entry,
    finalTick: fixture.finalTick,
    checkpoints,
    scope:
      "Four admitted input streams, full life baselines, journal replay and per-tick movement prediction; no authored campaign or enemy damage",
  };
}

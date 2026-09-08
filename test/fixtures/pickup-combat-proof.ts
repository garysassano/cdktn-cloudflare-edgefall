import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held } from "../../src/game/input/types.js";
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
import { decodeEventBatch, encodeEventBatch } from "../../src/shared/protocol/events.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

export const PICKUP_COMBAT_TICKS = 150;
export const PICKUP_COMBAT_BOUNDARIES = [
  0, 1, 6, 7, 8, 9, 10, 12, 18, 23, 24, 25, 30, 45, 60, 75, 90, 105, 120, 135,
] as const;

/** Four actual admitted streams travel through shared supplies while holding Fire; all packets duplicate. */
export function recordPickupCombat() {
  return recordCombatInputs(
    createCombatRuntime("pickups"),
    PICKUP_COMBAT_TICKS,
    (tick) => ({
      held: (tick <= 110 ? Held.Right : 0) | (tick <= 128 ? Held.Fire | Held.Up : 0),
      edges: tick === 1 ? [Edge.FireOnset] : [],
    }),
    { duplicatePackets: true },
  );
}

export async function pickupCombatProof() {
  const fixture = recordPickupCombat(),
    identity = await combatArchiveIdentity(),
    checkpoints = [];
  const claims = fixture.states.flatMap((state) => state.combat.pickupClaims);
  if (claims.length !== 20 || new Set(claims.map((claim) => claim.claimId)).size !== 20)
    throw new Error("Individual pickup fixture claim count");
  for (const player of fixture.state.combat.players)
    if (
      player.lives !== 3 ||
      claims.filter((claim) => claim.playerId === player.playerId).length !== 5 ||
      player.weapon.id !== "laser"
    )
      throw new Error("Pickup sharing/terminal inventory diverged");
  if (!fixture.states.some((state) => state.combat.pickups.contacts.length > 0))
    throw new Error("Pickup route missed contact-entry continuation");
  const expired = fixture.state.combat.pickups.items.find((item) => item.id === 621);
  if (expired?.status !== "expired" || expired.resolvedTick !== 24)
    throw new Error("Pickup expiry boundary diverged");
  for (const tick of PICKUP_COMBAT_BOUNDARIES) {
    const original = fixture.states[tick],
      accepted = fixture.states[tick + 15];
    if (!original || !accepted) throw new Error("Missing pickup continuation boundary");
    const raw = await encodeCombatCheckpoint(original, identity),
      restored = await decodeCombatCheckpoint(raw, identity);
    const segment = await encodeCombatJournalSegment(
      original,
      fixture.entries.slice(tick, tick + 15),
      identity,
    );
    const resumed = await restoreCombatJournalSegment(restored, segment, identity);
    if (canonical(restored) !== canonical(original) || canonical(resumed) !== canonical(accepted))
      throw new Error("Pickup archive continuation diverged");
    const context = combatPeerContext(original.snapshot, 0),
      bytes = encodeSnapshot(original.snapshot, context);
    if (canonical(decodeSnapshot(bytes, context)) !== canonical(original.snapshot))
      throw new Error("Pickup public snapshot diverged");
    checkpoints.push({
      tick,
      hash: combatRuntimeHash(original),
      checkpointBytes: new TextEncoder().encode(raw).length,
      snapshotBytes: bytes.length,
      contacts: original.combat.pickups.contacts,
      items: original.combat.pickups.items,
      resumedTick: resumed.combat.tick,
      resumedHash: combatRuntimeHash(resumed),
    });
  }
  const events = fixture.states.flatMap((state) =>
    state.history.entries.filter((event) => event.tick === state.combat.tick),
  );
  const deliveries = [];
  const context = combatEventContext(fixture.state.snapshot);
  for (let index = 0; index < events.length; index += 64) {
    const batch = {
      runEpoch: context.runEpoch,
      connectionEpoch: context.connectionEpoch,
      throughTick: fixture.state.combat.tick,
      events: events.slice(index, index + 64),
    };
    const bytes = encodeEventBatch(batch, context);
    if (canonical(decodeEventBatch(bytes, context)) !== canonical(batch))
      throw new Error("Pickup event codec diverged");
    deliveries.push({ firstCursor: batch.events[0]?.cursor, bytes: bytes.length });
  }
  return {
    ticks: PICKUP_COMBAT_TICKS,
    claims,
    checkpoints,
    deliveries,
    events,
    duplicates: fixture.duplicates,
    finalHash: combatRuntimeHash(fixture.state),
    traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
    players: fixture.state.combat.players.map(({ weapon, lives }) => ({ weapon, lives })),
    scope:
      "Accepted inputs, individual supplies, exact inventory and contact latches through public snapshots, claim events and durable checkpoint/journal reconstruction. SQLite and actual network delivery use separate harnesses.",
  };
}

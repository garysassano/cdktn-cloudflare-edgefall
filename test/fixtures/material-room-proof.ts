import {
  MATERIAL_CASES,
  type MaterialLabDefinition,
  materialScenario,
} from "../../src/game/content/scenarios/materials.js";
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
import {
  combatPeerContext,
  combatSnapshotScenario,
  validateCombatGeometryTransition,
} from "../../src/shared/diagnostics/combat-workload.js";
import { decodeEventBatch, encodeEventBatch } from "../../src/shared/protocol/events.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";
import { MATERIAL_BOUNDARIES, MATERIAL_TICKS, recordMaterialCombat } from "./material-proof.js";

export const MATERIAL_ROOM_CASES: readonly MaterialLabDefinition[] = [1, 4].flatMap((players) =>
  MATERIAL_CASES.map((definition) => ({ ...definition, players })),
);
export const MATERIAL_ROOM_STORAGE_BOUNDARIES: readonly number[] = [0, 1, 12, 89, 90, 91, 120];
/** Actual admitted streams; retransmissions cannot duplicate an action or its damage budget. */
export function recordMaterialRoom(definition: MaterialLabDefinition) {
  return recordCombatInputs(
    createCombatRuntime(materialScenario(definition), definition.players),
    MATERIAL_TICKS,
    (tick) => ({
      held: definition.weapon === "grenade" ? Held.Down : 0,
      edges: tick === 1 ? [definition.weapon === "grenade" ? Edge.Grenade : Edge.FireOnset] : [],
    }),
    { duplicatePackets: true },
  );
}

export async function materialRoomProof(
  definitions: readonly MaterialLabDefinition[] = MATERIAL_ROOM_CASES,
) {
  const cases = [],
    identity = await combatArchiveIdentity();
  for (const definition of definitions) {
    const fixture = recordMaterialRoom(definition),
      local = recordMaterialCombat(definition),
      scenario = materialScenario(definition);
    for (const [tick, state] of fixture.states.entries()) {
      const expected = local.states[tick];
      if (!expected) throw new Error("Missing material inspector boundary");
      for (const field of [
        "props",
        "targets",
        "projectiles",
        "rockets",
        "beams",
        "strikes",
        "grenades",
        "areas",
        "events",
      ] as const)
        if (canonical(state.combat[field]) !== canonical(expected.world[field]))
          throw new Error(`Material room/inspector ${field} diverged at ${tick}`);
      for (const [slot, actor] of state.combat.players.entries())
        if (canonical(actor.weapon) !== canonical(expected.world.players[slot]?.weapon))
          throw new Error("Material inventory changed in input admission");
    }
    const checkpoints = [];
    for (const tick of MATERIAL_BOUNDARIES) {
      const original = fixture.states[tick],
        accepted = fixture.states[tick + 15];
      if (!original || !accepted) throw new Error("Missing material room continuation");
      const raw = await encodeCombatCheckpoint(original, identity),
        restored = await decodeCombatCheckpoint(raw, identity);
      const segment = await encodeCombatJournalSegment(
        original,
        fixture.entries.slice(tick, tick + 15),
        identity,
      );
      const resumed = await restoreCombatJournalSegment(restored, segment, identity);
      if (canonical(restored) !== canonical(original) || canonical(resumed) !== canonical(accepted))
        throw new Error("Material durable continuation diverged");
      const context = combatPeerContext(original.snapshot, 0),
        bytes = encodeSnapshot(original.snapshot, context),
        decoded = decodeSnapshot(bytes, context);
      if (
        canonical(decoded) !== canonical(original.snapshot) ||
        combatSnapshotScenario(decoded) !== scenario
      )
        throw new Error("Material public scene/geometry diverged");
      validateCombatGeometryTransition(original.snapshot, accepted.snapshot);
      checkpoints.push({
        tick,
        hash: combatRuntimeHash(original),
        checkpointBytes: new TextEncoder().encode(raw).length,
        snapshotBytes: bytes.length,
        props: original.combat.props,
        resumedTick: resumed.combat.tick,
        resumedHash: combatRuntimeHash(resumed),
      });
    }
    const initial = fixture.states[0];
    if (!initial) throw new Error("Missing material room baseline");
    for (const state of [initial, fixture.state]) {
      const context = combatPeerContext(state.snapshot, 0);
      if (
        canonical(decodeSnapshot(encodeSnapshot(state.snapshot, context), context)) !==
        canonical(state.snapshot)
      )
        throw new Error("Material initial/final projection mismatch");
    }
    const events = fixture.states.flatMap((state) =>
        state.history.entries.filter((event) => event.tick === state.combat.tick),
      ),
      context = combatEventContext(fixture.state.snapshot);
    for (let offset = 0; offset < events.length; offset += 64) {
      const batch = {
        runEpoch: context.runEpoch,
        connectionEpoch: context.connectionEpoch,
        throughTick: fixture.state.combat.tick,
        events: events.slice(offset, offset + 64),
      };
      if (
        canonical(decodeEventBatch(encodeEventBatch(batch, context), context)) !== canonical(batch)
      )
        throw new Error("Material event delivery codec diverged");
    }
    cases.push({
      definition,
      scenario,
      scenarioId: fixture.state.snapshot.combat?.scenarioId,
      ticks: MATERIAL_TICKS,
      duplicates: fixture.duplicates,
      reconciliations: fixture.reconciliations,
      checkpoints,
      events,
      props: fixture.state.combat.props,
      targetHealth: fixture.state.combat.targets.map((target) => target.health),
      players: fixture.state.combat.players.map((actor) => ({
        playerId: actor.playerId,
        weapon: actor.weapon,
        lives: actor.lives,
        grenadeStock: actor.grenadeStock,
      })),
      finalHash: combatRuntimeHash(fixture.state),
      traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
    });
  }
  return {
    cases,
    scope:
      "Registered one/four-player material scenarios using accepted inputs, public scene identity, snapshots/events and exact archive/journal replay. Actual SQLite processes and browser network delivery are verified separately.",
  };
}

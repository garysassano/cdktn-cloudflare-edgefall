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
import { eventBatches } from "../../src/shared/protocol/event-stream.js";
import { decodeEventBatch, encodeEventBatch } from "../../src/shared/protocol/events.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

export type FootCombatProofMode = "melee" | "grenade" | "crouched-grenade";
export function recordFootCombat(mode: FootCombatProofMode) {
  return recordCombatInputs(
    createCombatRuntime("range"),
    120,
    (tick) =>
      mode === "melee"
        ? { held: tick <= 45 ? Held.Right : Held.Fire, edges: tick === 46 ? [Edge.FireOnset] : [] }
        : {
            held: mode === "crouched-grenade" ? Held.Down : 0,
            edges: tick === 1 || tick === 3 ? [Edge.Grenade] : [],
          },
    { duplicatePackets: true },
  );
}

/** Admitted four-player action inputs, wire frames and private continuation in all three runtimes. */
export async function footCombatProof() {
  const identity = await combatArchiveIdentity();
  const scenarios = [];
  for (const mode of ["melee", "grenade", "crouched-grenade"] as const) {
    const fixture = recordFootCombat(mode);
    const checkpoints = [];
    for (const tick of mode === "melee" ? [46, 50, 51, 54] : [1, 4, 5, 50, 51, 76, 88, 94, 95]) {
      const original = fixture.states[tick],
        accepted = fixture.states[tick + 15];
      if (!original || !accepted) throw new Error("Missing foot combat boundary");
      const raw = await encodeCombatCheckpoint(original, identity);
      const restored = await decodeCombatCheckpoint(raw, identity);
      if (canonical(restored) !== canonical(original)) throw new Error("Foot checkpoint diverged");
      const segment = await encodeCombatJournalSegment(
        original,
        fixture.entries.slice(tick, tick + 15),
        identity,
      );
      const resumed = await restoreCombatJournalSegment(restored, segment, identity);
      if (canonical(resumed) !== canonical(accepted))
        throw new Error("Foot action replay diverged");
      const context = combatPeerContext(original.snapshot, 0);
      const bytes = encodeSnapshot(original.snapshot, context);
      if (canonical(decodeSnapshot(bytes, context)) !== canonical(original.snapshot))
        throw new Error("Foot action snapshot diverged");
      const eventContext = combatEventContext(context);
      const batches = eventBatches(
        resumed.history,
        original.history.cursor,
        context.connectionEpoch,
      );
      if (!batches) throw new Error("Foot action lost event prefix");
      for (const batch of batches)
        if (
          canonical(decodeEventBatch(encodeEventBatch(batch, eventContext), eventContext)) !==
          canonical(batch)
        )
          throw new Error("Foot action event frame diverged");
      checkpoints.push({
        tick,
        checkpointBytes: new TextEncoder().encode(raw).byteLength,
        snapshotBytes: bytes.byteLength,
        hash: combatRuntimeHash(restored),
        resumedHash: combatRuntimeHash(resumed),
        resumedTick: resumed.combat.tick,
        stocks: original.combat.players.map((player) => player.grenadeStock),
        cursors: original.combat.players.map((player) => player.action.nextMarkerIndex),
        hitIds: original.combat.strikes.map((strike) => strike.hitIds),
        grenades: original.combat.grenades.map(({ id, spawnTick, bounces, body }) => ({
          id,
          spawnTick,
          bounces,
          x: body.x,
          y: body.y,
          vx: body.vx,
          vy: body.vy,
        })),
      });
    }
    const notices = fixture.states.flatMap((state) =>
      state.combat.events.map((event) => ({ tick: state.combat.tick, ...event })),
    );
    const actions = notices
      .filter((event) => ["melee", "throw", "explosion", "killed"].includes(event.kind))
      .map(({ tick, kind, ownerId, actionInstanceId, targetId }) => ({
        tick,
        kind,
        ownerId,
        actionInstanceId,
        targetId,
      }));
    const releases = actions.filter(
      (event) => event.kind === (mode === "melee" ? "melee" : "throw"),
    );
    if (
      canonical(releases.map((event) => event.tick)) !==
      canonical(Array(4).fill(mode === "melee" ? 51 : 5))
    )
      throw new Error("Foot action release duplicated or mistimed");
    if (mode !== "melee") {
      if (fixture.state.combat.players.some((player) => player.grenadeStock !== 9))
        throw new Error("Duplicate or busy grenade input spent stock");
      const detonations = actions.filter((event) => event.kind === "explosion");
      if (canonical(detonations.map((event) => event.tick)) !== canonical([95, 95, 95, 95]))
        throw new Error("Grenade fuse duplicated or mistimed");
    }
    scenarios.push({
      mode,
      ticks: fixture.state.combat.tick,
      duplicates: fixture.duplicates,
      reconciliations: fixture.reconciliations,
      actions,
      checkpoints,
      stateHash: combatRuntimeHash(fixture.state),
      traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
    });
  }
  return {
    scenarios,
    scope:
      "Engineering range, actual admitted intent and exact private recovery; no authored mission or final art acceptance",
  };
}

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

export type ShieldProofMode = "bash" | "break";
export const SHIELD_BOUNDARIES = {
  bash: [18, 29, 30, 33, 48, 56, 57, 65],
  break: [34, 35, 53, 61, 62, 94, 95, 130, 131],
} as const;

/** Four ordinary input streams; no world mutation or injected damage. */
export function recordShieldCombat(mode: ShieldProofMode) {
  return recordCombatInputs(
    createCombatRuntime("guard"),
    180,
    (tick) =>
      mode === "bash"
        ? { held: tick <= 32 ? Held.Right : Held.Down }
        : {
            held:
              tick <= 5
                ? Held.Down
                : tick <= 56
                  ? Held.Right
                  : tick <= 131
                    ? Held.Down
                    : tick <= 133
                      ? Held.Left | Held.Fire
                      : tick < 146
                        ? Held.Down | Held.Fire
                        : tick === 146
                          ? Held.Right | Held.Fire
                          : Held.Down | Held.Fire,
            edges:
              tick === 1
                ? [Edge.Grenade]
                : tick === 24
                  ? [Edge.Jump]
                  : tick === 132
                    ? [Edge.FireOnset]
                    : [],
          },
    { duplicatePackets: true },
  );
}

/** Wire and private continuation at turn, bash, break and stun boundaries in each runtime. */
export async function shieldCombatProof() {
  const identity = await combatArchiveIdentity();
  const scenarios = [];
  for (const mode of ["bash", "break"] as const) {
    const fixture = recordShieldCombat(mode);
    const checkpoints = [];
    for (const tick of SHIELD_BOUNDARIES[mode]) {
      const original = fixture.states[tick],
        accepted = fixture.states[tick + 15];
      if (!original || !accepted) throw new Error("Missing shield boundary");
      const raw = await encodeCombatCheckpoint(original, identity);
      const restored = await decodeCombatCheckpoint(raw, identity);
      if (canonical(restored) !== canonical(original))
        throw new Error("Shield checkpoint diverged");
      const segment = await encodeCombatJournalSegment(
        original,
        fixture.entries.slice(tick, tick + 15),
        identity,
      );
      const resumed = await restoreCombatJournalSegment(restored, segment, identity);
      if (canonical(resumed) !== canonical(accepted)) throw new Error("Shield replay diverged");
      const context = combatPeerContext(original.snapshot, 0);
      const bytes = encodeSnapshot(original.snapshot, context);
      if (canonical(decodeSnapshot(bytes, context)) !== canonical(original.snapshot))
        throw new Error("Shield snapshot diverged");
      const events = eventBatches(
        resumed.history,
        original.history.cursor,
        context.connectionEpoch,
      );
      if (!events) throw new Error("Shield events lost prefix");
      const eventContext = combatEventContext(context);
      for (const batch of events)
        if (
          canonical(decodeEventBatch(encodeEventBatch(batch, eventContext), eventContext)) !==
          canonical(batch)
        )
          throw new Error("Shield event wire diverged");
      checkpoints.push({
        tick,
        checkpointBytes: new TextEncoder().encode(raw).byteLength,
        snapshotBytes: bytes.byteLength,
        guard: original.combat.targets[0]?.guard,
        threats: original.snapshot.threats,
        hash: combatRuntimeHash(original),
        resumedTick: resumed.combat.tick,
        resumedHash: combatRuntimeHash(resumed),
      });
    }
    const events = fixture.states.flatMap((state) =>
      state.combat.events
        .filter((event) => ["melee", "killed", "shield-break", "explosion"].includes(event.kind))
        .map((event) => ({
          tick: state.combat.tick,
          kind: event.kind,
          ownerId: event.ownerId,
          targetId: event.targetId,
          actionInstanceId: event.actionInstanceId,
        })),
    );
    if (
      mode === "bash" &&
      (fixture.states[30]?.combat.targets[0]?.guard?.hitIds.length !== 3 ||
        fixture.states[56]?.combat.targets[0]?.guard?.facing !== -1 ||
        fixture.states[57]?.combat.targets[0]?.guard?.facing !== 1)
    )
      throw new Error("Bash or committed turn evidence missing");
    if (
      mode === "break" &&
      (events.filter((event) => event.kind === "shield-break").length !== 1 ||
        fixture.states[95]?.combat.targets[0]?.health !== 1 ||
        fixture.states[95]?.combat.targets[0]?.guard?.integrity !== 0 ||
        fixture.states[95]?.combat.players.some((player) => player.lives !== 3))
    )
      throw new Error("Blast counterplay or evasion evidence missing");
    scenarios.push({
      mode,
      ticks: fixture.state.combat.tick,
      duplicates: fixture.duplicates,
      checkpoints,
      events,
      finalHash: combatRuntimeHash(fixture.state),
      traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
      encounter: fixture.state.combat.encounter.phase,
    });
  }
  return {
    scenarios,
    scope:
      "Admitted four-player engineering shield/rifle encounter; committed turn, bash hit ledger, jump evasion, grenade guard break and fragile body; no authored mission or production timing acceptance",
  };
}

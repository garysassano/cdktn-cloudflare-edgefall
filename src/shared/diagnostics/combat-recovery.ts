import { stateHash } from "../../game/core/canonical.js";
import { createEventHistory } from "../protocol/event-stream.js";
import type { FullSnapshot } from "../protocol/snapshot-schema.js";
import type { CombatRuntime } from "./combat-runtime.js";
import { combatSnapshot } from "./combat-workload.js";
import { recoverControllerWorld } from "./controller-recovery.js";
import { roomWorkloadHash } from "./room-workload.js";

/** Public continuation proof across recovery; only transport and cleared input intent are normalized. */
export function combatContinuationHash(current: FullSnapshot): string {
  const snapshot = structuredClone(current);
  snapshot.runEpoch = 1;
  snapshot.connectionEpoch = 1;
  snapshot.snapshotId = 1;
  snapshot.stateHash = 0;
  snapshot.baselineEventCursor = 0;
  snapshot.roomMode = "loading";
  for (const player of snapshot.players) {
    player.controlEpoch = 1;
    player.jumpBufferTicks = 0;
    player.processedEdgeIds = [0, 0, 0, 0, 0];
  }
  for (const acknowledgment of snapshot.acknowledgments) {
    acknowledgment.controlEpoch = 1;
    acknowledgment.connectionEpoch = 1;
    acknowledgment.lastProcessedSequence = 0;
    acknowledgment.appliedAtServerTick = 0;
    acknowledgment.processedEdgeIds = [0, 0, 0, 0, 0];
  }
  return stateHash(snapshot);
}

/** A persisted boundary replaces old input/effect generations before any replacement welcome. */
export function transitionCombatRuntime(
  current: CombatRuntime,
  kind: "start" | "recover" | "pause" | "expire",
): CombatRuntime {
  const state = structuredClone(current);
  if (["completed", "expired"].includes(current.snapshot.roomMode))
    throw new Error("Terminal combat room cannot resume");
  if (kind === "pause" || kind === "expire") {
    if (
      kind === "pause"
        ? !["loading", "playing"].includes(current.snapshot.roomMode)
        : !["loading", "playing", "paused-empty", "recovering"].includes(current.snapshot.roomMode)
    )
      throw new Error("Invalid empty combat boundary");
    state.snapshot.roomMode = kind === "pause" ? "paused-empty" : "expired";
    state.connectedPlayerIds = [];
  } else if (kind === "start") {
    if (current.snapshot.roomMode !== "loading")
      throw new Error("Combat start requires loading barrier");
    state.snapshot.roomMode = "playing";
  } else {
    state.snapshot = recoverControllerWorld(current.snapshot);
    state.combat.players = structuredClone(state.snapshot.players);
    state.combat.events = [];
    state.connectedPlayerIds = [];
    state.history = { ...createEventHistory(state.snapshot.runEpoch), tick: state.combat.tick };
    state.snapshot.baselineEventCursor = 0;
    state.snapshot.snapshotId = 1;
    state.snapshot.connectionEpoch = state.snapshot.acknowledgments[0]?.connectionEpoch ?? 0;
    state.snapshot = combatSnapshot(state.combat, state.snapshot);
  }
  state.snapshot.stateHash = roomWorkloadHash(state.snapshot);
  return state;
}

import { stateHash } from "../../game/core/canonical.js";
import { nextCounter } from "../../game/core/numeric.js";
import { continueCombatCheckpoint } from "../../game/labs/combat-campaign.js";
import { createEventHistory } from "../protocol/event-stream.js";
import type { FullSnapshot } from "../protocol/snapshot-schema.js";
import { isPausableRoom, isWaitingRoom } from "../session/room-phase.js";
import type { CombatRuntime } from "./combat-runtime.js";
import { combatSnapshot } from "./combat-workload.js";
import { recoverControllerWorld } from "./controller-recovery.js";
import { roomWorkloadHash } from "./room-workload.js";

/** Replace one waiting connection without advancing combat or restarting its firearm action. */
export function replaceWaitingCombatConnection(
  current: CombatRuntime,
  playerId: number,
): CombatRuntime {
  if (!isWaitingRoom(current.snapshot.roomMode))
    throw new Error("Connection replacement requires waiting phase");
  const state = structuredClone(current);
  const actor = state.combat.players.find((player) => player.playerId === playerId);
  const ack = state.snapshot.acknowledgments.find((value) => value.playerId === playerId);
  if (!actor || !ack) throw new Error("Missing loading connection owner");
  if (actor.vehicleId !== null) throw new Error("Loading connection does not own vehicle handoff");
  ack.connectionEpoch = nextCounter(ack.connectionEpoch);
  ack.lastProcessedSequence = 0;
  ack.appliedAtServerTick = 0;
  ack.processedEdgeIds = [0, 0, 0, 0, 0];
  actor.jumpBufferTicks = 0;
  actor.processedEdgeIds = [0, 0, 0, 0, 0];
  state.snapshot.players = structuredClone(state.combat.players);
  if (
    !state.snapshot.acknowledgments.some(
      (a) => a.connectionEpoch === state.snapshot.connectionEpoch,
    )
  )
    state.snapshot.connectionEpoch = ack.connectionEpoch;
  state.snapshot.stateHash = roomWorkloadHash(state.snapshot);
  return state;
}

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
  kind: "load" | "start" | "recover" | "pause" | "expire" | "continue",
): CombatRuntime {
  const state = structuredClone(current);
  if (
    current.snapshot.roomMode === "expired" ||
    (current.snapshot.roomMode === "completed" && kind !== "expire")
  )
    throw new Error("Terminal combat room cannot resume");
  if (kind === "continue") {
    if (current.snapshot.roomMode !== "intermission" || current.pausedFrom !== null)
      throw new Error("Continue requires a confirmed wipe boundary");
    const reset = continueCombatCheckpoint(
      current.combat,
      current.campaign,
      current.snapshot.runEpoch,
    );
    state.combat = reset.combat;
    state.campaign = reset.campaign;
    state.snapshot = combatSnapshot(state.combat, state.snapshot, state.campaign);
    state.snapshot = recoverControllerWorld(state.snapshot);
    state.snapshot.roomMode = "loading";
    state.combat.players = structuredClone(state.snapshot.players);
    state.history = { ...createEventHistory(state.snapshot.runEpoch), tick: state.combat.tick };
    state.connectedPlayerIds = [];
    state.snapshot.baselineEventCursor = 0;
    state.snapshot.snapshotId = 1;
    state.snapshot.connectionEpoch = state.snapshot.acknowledgments[0]?.connectionEpoch ?? 0;
    state.snapshot = combatSnapshot(state.combat, state.snapshot, state.campaign);
  } else if (kind === "pause" || kind === "expire") {
    if (
      kind === "pause"
        ? !isPausableRoom(current.snapshot.roomMode)
        : ![
            "lobby",
            "loading",
            "playing",
            "intermission",
            "paused-empty",
            "recovering",
            "completed",
          ].includes(current.snapshot.roomMode)
    )
      throw new Error("Invalid empty combat boundary");
    state.snapshot.roomMode = kind === "pause" ? "paused-empty" : "expired";
    state.pausedFrom =
      kind === "pause" && isPausableRoom(current.snapshot.roomMode)
        ? current.snapshot.roomMode
        : null;
    state.connectedPlayerIds = [];
  } else if (kind === "load") {
    if (!["lobby", "intermission"].includes(current.snapshot.roomMode))
      throw new Error("Load requires lobby or intermission");
    if (["wipe", "defeat"].includes(current.campaign.state.phase))
      throw new Error("A wiped campaign cannot load without a continue");
    state.snapshot.roomMode = "loading";
  } else if (kind === "start") {
    if (current.snapshot.roomMode !== "loading")
      throw new Error("Combat start requires loading barrier");
    state.snapshot.roomMode = "playing";
  } else {
    const origin = current.pausedFrom ?? current.snapshot.roomMode;
    state.snapshot = recoverControllerWorld(current.snapshot);
    if (origin === "lobby" || origin === "intermission") state.snapshot.roomMode = origin;
    state.pausedFrom = null;
    state.combat.players = structuredClone(state.snapshot.players);
    state.combat.events = [];
    state.connectedPlayerIds = [];
    state.history = { ...createEventHistory(state.snapshot.runEpoch), tick: state.combat.tick };
    state.snapshot.baselineEventCursor = 0;
    state.snapshot.snapshotId = 1;
    state.snapshot.connectionEpoch = state.snapshot.acknowledgments[0]?.connectionEpoch ?? 0;
    state.snapshot = combatSnapshot(state.combat, state.snapshot, state.campaign);
  }
  state.snapshot.stateHash = roomWorkloadHash(state.snapshot);
  return state;
}

import { canonical, stateHash } from "../../game/core/canonical.js";
import { COUNTER_LIMIT, integer } from "../../game/core/numeric.js";
import type { BoundaryEvent, JournalTick } from "../../game/input/journal.js";
import {
  EDGE_KINDS,
  HELD_MASK,
  type InputCommand,
  type PlayerAcknowledgment,
} from "../../game/input/types.js";
import type { CombatLab, CombatScenario } from "../../game/labs/combat.js";
import {
  type CombatCampaign,
  advanceCombatCampaign,
  createCombatCampaign,
} from "../../game/labs/combat-campaign.js";
import { type EventHistory, createEventHistory, stageEventTick } from "../protocol/event-stream.js";
import type { PreparedPlayerTick } from "../protocol/input-stream.js";
import type { FullSnapshot } from "../protocol/snapshot-schema.js";
import type { PausableRoomMode } from "../session/room-phase.js";
import { combatEventContext, combatGameplayEvents } from "./combat-events.js";
import {
  createCombatWorkload,
  evaluateCombatTick,
  projectCombatCampaign,
} from "./combat-workload.js";
import { roomWorkloadHash } from "./room-workload.js";

export interface CombatRuntime {
  combat: CombatLab;
  snapshot: FullSnapshot;
  history: EventHistory;
  connectedPlayerIds: number[];
  pausedFrom: PausableRoomMode | null;
  campaign: CombatCampaign;
}
export interface CombatJournalTick extends JournalTick {
  acknowledgments: PlayerAcknowledgment[];
  beforeHash: string;
}
export interface CombatConnectionChange {
  playerId: number;
  connectionEpoch: number;
}
export function createCombatRuntime(scenario: CombatScenario = "range"): CombatRuntime {
  const state = createCombatWorkload(scenario);
  const campaign = createCombatCampaign(state.combat);
  projectCombatCampaign(state.snapshot, campaign);
  state.snapshot.roomMode = "playing";
  state.snapshot.stateHash = roomWorkloadHash(state.snapshot);
  return {
    ...state,
    history: createEventHistory(state.snapshot.runEpoch),
    connectedPlayerIds: state.combat.players.map((p) => p.playerId),
    pausedFrom: null,
    campaign,
  };
}
/** Per-reader send headers do not affect gameplay and are not journaled as external causes. */
export function combatRuntimeHash(state: CombatRuntime): string {
  const {
    connectionEpoch: _connection,
    snapshotId: _snapshot,
    stateHash: _hash,
    ...snapshot
  } = state.snapshot;
  return stateHash({
    combat: state.combat,
    snapshot,
    history: state.history,
    connectedPlayerIds: state.connectedPlayerIds,
    pausedFrom: state.pausedFrom,
    campaign: state.campaign,
  });
}
function check(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`Combat journal: ${message}`);
}
function command(value: InputCommand, allowZero: boolean) {
  integer(value.sequence, allowZero ? 0 : 1, COUNTER_LIMIT - 1, "journal command sequence");
  integer(value.clientTick, 0, COUNTER_LIMIT - 1, "journal client tick");
  integer(value.controlEpoch, 1, COUNTER_LIMIT - 1, "journal control epoch");
  integer(value.held, 0, HELD_MASK, "journal held mask");
  integer(value.aim, 0, 2, "journal aim");
  integer(value.edges.length, 0, 8, "journal edge count");
  let kind = 0,
    id = 0;
  for (const edge of value.edges) {
    check(
      EDGE_KINDS.includes(edge.kind) && (edge.kind > kind || (edge.kind === kind && edge.id > id)),
      "edge order",
    );
    integer(edge.id, 1, COUNTER_LIMIT - 1, "journal edge ID");
    kind = edge.kind;
    id = edge.id;
  }
}
function validatePrepared(current: CombatRuntime, prepared: readonly PreparedPlayerTick[]) {
  integer(prepared.length, 0, 4, "journal owner count");
  let previousId = 0;
  for (const item of prepared) {
    const { input, acknowledgment } = item;
    const previous = current.snapshot.acknowledgments.find((a) => a.playerId === input.playerId);
    check(previous && input.playerId > previousId, "unknown/duplicate/unordered input owner");
    previousId = input.playerId;
    check(input.serverTick === current.combat.tick + 1, "nonconsecutive applied input");
    check(["applied", "stale", "old-control"].includes(input.outcome), "input admission outcome");
    check(
      typeof item.neutralized === "boolean" && (!item.neutralized || input.outcome === "stale"),
      "neutralization decision",
    );
    check(input.repeatedHeld === (input.submittedCommand === null), "held-repeat decision");
    command(input.command, input.submittedCommand === null);
    check(!input.repeatedHeld || input.command.edges.length === 0, "repeated action edge");
    check(
      input.outcome === "applied" ||
        (input.command.held === 0 && input.command.aim === 0 && input.command.edges.length === 0),
      "rejected input not neutral",
    );
    if (input.outcome === "applied")
      check(input.command.controlEpoch === previous.controlEpoch, "applied old control");
    const expected = structuredClone(previous);
    if (input.submittedCommand !== null) {
      const submitted = input.submittedCommand;
      command(submitted, false);
      check(submitted.sequence > previous.lastProcessedSequence, "sequence reuse");
      check(
        input.outcome === "old-control"
          ? submitted.controlEpoch !== previous.controlEpoch
          : submitted.controlEpoch === previous.controlEpoch,
        "control rejection mismatch",
      );
      const normalized = structuredClone(submitted);
      if (input.outcome !== "applied") {
        normalized.held = 0;
        normalized.aim = 0;
        normalized.edges = [];
      }
      check(canonical(input.command) === canonical(normalized), "submitted/applied mismatch");
      expected.lastProcessedSequence = submitted.sequence;
      expected.appliedAtServerTick = input.serverTick;
      for (const edge of submitted.edges) {
        check(edge.id > (expected.processedEdgeIds[edge.kind - 1] ?? 0), "edge cursor reuse");
        expected.processedEdgeIds[edge.kind - 1] = edge.id;
      }
    }
    check(canonical(expected) === canonical(acknowledgment), "acknowledgment continuation");
  }
}
/** Same pure candidate for live coordinated input commits and committed-journal reconstruction. */
export function stageCombatRuntime(
  current: CombatRuntime,
  prepared: readonly PreparedPlayerTick[],
  connections: readonly CombatConnectionChange[] = [],
) {
  check(
    current.snapshot.roomMode === "playing" && current.pausedFrom === null,
    "combat requires playing phase",
  );
  integer(connections.length, 0, 4, "combat connection changes");
  const baseline = connections.length ? structuredClone(current) : current;
  let previousConnectionPlayer = 0;
  for (const connection of connections) {
    const actor = baseline.combat.players.find((p) => p.playerId === connection.playerId);
    const ack = baseline.snapshot.acknowledgments.find((a) => a.playerId === connection.playerId);
    const input = prepared.find((p) => p.input.playerId === connection.playerId);
    check(
      actor && ack && input && connection.playerId > previousConnectionPlayer,
      "connection owner/order",
    );
    integer(connection.connectionEpoch, 1, COUNTER_LIMIT - 1, "connection epoch");
    check(
      connection.connectionEpoch === ack.connectionEpoch + 1,
      "connection generation must advance once",
    );
    check(actor.vehicleId === null, "combat connection does not own vehicle handoff");
    check(input.input.submittedCommand === null, "new connection must begin with a fresh baseline");
    const fresh = input.input.command;
    check(
      fresh.sequence === 0 &&
        fresh.clientTick === 0 &&
        fresh.held === 0 &&
        fresh.aim === 0 &&
        fresh.edges.length === 0,
      "new connection must discard prior intent",
    );
    previousConnectionPlayer = connection.playerId;
    // A new socket does not change on-foot ownership or restart an in-progress firearm action.
    actor.jumpBufferTicks = 0;
    actor.processedEdgeIds = [0, 0, 0, 0, 0];
    ack.connectionEpoch = connection.connectionEpoch;
    ack.lastProcessedSequence = 0;
    ack.appliedAtServerTick = 0;
    ack.processedEdgeIds = [0, 0, 0, 0, 0];
  }
  if (connections.length) baseline.snapshot.players = structuredClone(baseline.combat.players);
  validatePrepared(baseline, prepared);
  const result = evaluateCombatTick(baseline.combat, baseline.snapshot, prepared);
  if (
    !result.state.snapshot.acknowledgments.some(
      (a) => a.connectionEpoch === result.state.snapshot.connectionEpoch,
    )
  ) {
    const recipient = result.state.snapshot.acknowledgments[0];
    if (!recipient) throw new Error("Missing snapshot recipient");
    result.state.snapshot.connectionEpoch = recipient.connectionEpoch;
  }
  const history = stageEventTick(
    current.history,
    result.state.combat.tick,
    combatGameplayEvents(current.combat, result.state.combat),
    combatEventContext(current.snapshot),
  );
  result.state.snapshot.baselineEventCursor = history.cursor;
  result.state.snapshot.stateHash = roomWorkloadHash(result.state.snapshot);
  const connectedPlayerIds = prepared.map((p) => p.input.playerId);
  const campaign = advanceCombatCampaign(current.campaign, result.state.combat, connectedPlayerIds);
  projectCombatCampaign(result.state.snapshot, campaign);
  if (campaign.state.phase === "wipe" || campaign.state.phase === "defeat")
    result.state.snapshot.roomMode = "intermission";
  result.state.snapshot.stateHash = roomWorkloadHash(result.state.snapshot);
  const state: CombatRuntime = {
    ...result.state,
    history,
    connectedPlayerIds,
    pausedFrom: null,
    campaign,
  };
  const boundary: BoundaryEvent[] = [];
  for (const player of current.combat.players) {
    const was = current.connectedPlayerIds.includes(player.playerId),
      connected = connectedPlayerIds.includes(player.playerId);
    const replacement = connections.find((value) => value.playerId === player.playerId);
    if (replacement) {
      boundary.push({ kind: "neutralize", playerId: player.playerId, reason: "disconnect" });
      boundary.push({
        kind: "connection",
        playerId: player.playerId,
        connectionEpoch: replacement.connectionEpoch,
        connected: true,
      });
    } else if (was !== connected) {
      const ack = state.snapshot.acknowledgments.find((a) => a.playerId === player.playerId);
      if (!ack) throw new Error("Missing combat connection owner");
      boundary.push({
        kind: "connection",
        playerId: player.playerId,
        connectionEpoch: ack.connectionEpoch,
        connected,
      });
      if (!connected)
        boundary.push({ kind: "neutralize", playerId: player.playerId, reason: "disconnect" });
    }
  }
  for (const item of prepared)
    if (item.neutralized)
      boundary.push({ kind: "neutralize", playerId: item.input.playerId, reason: "stale" });
  const journal: CombatJournalTick = {
    tick: state.combat.tick,
    runEpoch: state.snapshot.runEpoch,
    inputs: prepared.map((item, index) => ({
      input: structuredClone(item.input),
      edgeResults:
        item.input.outcome === "applied"
          ? structuredClone([...(result.outcomes[index]?.edgeResults ?? [])])
          : (item.input.submittedCommand?.edges ?? []).map((edge) => ({
              ...edge,
              outcome: item.input.outcome,
            })),
    })),
    acknowledgments: prepared.map((p) => structuredClone(p.acknowledgment)),
    boundaryEvents: boundary.map((event, order) => ({ order, event })),
    beforeHash: combatRuntimeHash(current),
    assertions: [{ kind: "state-hash", value: combatRuntimeHash(state) }],
  };
  return { state, outcomes: result.outcomes, journal };
}
export function replayCombatTick(
  current: CombatRuntime,
  journal: CombatJournalTick,
): CombatRuntime {
  check(
    journal.runEpoch === current.snapshot.runEpoch &&
      journal.tick === current.combat.tick + 1 &&
      journal.beforeHash === combatRuntimeHash(current),
    "missing/changed journal prefix",
  );
  integer(journal.inputs.length, 0, 4, "journal input count");
  integer(journal.boundaryEvents.length, 0, 12, "journal boundary count");
  check(journal.acknowledgments.length === journal.inputs.length, "journal acknowledgment count");
  const prepared = journal.inputs.map(({ input }, index): PreparedPlayerTick => {
    const acknowledgment = journal.acknowledgments[index];
    if (!acknowledgment) throw new Error("Missing journal acknowledgment");
    return {
      input,
      acknowledgment,
      neutralized: journal.boundaryEvents.some(
        ({ event }) =>
          event.kind === "neutralize" &&
          event.playerId === input.playerId &&
          event.reason === "stale",
      ),
    };
  });
  const connections = journal.boundaryEvents.flatMap(({ event }): CombatConnectionChange[] => {
    if (event.kind !== "connection" || !event.connected) return [];
    const before = current.snapshot.acknowledgments.find((a) => a.playerId === event.playerId);
    return before && event.connectionEpoch !== before.connectionEpoch
      ? [{ playerId: event.playerId, connectionEpoch: event.connectionEpoch }]
      : [];
  });
  const result = stageCombatRuntime(current, prepared, connections);
  check(canonical(result.journal) === canonical(journal), "journal outcome/boundary/hash mismatch");
  return result.state;
}

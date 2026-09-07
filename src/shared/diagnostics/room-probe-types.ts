import type { PlayerAcknowledgment } from "../../game/input/types.js";
import type { CombatLab } from "../../game/labs/combat.js";
import type { EventBaseline, EventEnvelope } from "../protocol/events.js";
import type { RoomMember } from "../session/membership.js";
import type { PausableRoomMode } from "../session/room-phase.js";
import type { CombatJournalWriter } from "./combat-writer.js";

export interface PeerMetrics {
  slot: number;
  active: boolean;
  inputFrames: number;
  inputBytes: number;
  renewedFrames: number;
  acknowledgmentOnlyFrames: number;
  snapshots: number;
  snapshotBytes: number;
  inputMappingBytes: number;
  eventBytes: number;
  eventFrames: number;
  eventSentCursor: number;
  eventBaselines: number;
  maxQueuedCommands: number;
  neutralizedAtTick: number | null;
  expiredAtTick: number | null;
  closeReason: string | null;
  lastInputError: string | null;
  lastOutputError: string | null;
  lastProcessedSequence: number;
  lastHeld: number;
}
export interface RoomProbeStatus {
  pausedFrom: PausableRoomMode | null;
  emptyPause: { tick: number; runEpoch: number; hash: string } | null;
  alarmAtMs: number | null;
  alarmDeliveries: number;
  connections: Array<{
    slot: number;
    tick: number;
    connectionEpoch: number;
    controlEpoch: number;
    baselineEventCursor: number;
  }>;
  staleSocketEvents: number;
  membership: {
    epoch: number;
    hostSlot: number | null;
    members: Array<Omit<RoomMember, "profileId">>;
  } | null;
  instanceId: string;
  worldFailure: string | null;
  persistenceFailure: string | null;
  persistenceHeld: boolean;
  /** Local elapsed preparation/confirmation durations; these are not production CPU measurements. */
  persistenceCommits: Array<{
    runEpoch: number;
    fromTick: number;
    throughTick: number;
    prepareMs: number;
    confirmMs: number;
  }>;
  durability: CombatJournalWriter["status"] | null;
  recoveryBoundary: {
    fromRunEpoch: number;
    restoredTick: number;
    restoredHash: string;
    runEpoch: number;
  } | null;
  inputStreams: Array<{
    acknowledgment: PlayerAcknowledgment;
    queued: number;
    requiresResync: boolean;
    delivery: { snapshot: number; event: number };
    pendingEventBaseline: EventBaseline | null;
    initialBaseline: { snapshotId: number; cursor: number } | null;
  }>;
  combat: {
    world: CombatLab;
    events: EventEnvelope[];
    eventCursor: number;
    ageEvictions: number;
    droppedEvents: number;
  } | null;
  runEpoch: number;
  recoveries: number;
  workload: "standard" | "double" | "controller" | "combat";
  tick: number;
  roomMode: string;
  clock: { mode: string; tick: number; timerPending: boolean; fault: unknown };
  watchdogPending: boolean;
  peers: PeerMetrics[];
  inputTimeline: Array<{
    runEpoch: number;
    slot: number;
    kind: "admit" | "apply" | "reject";
    runtimeMs: number;
    serverTick: number;
    baselineTick: number;
    firstSequence: number;
    lastSequence: number;
    queued: number;
    outcome: string;
  }>;
  /** [tick, local input/world/encode/send duration, encode-only duration], milliseconds. */
  localCpu: Array<[number, number, number]>;
  /** [observed runtime milliseconds, steps, completed tick, lateness milliseconds]. */
  callbacks: Array<[number, number, number, number]>;
  /** [requested runtime milliseconds, requested delay milliseconds, fired runtime milliseconds]. */
  timers: Array<[number, number, number | null]>;
}

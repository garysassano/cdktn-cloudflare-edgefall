import type { PlayerAcknowledgment } from "../../game/input/types.js";
import type { CombatLab, CombatNotice } from "../../game/labs/combat.js";

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
  instanceId: string;
  worldFailure: string | null;
  inputStreams: Array<{
    acknowledgment: PlayerAcknowledgment;
    queued: number;
    requiresResync: boolean;
  }>;
  combat: {
    world: CombatLab;
    events: Array<{ tick: number; counter: number; event: CombatNotice }>;
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

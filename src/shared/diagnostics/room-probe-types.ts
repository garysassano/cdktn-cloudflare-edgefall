export interface PeerMetrics {
  slot: number;
  active: boolean;
  inputFrames: number;
  inputBytes: number;
  renewedFrames: number;
  acknowledgmentOnlyFrames: number;
  snapshots: number;
  snapshotBytes: number;
  maxQueuedCommands: number;
  neutralizedAtTick: number | null;
  expiredAtTick: number | null;
  closeReason: string | null;
  lastInputError: string | null;
  lastProcessedSequence: number;
  lastHeld: number;
}
export interface RoomProbeStatus {
  instanceId: string;
  runEpoch: number;
  recoveries: number;
  workload: "standard" | "double" | "controller";
  tick: number;
  roomMode: string;
  clock: { mode: string; tick: number; timerPending: boolean; fault: unknown };
  watchdogPending: boolean;
  peers: PeerMetrics[];
  /** [tick, local input/world/encode/send duration, encode-only duration], milliseconds. */
  localCpu: Array<[number, number, number]>;
  /** [observed runtime milliseconds, steps, completed tick, lateness milliseconds]. */
  callbacks: Array<[number, number, number, number]>;
  /** [requested runtime milliseconds, requested delay milliseconds, fired runtime milliseconds]. */
  timers: Array<[number, number, number | null]>;
}

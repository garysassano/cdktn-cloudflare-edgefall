import type { AppliedInput, EdgeResult } from "./types.js";

/** External decisions are assigned a tick and order before entering the deterministic kernel. */
export type BoundaryEvent =
  | { kind: "neutralize"; playerId: number; reason: "stale" | "focus" | "disconnect" }
  | { kind: "connection"; playerId: number; connectionEpoch: number; connected: boolean }
  | { kind: "geometry"; revision: number; removedIds: number[] }
  | {
      kind: "seat";
      playerId: number;
      vehicleId: number | null;
      controlEpoch: number;
      reason: "board" | "exit" | "destroyed" | "disconnect";
    }
  | { kind: "room"; phase: "paused-empty" | "recovering" | "playing"; runEpoch: number };

export interface JournalTick {
  tick: number;
  runEpoch: number;
  inputs: Array<{ input: AppliedInput; edgeResults: EdgeResult[] }>;
  boundaryEvents: Array<{ order: number; event: BoundaryEvent }>;
  /** Derived changes are assertions, never applied a second time as external causes. */
  assertions: Array<{ kind: "state-hash"; value: string }>;
}
export interface ReplayHeader {
  format: 1;
  simulationVersion: number;
  simulationBuild: string;
  contentHash: string;
  runId: string;
  initialRunEpoch: number;
  seed: number;
  tickRate: 60;
}

import type { InputCommand } from "../../game/input/types.js";

export interface InputBatch {
  runEpoch: number;
  connectionEpoch: number;
  packetSequence: number;
  snapshotAck: number;
  eventAck: number;
  commands: InputCommand[];
}
export interface InputIdentity {
  runEpoch: number;
  connectionEpoch: number;
}

export class ProtocolError extends Error {
  constructor(
    readonly code: "malformed" | "identity-mismatch" | "resync-required",
    message: string,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

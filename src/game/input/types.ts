export const Held = {
  Left: 1 << 0,
  Right: 1 << 1,
  Up: 1 << 2,
  Down: 1 << 3,
  Fire: 1 << 4,
  VehicleSpecial: 1 << 5,
} as const;
export const HELD_MASK = 0x3f;
export const EDGE_KINDS = [1, 2, 3, 4, 5] as const;
export const Edge = { Jump: 1, Grenade: 2, Interact: 3, VehicleSpecial: 4, FireOnset: 5 } as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];
export type Aim = 0 | 1 | 2;
export interface ActionEdge {
  kind: EdgeKind;
  id: number;
}
export interface InputCommand {
  sequence: number;
  clientTick: number;
  controlEpoch: number;
  held: number;
  aim: Aim;
  edges: ActionEdge[];
}
export type EdgeCursors = [number, number, number, number, number];
export interface PlayerAcknowledgment {
  playerId: number;
  connectionEpoch: number;
  controlEpoch: number;
  lastProcessedSequence: number;
  appliedAtServerTick: number;
  processedEdgeIds: EdgeCursors;
}
export type InputOutcome = "applied" | "stale" | "old-control" | "cooldown" | "unavailable";
export interface EdgeResult extends ActionEdge {
  outcome: InputOutcome;
}
export interface AppliedInput {
  playerId: number;
  command: InputCommand;
  /** Original accepted intent for replay/audit; null for a missing-command tick. */
  submittedCommand: InputCommand | null;
  serverTick: number;
  outcome: InputOutcome;
  /** True only on missing-command ticks; edges must be empty in this case. */
  repeatedHeld: boolean;
}

export function directionalIntent(held: number, facing: -1 | 1, grounded: boolean) {
  const horizontal = Number(Boolean(held & Held.Right)) - Number(Boolean(held & Held.Left));
  const vertical = Number(Boolean(held & Held.Down)) - Number(Boolean(held & Held.Up));
  const nextFacing = horizontal === 0 ? facing : horizontal < 0 ? -1 : 1;
  return {
    horizontal,
    vertical,
    facing: nextFacing as -1 | 1,
    crouch: grounded && vertical > 0,
    aim: (vertical < 0 ? 1 : vertical > 0 && !grounded ? 2 : 0) as Aim,
  };
}

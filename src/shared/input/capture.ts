import { COUNTER_LIMIT, integer, nextCounter } from "../../game/core/numeric.js";
import {
  type ActionEdge,
  type Aim,
  EDGE_KINDS,
  type EdgeCursors,
  type EdgeKind,
  HELD_MASK,
  type InputCommand,
} from "../../game/input/types.js";
import { MAX_COMMANDS, MAX_EDGES_PER_COMMAND, MAX_QUEUED_COMMANDS } from "../protocol/limits.js";
import { ProtocolError } from "../protocol/schema.js";

export interface InputBinding {
  held?: number;
  edge?: EdgeKind;
}
export const MAX_CAPTURE_EDGES = 64;
export const INPUT_FRAME_RATE = 30;
export const INPUT_FRAME_BURST = 10;

/** Fresh connection/control baseline only. Capture ticks and transport flushing are independent. */
export class InputCapture {
  readonly #sources = new Map<string, InputBinding>();
  readonly #edges: ActionEdge[] = [];
  readonly #commands: InputCommand[] = [];
  readonly #cursors: EdgeCursors = [0, 0, 0, 0, 0];
  #sequence = 0;
  #stopped = false;
  #tokens = INPUT_FRAME_BURST;
  #lastBudgetTime: number | null = null;
  #lastSendTime: number | null = null;

  constructor(readonly controlEpoch: number) {
    integer(controlEpoch, 1, COUNTER_LIMIT - 1, "input control epoch");
  }
  get held() {
    return [...this.#sources.values()].reduce((mask, binding) => mask | (binding.held ?? 0), 0);
  }
  get pending() {
    return this.#commands.length;
  }
  get pendingEdges() {
    return this.#edges.length;
  }
  get sequence() {
    return this.#sequence;
  }
  get requiresResync() {
    return this.#stopped;
  }
  #reject(message: string): never {
    this.#stopped = true;
    throw new ProtocolError("resync-required", message);
  }
  #guard() {
    if (this.#stopped) this.#reject("Input capture requires a fresh baseline");
  }
  press(source: string, binding: InputBinding) {
    this.#guard();
    if (
      source.length === 0 ||
      source.length > 80 ||
      (!binding.held && !binding.edge) ||
      !Number.isInteger(binding.held ?? 0) ||
      (binding.held ?? 0) < 0 ||
      (binding.held ?? 0) > HELD_MASK ||
      (binding.edge !== undefined && !EDGE_KINDS.includes(binding.edge))
    )
      this.#reject("Invalid input binding");
    const previous = this.#sources.get(source);
    if (previous) {
      if (previous.held !== binding.held || previous.edge !== binding.edge)
        this.#reject("Input source binding changed while pressed");
      return;
    }
    if (this.#sources.size >= 64) this.#reject("Input source bound");
    const edgeHeld = [...this.#sources.values()].some((b) => b.edge === binding.edge);
    if (binding.edge !== undefined && !edgeHeld) {
      if (this.#edges.length >= MAX_CAPTURE_EDGES) this.#reject("Input edge queue bound");
      const index = binding.edge - 1;
      let id: number;
      try {
        id = nextCounter(this.#cursors[index] ?? 0);
      } catch {
        this.#reject("Input edge counter needs rotation");
      }
      this.#cursors[index] = id;
      this.#edges.push({ kind: binding.edge, id });
    }
    this.#sources.set(source, { ...binding });
  }
  release(source: string) {
    this.#sources.delete(source);
  }
  /** Release unsampled intent. Already captured commands retain their immutable identities. */
  neutralize() {
    this.#sources.clear();
    this.#edges.length = 0;
  }
  capture(aim: Aim): InputCommand {
    this.#guard();
    if (!Number.isInteger(aim) || aim < 0 || aim > 2) this.#reject("Invalid input aim");
    if (this.#commands.length >= MAX_QUEUED_COMMANDS) this.#reject("Unsent input queue bound");
    let sequence: number;
    try {
      sequence = nextCounter(this.#sequence);
    } catch {
      this.#reject("Input sequence needs rotation");
    }
    const command: InputCommand = {
      sequence,
      clientTick: sequence - 1,
      controlEpoch: this.controlEpoch,
      held: this.held,
      aim,
      edges: this.#edges.splice(0, MAX_EDGES_PER_COMMAND),
    };
    this.#sequence = sequence;
    this.#commands.push(command);
    return structuredClone(command);
  }
  /** 20 Hz normal batches; edges flush on their capture tick within a 30 Hz/burst-10 budget. */
  takeBatch(nowMs: number, force = false): InputCommand[] | null {
    this.#guard();
    if (!Number.isFinite(nowMs) || nowMs < 0 || nowMs < (this.#lastBudgetTime ?? 0))
      this.#reject("Input transport clock invalid/regressed");
    if (this.#lastBudgetTime !== null)
      this.#tokens = Math.min(
        INPUT_FRAME_BURST,
        this.#tokens + ((nowMs - this.#lastBudgetTime) * INPUT_FRAME_RATE) / 1000,
      );
    this.#lastBudgetTime = nowMs;
    if (!this.#commands.length) return null;
    const batch = this.#commands.slice(0, MAX_COMMANDS);
    const due =
      force ||
      batch.length === MAX_COMMANDS ||
      batch.some((command) => command.edges.length > 0) ||
      (this.#lastSendTime !== null && nowMs - this.#lastSendTime >= 50);
    if (!due || this.#tokens < 1) return null;
    this.#tokens--;
    this.#lastSendTime = nowMs;
    return this.#commands.splice(0, batch.length);
  }
}

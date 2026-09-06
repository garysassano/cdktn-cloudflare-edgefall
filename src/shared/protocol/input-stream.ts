import { canonical } from "../../game/core/canonical.js";
import { COUNTER_LIMIT } from "../../game/core/numeric.js";
import type {
  AppliedInput,
  EdgeCursors,
  EdgeResult,
  InputCommand,
  PlayerAcknowledgment,
} from "../../game/input/types.js";
import { decodeInputBatch, validateInputBatch } from "./codec.js";
import {
  INPUT_STALE_MS,
  INPUT_STALE_TICKS,
  MAX_CLIENT_LEAD_TICKS,
  MAX_EDGE_ADVANCE,
  MAX_PREDICTION_TICKS,
  MAX_QUEUED_COMMANDS,
} from "./limits.js";
import { type InputBatch, type InputIdentity, ProtocolError } from "./schema.js";

interface PendingCommand {
  command: InputCommand;
  receivedAtMs: number;
  targetTick: number;
}
export interface InputStreamOptions extends InputIdentity {
  playerId: number;
  controlEpoch: number;
  /** The baseline the server actually sent, not a client-selected clock offset. */
  baselineServerTick: number;
}
export interface ProcessedTick {
  input: AppliedInput;
  edgeResults: EdgeResult[];
  acknowledgment: PlayerAcknowledgment;
  /** The room journals this external deadline decision before replaying the tick. */
  neutralized: boolean;
}

function copyCommand(command: InputCommand): InputCommand {
  return { ...command, edges: command.edges.map((edge) => ({ ...edge })) };
}
function requireValue(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ProtocolError("malformed", message);
}
function counter(value: number, allowZero = false): void {
  requireValue(
    Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value < COUNTER_LIMIT,
    "Invalid stream counter",
  );
}

/** Per-socket bounded input admission. It never reads a wall clock or steps game physics itself. */
export class InputStream {
  private readonly identity: InputIdentity;
  private readonly playerId: number;
  private readonly tickOffset: number;
  private readonly packets = new Map<number, string>();
  private readonly accepted = new Map<number, InputCommand>();
  private readonly sentSnapshots = new Set<number>();
  private queue: PendingCommand[] = [];
  private admittedEdges: EdgeCursors = [0, 0, 0, 0, 0];
  private ack: PlayerAcknowledgment;
  private lastPacket = 0;
  private lastSequence = 0;
  private lastClientTick = -1;
  private lastServerTick: number;
  private lastNowMs = 0;
  private freshAtMs: number | null = null;
  private lastHeld: InputCommand | null = null;
  private sentSnapshot = 0;
  private sentEvent = 0;
  private snapshotAck = 0;
  private eventAck = 0;
  private stopped = false;
  private applying = false;

  constructor(options: InputStreamOptions) {
    for (const value of [
      options.runEpoch,
      options.connectionEpoch,
      options.playerId,
      options.controlEpoch,
    ])
      counter(value);
    counter(options.baselineServerTick, true);
    this.identity = { runEpoch: options.runEpoch, connectionEpoch: options.connectionEpoch };
    this.playerId = options.playerId;
    this.lastServerTick = options.baselineServerTick;
    this.tickOffset = options.baselineServerTick + 1;
    this.ack = {
      playerId: options.playerId,
      connectionEpoch: options.connectionEpoch,
      controlEpoch: options.controlEpoch,
      lastProcessedSequence: 0,
      appliedAtServerTick: 0,
      processedEdgeIds: [0, 0, 0, 0, 0],
    };
  }

  get acknowledgment(): PlayerAcknowledgment {
    return { ...this.ack, processedEdgeIds: [...this.ack.processedEdgeIds] };
  }
  get queuedCommands(): number {
    return this.queue.length;
  }
  get requiresResync(): boolean {
    return this.stopped;
  }
  get deliveryAcknowledgments(): { snapshot: number; event: number } {
    return { snapshot: this.snapshotAck, event: this.eventAck };
  }

  /** Call only after a full snapshot/event prefix was actually sent to this socket. */
  recordSent(snapshotId: number, eventCursor: number): void {
    this.guard();
    counter(snapshotId);
    counter(eventCursor, true);
    requireValue(
      snapshotId > this.sentSnapshot && eventCursor >= this.sentEvent,
      "Nonmonotonic sent baseline",
    );
    this.sentSnapshots.add(snapshotId);
    this.sentSnapshot = snapshotId;
    this.sentEvent = eventCursor;
    while (this.sentSnapshots.size > MAX_PREDICTION_TICKS) {
      const oldest = this.sentSnapshots.values().next().value;
      if (oldest !== undefined) this.sentSnapshots.delete(oldest);
    }
  }

  /** An authoritative seat/ownership boundary invalidates held intent immediately. */
  setControlEpoch(controlEpoch: number): void {
    this.guard();
    counter(controlEpoch);
    requireValue(controlEpoch === this.ack.controlEpoch + 1, "Control epoch must increment once");
    this.ack.controlEpoch = controlEpoch;
    this.lastHeld = null;
    this.freshAtMs = null;
  }

  receive(
    bytes: Uint8Array,
    receivedAtMs: number,
    serverTick: number,
  ): { admitted: number; duplicate: boolean; renewed: boolean } {
    this.guard();
    try {
      return this.admit(decodeInputBatch(bytes, this.identity), receivedAtMs, serverTick);
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }

  private admit(batch: InputBatch, nowMs: number, serverTick: number) {
    this.time(nowMs, serverTick);
    requireValue(
      serverTick === this.lastServerTick,
      "Admission must use the current simulated tick",
    );
    validateInputBatch(batch);
    const fingerprint = canonical(batch);
    if (batch.packetSequence <= this.lastPacket) {
      const previous = this.packets.get(batch.packetSequence);
      if (previous === undefined)
        throw new ProtocolError("resync-required", "Packet older than immutable history");
      requireValue(previous === fingerprint, "Changed duplicate packet");
      this.lastNowMs = nowMs;
      return { admitted: 0, duplicate: true, renewed: false };
    }
    if (batch.packetSequence !== this.lastPacket + 1)
      throw new ProtocolError("resync-required", "Packet sequence gap");
    requireValue(
      batch.snapshotAck >= this.snapshotAck &&
        batch.eventAck >= this.eventAck &&
        batch.eventAck <= this.sentEvent,
      "Invalid delivery acknowledgment",
    );
    if (
      batch.snapshotAck !== 0 &&
      !this.sentSnapshots.has(batch.snapshotAck) &&
      batch.snapshotAck !== this.snapshotAck
    ) {
      throw new ProtocolError("resync-required", "Snapshot acknowledgment has no sent baseline");
    }
    // Stage every field before committing any admission/acknowledgment/liveness changes.
    const additions: PendingCommand[] = [];
    const edges = [...this.admittedEdges] as EdgeCursors;
    let sequence = this.lastSequence;
    let clientTick = this.lastClientTick;
    let renewed = false;
    for (const command of batch.commands) {
      if (command.sequence <= sequence) {
        const previous = this.accepted.get(command.sequence);
        if (!previous)
          throw new ProtocolError("resync-required", "Command older than immutable history");
        requireValue(canonical(previous) === canonical(command), "Changed duplicate command");
        continue;
      }
      if (command.sequence !== sequence + 1 || command.clientTick !== clientTick + 1)
        throw new ProtocolError("resync-required", "Command/client tick sequence gap");
      requireValue(command.controlEpoch <= this.ack.controlEpoch, "Unissued control epoch");
      const targetTick = command.clientTick + this.tickOffset;
      counter(targetTick);
      if (targetTick > serverTick + MAX_CLIENT_LEAD_TICKS)
        throw new ProtocolError("resync-required", "Client exceeds server-owned input lead");
      for (const edge of command.edges) {
        const index = edge.kind - 1;
        const before = edges[index] ?? 0;
        requireValue(
          edge.id > before && edge.id - before <= MAX_EDGE_ADVANCE,
          "Reused or excessive edge identity",
        );
        edges[index] = edge.id;
      }
      additions.push({ command: copyCommand(command), receivedAtMs: nowMs, targetTick });
      sequence = command.sequence;
      clientTick = command.clientTick;
      renewed ||=
        command.controlEpoch === this.ack.controlEpoch &&
        serverTick - targetTick < INPUT_STALE_TICKS;
    }
    if (this.queue.length + additions.length > MAX_QUEUED_COMMANDS)
      throw new ProtocolError("resync-required", "Input queue limit");
    this.queue.push(...additions);
    for (const addition of additions)
      this.accepted.set(addition.command.sequence, copyCommand(addition.command));
    while (this.accepted.size > MAX_QUEUED_COMMANDS + MAX_PREDICTION_TICKS) {
      const oldest = this.accepted.keys().next().value;
      if (oldest !== undefined) this.accepted.delete(oldest);
    }
    this.admittedEdges = edges;
    this.lastSequence = sequence;
    this.lastClientTick = clientTick;
    this.lastPacket = batch.packetSequence;
    this.packets.set(batch.packetSequence, fingerprint);
    while (this.packets.size > MAX_PREDICTION_TICKS) {
      const oldest = this.packets.keys().next().value;
      if (oldest !== undefined) this.packets.delete(oldest);
    }
    this.snapshotAck = batch.snapshotAck;
    this.eventAck = batch.eventAck;
    this.lastNowMs = nowMs;
    if (renewed) this.freshAtMs = nowMs;
    return { admitted: additions.length, duplicate: false, renewed };
  }

  /** The callback performs one simulation tick. Only its successful return advances processed cursors. */
  processTick(
    serverTick: number,
    nowMs: number,
    apply: (input: AppliedInput) => readonly EdgeResult[],
  ): ProcessedTick {
    this.guard();
    this.time(nowMs, serverTick);
    requireValue(serverTick === this.lastServerTick + 1, "Exactly one input step per server tick");
    const candidate = this.queue[0];
    const pending = candidate && candidate.targetTick <= serverTick ? candidate : undefined;
    const expired = this.freshAtMs === null || nowMs - this.freshAtMs >= INPUT_STALE_MS;
    const submitted = pending ? copyCommand(pending.command) : null;
    let outcome: AppliedInput["outcome"] = "applied";
    if (pending && pending.command.controlEpoch !== this.ack.controlEpoch) outcome = "old-control";
    else if (
      pending
        ? nowMs - pending.receivedAtMs >= INPUT_STALE_MS ||
          serverTick - pending.targetTick >= INPUT_STALE_TICKS
        : expired
    )
      outcome = "stale";
    const previousHeld = this.lastHeld;
    const base = submitted ?? previousHeld;
    const command: InputCommand = base
      ? copyCommand(base)
      : {
          sequence: 0,
          clientTick: 0,
          controlEpoch: this.ack.controlEpoch,
          held: 0,
          aim: 0,
          edges: [],
        };
    if (!pending) command.edges = [];
    if (outcome !== "applied") {
      command.held = 0;
      command.aim = 0;
      command.edges = [];
    }
    const input: AppliedInput = {
      playerId: this.playerId,
      command,
      submittedCommand: submitted,
      serverTick,
      outcome,
      repeatedHeld: pending === undefined,
    };
    const journalInput: AppliedInput = {
      ...input,
      command: copyCommand(command),
      submittedCommand: submitted ? copyCommand(submitted) : null,
    };
    this.applying = true;
    let edgeResults: EdgeResult[];
    try {
      const results = apply(input);
      requireValue(
        results.length === journalInput.command.edges.length,
        "Simulation must resolve every delivered edge exactly once",
      );
      for (const [index, result] of results.entries()) {
        const edge = journalInput.command.edges[index];
        requireValue(
          Boolean(
            edge &&
              edge.kind === result.kind &&
              edge.id === result.id &&
              ["applied", "cooldown", "unavailable"].includes(result.outcome),
          ),
          "Invalid simulation edge outcome",
        );
      }
      edgeResults =
        outcome === "applied"
          ? results.map((result) => ({ ...result }))
          : (submitted?.edges ?? []).map((edge) => ({ ...edge, outcome }));
    } catch (error) {
      // The callback may have partially changed world state: never retry an uncertain tick.
      this.stopped = true;
      throw error;
    } finally {
      this.applying = false;
    }
    if (pending) {
      this.queue.shift();
      this.ack.lastProcessedSequence = pending.command.sequence;
      this.ack.appliedAtServerTick = serverTick;
      for (const edge of pending.command.edges) this.ack.processedEdgeIds[edge.kind - 1] = edge.id;
    }
    this.lastHeld =
      outcome === "applied" ? { ...copyCommand(journalInput.command), edges: [] } : null;
    this.lastServerTick = serverTick;
    this.lastNowMs = nowMs;
    return {
      input: journalInput,
      edgeResults,
      acknowledgment: this.acknowledgment,
      neutralized: outcome === "stale" && previousHeld !== null && previousHeld.held !== 0,
    };
  }

  private guard(): void {
    if (this.stopped)
      throw new ProtocolError("resync-required", "Input stream requires a fresh baseline");
    requireValue(!this.applying, "Input stream cannot be reentered during simulation");
  }
  private time(nowMs: number, serverTick: number): void {
    requireValue(Number.isFinite(nowMs) && nowMs >= this.lastNowMs, "Nonmonotonic server clock");
    counter(serverTick, true);
    requireValue(serverTick >= this.lastServerTick, "Server tick moved backwards");
  }
}

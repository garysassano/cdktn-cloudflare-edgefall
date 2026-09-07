import { canonical } from "../../game/core/canonical.js";
import { COUNTER_LIMIT, integer } from "../../game/core/numeric.js";
import type { EdgeCursors, InputCommand, PlayerAcknowledgment } from "../../game/input/types.js";
import type { ControlledActor } from "../../game/state.js";
import { encodeAcknowledgment, validateInputBatch } from "../protocol/codec.js";
import { type InputMapping, validateInputMapping } from "../protocol/input-mapping.js";
import {
  MAX_CLIENT_LEAD_TICKS,
  MAX_PREDICTION_TICKS,
  MAX_QUEUED_COMMANDS,
} from "../protocol/limits.js";
import { ProtocolError } from "../protocol/schema.js";

export interface PredictionBaseline {
  runEpoch: number;
  connectionEpoch: number;
  tick: number;
  snapshotId?: number;
  actor: ControlledActor;
  acknowledgment: PlayerAcknowledgment;
}
type Step = (actor: ControlledActor, command: InputCommand, tick: number) => ControlledActor;

/** Full-controller reconciliation with optional snapshot-paired authoritative command mapping. */
export class ControllerPrediction {
  readonly #initial: PredictionBaseline;
  readonly #step: Step;
  #actor: ControlledActor;
  #tick: number;
  #baselineTick: number;
  #lastSequence = 0;
  #lastClientTick = -1;
  #lastAck = 0;
  #lastAckTick = 0;
  #sentEdges: EdgeCursors = [0, 0, 0, 0, 0];
  #ackedEdges: EdgeCursors = [0, 0, 0, 0, 0];
  #pending: InputCommand[] = [];
  #history = new Map<number, ControlledActor>();
  #stopped = false;
  readonly #usesMappings: boolean;
  #mapping: InputMapping | null = null;
  constructor(baseline: PredictionBaseline, step: Step, mapping?: InputMapping) {
    for (const value of [baseline.runEpoch, baseline.connectionEpoch])
      integer(value, 1, COUNTER_LIMIT - 1, "prediction epoch");
    integer(baseline.tick, 0, COUNTER_LIMIT - 2, "prediction baseline tick");
    if (
      baseline.acknowledgment.lastProcessedSequence !== 0 ||
      baseline.acknowledgment.appliedAtServerTick !== 0 ||
      baseline.acknowledgment.processedEdgeIds.some((id) => id !== 0)
    )
      throw new Error("Prediction needs a fresh server input baseline");
    this.#initial = structuredClone(baseline);
    this.#usesMappings = mapping !== undefined;
    this.#step = step;
    this.#actor = structuredClone(baseline.actor);
    this.#tick = baseline.tick;
    this.#baselineTick = baseline.tick;
    this.#history.set(baseline.tick, structuredClone(baseline.actor));
    this.#checkIdentity(baseline);
    if (mapping) this.#mapping = this.#checkMapping(baseline, mapping);
  }
  #checkMapping(baseline: PredictionBaseline, value: InputMapping): InputMapping {
    let mapping: InputMapping;
    try {
      mapping = validateInputMapping(value);
    } catch {
      this.#reject("Invalid authoritative input mapping");
    }
    const offset = mapping.nextCommandTick - mapping.nextSequence;
    const previousOffset = this.#mapping
      ? this.#mapping.nextCommandTick - this.#mapping.nextSequence
      : this.#initial.tick;
    if (
      mapping.runEpoch !== baseline.runEpoch ||
      mapping.connectionEpoch !== baseline.connectionEpoch ||
      mapping.playerId !== baseline.actor.playerId ||
      mapping.snapshotId !== baseline.snapshotId ||
      mapping.snapshotTick !== baseline.tick ||
      mapping.nextSequence !== baseline.acknowledgment.lastProcessedSequence + 1 ||
      offset < previousOffset ||
      (offset - this.#initial.tick > MAX_CLIENT_LEAD_TICKS &&
        this.#pending.some(
          (command) => command.sequence > baseline.acknowledgment.lastProcessedSequence,
        ))
    )
      this.#reject("Authoritative mapping needs a fresh baseline");
    return mapping;
  }
  #target(command: InputCommand, mapping = this.#mapping) {
    return mapping
      ? mapping.nextCommandTick + command.sequence - mapping.nextSequence
      : this.#initial.tick + command.clientTick + 1;
  }
  get actor() {
    return structuredClone(this.#actor);
  }
  get tick() {
    return this.#tick;
  }
  get pending() {
    return this.#pending.length;
  }
  get requiresResync() {
    return this.#stopped;
  }
  #reject(message: string): never {
    this.#stopped = true;
    throw new ProtocolError("resync-required", message);
  }
  #guard() {
    if (this.#stopped) this.#reject("Prediction requires a fresh baseline");
  }
  #checkIdentity(baseline: PredictionBaseline) {
    // Life is authoritative simulation state and is restored with the actor before replay.
    // Death/entry do not replace the player's input or ownership generation.
    const original = this.#initial,
      ack = baseline.acknowledgment;
    if (
      baseline.runEpoch !== original.runEpoch ||
      baseline.connectionEpoch !== original.connectionEpoch ||
      baseline.actor.playerId !== original.actor.playerId ||
      baseline.actor.body.id !== original.actor.body.id ||
      baseline.actor.controlEpoch !== original.actor.controlEpoch ||
      baseline.actor.geometryRevision !== original.actor.geometryRevision ||
      baseline.actor.vehicleId !== original.actor.vehicleId ||
      ack.playerId !== baseline.actor.playerId ||
      ack.connectionEpoch !== baseline.connectionEpoch ||
      ack.controlEpoch !== baseline.actor.controlEpoch
    )
      this.#reject("Prediction identity/ownership changed");
  }
  submit(command: InputCommand) {
    this.#guard();
    if (
      this.#mapping &&
      this.#mapping.nextCommandTick - this.#mapping.nextSequence - this.#initial.tick >
        MAX_CLIENT_LEAD_TICKS
    )
      this.#reject("Input mapping drift needs a fresh baseline");
    validateInputBatch({
      runEpoch: this.#initial.runEpoch,
      connectionEpoch: this.#initial.connectionEpoch,
      packetSequence: 1,
      snapshotAck: 0,
      eventAck: 0,
      commands: [command],
    });
    if (
      command.sequence !== this.#lastSequence + 1 ||
      command.clientTick !== this.#lastClientTick + 1 ||
      command.controlEpoch !== this.#actor.controlEpoch
    )
      this.#reject("Prediction command sequence/mapping gap");
    const edges = [...this.#sentEdges] as EdgeCursors;
    for (const edge of command.edges) {
      const previous = edges[edge.kind - 1] ?? 0;
      if (edge.id <= previous || edge.id - previous > 256)
        this.#reject("Prediction edge identity reused");
      edges[edge.kind - 1] = edge.id;
    }
    const target = this.#target(command);
    if (target !== this.#tick + 1 || target <= this.#baselineTick)
      this.#reject("Pending command maps into an authoritative or missing tick");
    if (
      this.#pending.length >= MAX_QUEUED_COMMANDS ||
      target - this.#baselineTick > MAX_PREDICTION_TICKS
    )
      this.#reject("Prediction history limit");
    let actor: ControlledActor;
    try {
      actor = this.#step(structuredClone(this.#actor), structuredClone(command), target);
    } catch {
      this.#reject("Prediction physics failed");
    }
    this.#sentEdges = edges;
    this.#pending.push(structuredClone(command));
    this.#actor = actor;
    this.#tick = target;
    this.#lastSequence = command.sequence;
    this.#lastClientTick = command.clientTick;
    this.#history.set(target, structuredClone(actor));
  }
  reconcile(baseline: PredictionBaseline, mapping?: InputMapping) {
    this.#guard();
    this.#checkIdentity(baseline);
    integer(baseline.tick, 0, COUNTER_LIMIT - 2, "snapshot tick");
    const ack = baseline.acknowledgment;
    let nextMapping = this.#mapping;
    if (this.#usesMappings) {
      if (!mapping) this.#reject("Missing authoritative input mapping");
      nextMapping = this.#checkMapping(baseline, mapping);
    } else if (mapping) this.#reject("Input mapping capability was not negotiated");
    encodeAcknowledgment(ack);
    if (
      baseline.tick < this.#baselineTick ||
      ack.lastProcessedSequence < this.#lastAck ||
      ack.lastProcessedSequence > this.#lastSequence ||
      ack.appliedAtServerTick > baseline.tick
    )
      this.#reject("Snapshot/ack regression or unsent command");
    if (
      (ack.lastProcessedSequence === this.#lastAck &&
        ack.appliedAtServerTick !== this.#lastAckTick) ||
      (ack.lastProcessedSequence > this.#lastAck &&
        ack.appliedAtServerTick < this.#initial.tick + ack.lastProcessedSequence)
    )
      this.#reject("Acknowledged command tick is inconsistent");
    const consumedEdges = [...this.#ackedEdges] as EdgeCursors;
    for (const command of this.#pending.filter((c) => c.sequence <= ack.lastProcessedSequence))
      for (const edge of command.edges) consumedEdges[edge.kind - 1] = edge.id;
    if (canonical(consumedEdges) !== canonical(ack.processedEdgeIds))
      this.#reject("Acknowledged edge was not consumed");
    const pending = this.#pending.filter((c) => c.sequence > ack.lastProcessedSequence);
    if (pending.some((c) => this.#target(c, nextMapping) <= baseline.tick))
      this.#reject("Unacknowledged command overlaps restored snapshot");
    const prior = this.#history.get(baseline.tick);
    const correction = prior
      ? {
          x: baseline.actor.body.x - prior.body.x,
          y: baseline.actor.body.y - prior.body.y,
          changed: canonical(prior) !== canonical(baseline.actor),
        }
      : null;
    const history = new Map<number, ControlledActor>();
    let actor = structuredClone(baseline.actor),
      tick = baseline.tick;
    history.set(tick, structuredClone(actor));
    try {
      for (const command of pending) {
        const target = this.#target(command, nextMapping);
        if (target !== tick + 1) this.#reject("Pending mapping needs a new baseline");
        actor = this.#step(actor, structuredClone(command), target);
        tick = target;
        history.set(tick, structuredClone(actor));
      }
    } catch {
      this.#reject("Reconciliation replay failed");
    }
    this.#pending = pending;
    this.#actor = actor;
    this.#tick = tick;
    this.#baselineTick = baseline.tick;
    this.#lastAck = ack.lastProcessedSequence;
    this.#lastAckTick = ack.appliedAtServerTick;
    this.#ackedEdges = consumedEdges;
    this.#history = history;
    this.#mapping = nextMapping;
    return { correction, replayed: pending.length, tick };
  }
}

import { canonical } from "../../game/core/canonical.js";
import { nextCounter } from "../../game/core/numeric.js";
import {
  EVENT_HISTORY_TICKS,
  type EventBaseline,
  type EventBatch,
  type EventContext,
  type EventEnvelope,
  type GameplayEvent,
  MAX_EVENT_BATCH,
  MAX_EVENT_HISTORY,
  eventCounter,
  eventRequire,
  followsEvent,
  validateEventBatch,
  validateGameplayEvent,
} from "./events.js";
import { ProtocolError } from "./schema.js";
import type { FullSnapshot } from "./snapshot-schema.js";

export interface EventHistory {
  runEpoch: number;
  tick: number;
  cursor: number;
  entries: EventEnvelope[];
  capEvictions: number;
  ageEvictions: number;
}
export function createEventHistory(runEpoch: number): EventHistory {
  eventCounter(runEpoch);
  return { runEpoch, tick: 0, cursor: 0, entries: [], capEvictions: 0, ageEvictions: 0 };
}
/** Pure candidate: install only with the world/input transaction that produced these events. */
export function stageEventTick(
  current: EventHistory,
  tick: number,
  events: readonly GameplayEvent[],
  context: EventContext,
): EventHistory {
  eventCounter(tick);
  eventRequire(
    tick === current.tick + 1 && current.runEpoch === context.runEpoch,
    "Event history boundary mismatch",
  );
  eventRequire(
    events.length <= MAX_EVENT_HISTORY,
    "Event tick exceeds the retained stream capacity",
  );
  for (const event of events) validateGameplayEvent(event, context);
  const entries = current.entries.filter((item) => item.tick > tick - EVENT_HISTORY_TICKS);
  const ageEvictions = current.ageEvictions + current.entries.length - entries.length;
  let cursor = current.cursor;
  for (const [counter, event] of events.entries()) {
    cursor = nextCounter(cursor);
    entries.push({ cursor, tick, counter, event: structuredClone(event) });
  }
  const overflow = Math.max(0, entries.length - MAX_EVENT_HISTORY);
  return {
    runEpoch: current.runEpoch,
    tick,
    cursor,
    entries: entries.slice(overflow),
    ageEvictions,
    capEvictions: current.capEvictions + overflow,
  };
}
/** null means a missing prefix; callers must send and explicitly acknowledge a full baseline. */
export function eventBatches(
  history: EventHistory,
  acknowledged: number,
  connectionEpoch: number,
): EventBatch[] | null {
  eventCounter(acknowledged, true);
  eventCounter(connectionEpoch);
  eventRequire(acknowledged <= history.cursor, "Event acknowledgment beyond world cursor");
  const oldest = history.entries[0]?.cursor ?? history.cursor + 1;
  if (acknowledged < oldest - 1) return null;
  const entries = history.entries.filter((item) => item.cursor > acknowledged);
  const batches: EventBatch[] = [];
  for (let offset = 0; offset < entries.length; offset += MAX_EVENT_BATCH)
    batches.push({
      runEpoch: history.runEpoch,
      connectionEpoch,
      throughTick: history.tick,
      events: structuredClone(entries.slice(offset, offset + MAX_EVENT_BATCH)),
    });
  return batches;
}
/** Cross-field barrier, checked before input admission can advance either delivery cursor. */
export function acceptsEventBaseline(
  pending: EventBaseline | null,
  snapshotAck: number,
  eventAck: number,
  previouslySentCursor: number,
): boolean {
  if (!pending) return false;
  eventCounter(snapshotAck, true);
  eventCounter(eventAck, true);
  if (snapshotAck < pending.snapshotId && eventAck <= previouslySentCursor) return false;
  eventRequire(
    snapshotAck === pending.snapshotId && eventAck === pending.baselineEventCursor,
    "Event baseline acknowledgment must accept its exact snapshot and cursor together",
  );
  return true;
}

/** Validates a complete batch before advancing the contiguous consumed/deduplicated cursor. */
export class EventReceiver {
  private readonly fingerprints = new Map<number, string>();
  private cursorValue: number;
  private floor: number;
  private floorTick: number;
  private last: EventEnvelope | null = null;
  private stopped = false;
  private snapshotId: number;
  private consumed = 0;
  private duplicateCount = 0;
  private resetCount = 0;
  private omitted = 0;
  constructor(
    private readonly context: EventContext,
    baseline: FullSnapshot,
  ) {
    this.validateBoundary(baseline);
    this.cursorValue = this.floor = baseline.baselineEventCursor;
    this.floorTick = baseline.tick;
    this.snapshotId = baseline.snapshotId;
  }
  get cursor() {
    return this.cursorValue;
  }
  get requiresBaseline() {
    return this.stopped;
  }
  get status() {
    return {
      cursor: this.cursorValue,
      baselineCursor: this.floor,
      baselineTick: this.floorTick,
      consumed: this.consumed,
      duplicates: this.duplicateCount,
      baselines: this.resetCount,
      omittedByBaseline: this.omitted,
      requiresBaseline: this.stopped,
    };
  }
  private validateBoundary(snapshot: FullSnapshot) {
    eventCounter(snapshot.snapshotId);
    eventCounter(snapshot.tick, true);
    eventCounter(snapshot.baselineEventCursor, true);
    if (
      snapshot.runEpoch !== this.context.runEpoch ||
      snapshot.connectionEpoch !== this.context.connectionEpoch
    )
      throw new ProtocolError("identity-mismatch", "Event baseline session mismatch");
  }
  installBaseline(snapshot: FullSnapshot, promise: EventBaseline): void {
    this.validateBoundary(snapshot);
    eventRequire(
      promise.runEpoch === snapshot.runEpoch &&
        promise.connectionEpoch === snapshot.connectionEpoch &&
        promise.snapshotId === snapshot.snapshotId &&
        promise.tick === snapshot.tick &&
        promise.baselineEventCursor === snapshot.baselineEventCursor,
      "Event baseline does not match its promised full snapshot",
    );
    eventRequire(
      snapshot.snapshotId > this.snapshotId &&
        snapshot.baselineEventCursor >= this.cursorValue &&
        snapshot.tick >= (this.last?.tick ?? this.floorTick),
      "Event baseline regressed",
    );
    this.omitted += snapshot.baselineEventCursor - this.cursorValue;
    this.cursorValue = this.floor = snapshot.baselineEventCursor;
    this.floorTick = snapshot.tick;
    this.snapshotId = snapshot.snapshotId;
    this.last = null;
    this.fingerprints.clear();
    this.stopped = false;
    this.resetCount++;
  }
  consume(batch: EventBatch): EventEnvelope[] {
    if (this.stopped) throw new ProtocolError("resync-required", "Event baseline required");
    try {
      validateEventBatch(batch, this.context);
      const fresh: EventEnvelope[] = [];
      let cursor = this.cursorValue,
        last = this.last,
        duplicates = 0;
      for (const item of batch.events) {
        if (item.cursor <= this.floor) {
          duplicates++;
          continue;
        }
        if (item.cursor <= cursor) {
          if (this.fingerprints.get(item.cursor) !== canonical(item))
            throw new ProtocolError("resync-required", "Changed or expired duplicate event");
          duplicates++;
          continue;
        }
        if (
          item.cursor !== cursor + 1 ||
          (last ? !followsEvent(last, item) : item.tick <= this.floorTick || item.counter !== 0)
        )
          throw new ProtocolError("resync-required", "Missing contiguous event prefix");
        fresh.push(structuredClone(item));
        cursor = item.cursor;
        last = item;
      }
      // No caller effect callbacks before this complete-batch validation/commit boundary.
      for (const item of fresh) this.fingerprints.set(item.cursor, canonical(item));
      while (this.fingerprints.size > MAX_EVENT_HISTORY) {
        const first = this.fingerprints.keys().next().value;
        if (first !== undefined) this.fingerprints.delete(first);
      }
      this.cursorValue = cursor;
      this.last = last ? structuredClone(last) : null;
      this.consumed += fresh.length;
      this.duplicateCount += duplicates;
      return fresh;
    } catch (error) {
      this.stopped = true;
      throw error;
    }
  }
}

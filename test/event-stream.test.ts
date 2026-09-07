import { describe, expect, it } from "vitest";
import { COUNTER_LIMIT, MAX_POSITION } from "../src/game/core/numeric.js";
import { combatEventContext } from "../src/shared/diagnostics/combat-events.js";
import { createCombatWorkload } from "../src/shared/diagnostics/combat-workload.js";
import {
  EventReceiver,
  acceptsEventBaseline,
  createEventHistory,
  eventBatches,
  stageEventTick,
} from "../src/shared/protocol/event-stream.js";
import {
  EVENT_RECORD_BYTES,
  type EventBaseline,
  type EventBatch,
  type GameplayEvent,
  MAX_EVENT_HISTORY,
  decodeEventBaseline,
  decodeEventBatch,
  decodeEventResyncRequest,
  encodeEventBatch,
} from "../src/shared/protocol/events.js";
import { eventDeliveryProof } from "./fixtures/event-delivery-proof.js";

const context = combatEventContext({ runEpoch: 1, connectionEpoch: 1 });
const shot: GameplayEvent = {
  kind: "shot",
  origin: "player",
  ownerId: 1,
  actionInstanceId: 4,
  markerIndex: 0,
  definitionId: 1,
  x: -MAX_POSITION,
  y: MAX_POSITION,
  targetId: null,
  material: "none",
  confirmation: { playerId: 1, controlEpoch: 2, shotOrdinal: 7 },
};
const firstEvent = { cursor: 1, tick: 1, counter: 0, event: shot };
const packet: EventBatch = {
  runEpoch: 1,
  connectionEpoch: 1,
  throughTick: 1,
  events: [firstEvent],
};
function receiver() {
  return new EventReceiver(context, createCombatWorkload().snapshot);
}
function baseline() {
  const snapshot = {
    ...createCombatWorkload().snapshot,
    snapshotId: 50,
    tick: 10,
    baselineEventCursor: 20,
  };
  const promise: EventBaseline = {
    type: "resync-required",
    scope: "events",
    reason: "history-expired",
    runEpoch: 1,
    connectionEpoch: 1,
    snapshotId: 50,
    tick: 10,
    baselineEventCursor: 20,
  };
  return { snapshot, promise };
}
describe("bounded gameplay event transport", () => {
  it("round-trips signed Q256 and stable action identities with a fixed little-endian layout", () => {
    const bytes = encodeEventBatch(packet, context);
    expect(bytes.byteLength).toBe(32 + EVENT_RECORD_BYTES);
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x45, 0x46, 3, 5, 3, 0, 96, 0]);
    const padded = new Uint8Array(bytes.length + 6);
    padded.set(bytes, 3);
    expect(decodeEventBatch(padded.subarray(3, 3 + bytes.length), context)).toEqual(packet);
  });
  it("rejects truncated, trailing, oversized, reserved, enum and identity-corrupted frames", () => {
    const bytes = encodeEventBatch(packet, context);
    for (let length = 0; length < bytes.length; length++)
      expect(() => decodeEventBatch(bytes.slice(0, length), context)).toThrow();
    expect(() => decodeEventBatch(new Uint8Array([...bytes, 0]), context)).toThrow();
    expect(() => decodeEventBatch(new Uint8Array(32 + 65 * EVENT_RECORD_BYTES), context)).toThrow();
    for (const offset of [4, 5, 6, 8, 12, 24, 26, 28, 44, 48, 80, 84]) {
      const bad = bytes.slice();
      bad[offset] = 255;
      expect(() => decodeEventBatch(bad, context), `corruption at ${offset}`).toThrow();
    }
  });
  it("carries enemy releases without inventing player confirmation identities", () => {
    const enemy: GameplayEvent = {
      ...shot,
      origin: "enemy",
      ownerId: 20,
      definitionId: 3,
      confirmation: null,
    };
    const batch = { ...packet, events: [{ ...firstEvent, event: enemy }] };
    expect(decodeEventBatch(encodeEventBatch(batch, context), context)).toEqual(batch);
    for (const event of [
      { ...enemy, confirmation: { playerId: 20, controlEpoch: 1, shotOrdinal: 1 } },
      { ...shot, confirmation: null },
    ])
      expect(() =>
        encodeEventBatch({ ...packet, events: [{ ...firstEvent, event }] }, context),
      ).toThrow(/confirmation/i);
  });
  it("validates the whole batch before producing any event or advancing an acknowledgment", () => {
    const stream = receiver();
    const batch = {
      ...packet,
      events: [...packet.events, { cursor: 2, tick: 1, counter: 2, event: shot }],
    };
    expect(() => stream.consume(batch)).toThrow();
    expect(stream.cursor).toBe(0);
    expect(stream.status.consumed).toBe(0);
    expect(stream.requiresBaseline).toBe(true);
  });
  it("deduplicates exact events, isolates caller mutation, and rejects changed duplicate identity", () => {
    const stream = receiver();
    const events = stream.consume(packet);
    const first = events[0];
    if (!first) throw new Error("Missing accepted event");
    first.event.x = 99;
    expect(stream.consume(packet)).toEqual([]);
    expect(stream.status).toMatchObject({ cursor: 1, consumed: 1, duplicates: 1 });
    expect(() =>
      stream.consume({
        ...packet,
        events: [{ ...firstEvent, event: { ...shot, actionInstanceId: 9 } }],
      }),
    ).toThrow(/duplicate/);
    expect(stream.cursor).toBe(1);
  });
  it("requires a promised full baseline after a gap and never replays the omitted event prefix", () => {
    const stream = receiver();
    stream.consume(packet);
    expect(() =>
      stream.consume({
        ...packet,
        throughTick: 2,
        events: [{ cursor: 3, tick: 2, counter: 0, event: shot }],
      }),
    ).toThrow(/prefix/);
    const { snapshot, promise } = baseline();
    expect(() =>
      stream.installBaseline({ ...snapshot, baselineEventCursor: 19 }, promise),
    ).toThrow();
    expect(stream.cursor).toBe(1);
    stream.installBaseline(snapshot, promise);
    expect(stream.status).toMatchObject({
      cursor: 20,
      omittedByBaseline: 19,
      baselines: 1,
      requiresBaseline: false,
    });
    expect(stream.consume(packet)).toEqual([]);
    expect(
      stream.consume({
        ...packet,
        throughTick: 11,
        events: [{ cursor: 21, tick: 11, counter: 0, event: shot }],
      }),
    ).toHaveLength(1);
  });
  it("rejects cross-session baselines, regressing baselines and invalid baseline controls", () => {
    const stream = receiver(),
      { snapshot, promise } = baseline();
    expect(() => stream.installBaseline({ ...snapshot, connectionEpoch: 2 }, promise)).toThrow();
    stream.installBaseline(snapshot, promise);
    expect(() => stream.installBaseline(snapshot, promise)).toThrow(/regressed/);
    expect(decodeEventBaseline(JSON.stringify(promise), context)).toEqual(promise);
    for (const change of [
      { scope: "world" },
      { tick: NaN },
      { baselineEventCursor: COUNTER_LIMIT },
      { extra: 0 },
      { runEpoch: 2 },
      { reason: "skip" },
    ])
      expect(() =>
        decodeEventBaseline(JSON.stringify({ ...promise, ...change }), context),
      ).toThrow();
    expect(() =>
      decodeEventResyncRequest(
        JSON.stringify({
          type: "event-resync-request",
          runEpoch: 1,
          connectionEpoch: 1,
          lastEventCursor: 0,
          ignore: true,
        }),
        context,
      ),
    ).toThrow();
  });
  it("couples baseline acceptance to the exact sent snapshot/cursor while permitting earlier in-flight acks", () => {
    const { promise } = baseline();
    expect(acceptsEventBaseline(promise, 49, 18, 18)).toBe(false);
    expect(acceptsEventBaseline(promise, 50, 20, 18)).toBe(true);
    for (const [snapshot, cursor] of [
      [49, 20],
      [50, 19],
      [51, 20],
      [50, 21],
    ] as const)
      expect(() => acceptsEventBaseline(promise, snapshot, cursor, 18)).toThrow();
    expect(acceptsEventBaseline(promise, 49, 20, 20)).toBe(false);
  });
  it("retains events from every tick, expires by age, and reports cap pressure independently", () => {
    let history = createEventHistory(1);
    for (let tick = 1; tick <= 3; tick++) history = stageEventTick(history, tick, [shot], context);
    expect(
      eventBatches(history, 0, 1)
        ?.flatMap((batch) => batch.events)
        .map((item) => item.tick),
    ).toEqual([1, 2, 3]);
    const before = structuredClone(history);
    const capped = stageEventTick(
      history,
      4,
      Array.from({ length: 512 }, () => shot),
      context,
    );
    expect(history).toEqual(before);
    expect(capped.entries).toHaveLength(512);
    expect(capped.capEvictions).toBe(3);
    expect(eventBatches(capped, 0, 1)).toBeNull();
    expect(eventBatches(capped, 3, 1)).toHaveLength(8);
    expect(() =>
      stageEventTick(
        history,
        4,
        Array.from({ length: 513 }, () => shot),
        context,
      ),
    ).toThrow();
    for (let tick = 4; tick <= 123; tick++) history = stageEventTick(history, tick, [], context);
    expect(history).toMatchObject({ cursor: 3, entries: [], ageEvictions: 3, capEvictions: 0 });
    expect(eventBatches(history, 2, 1)).toBeNull();
    expect(eventBatches(history, 3, 1)).toEqual([]);
  });
  it("fails before mutating history on counter exhaustion or an invalid final event", () => {
    const history = { ...createEventHistory(1), cursor: COUNTER_LIMIT - 1 };
    expect(() => stageEventTick(history, 1, [shot], context)).toThrow();
    expect(history.tick).toBe(0);
    expect(() =>
      stageEventTick(createEventHistory(1), 1, [shot, { ...shot, definitionId: 99 }], context),
    ).toThrow();
    expect(() =>
      encodeEventBatch(
        {
          ...packet,
          events: Array.from({ length: MAX_EVENT_HISTORY + 1 }, () => firstEvent),
        },
        context,
      ),
    ).toThrow();
  });
  it("proves real combat delivery, duplicate suppression and explicit repair over 300 ticks", () => {
    expect(eventDeliveryProof()).toMatchObject({
      ticks: 300,
      capEvictions: 0,
      kills: [2, 2, 2, 2],
    });
  });
});

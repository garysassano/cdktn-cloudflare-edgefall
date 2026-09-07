import { beforeAll, describe, expect, it } from "vitest";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import {
  combatContinuationHash,
  transitionCombatRuntime,
} from "../src/shared/diagnostics/combat-recovery.js";
import {
  type CombatRuntime,
  combatRuntimeHash,
  stageCombatRuntime,
} from "../src/shared/diagnostics/combat-runtime.js";
import {
  COMBAT_BACKLOG_LIMIT,
  CombatJournalWriter,
} from "../src/shared/diagnostics/combat-writer.js";
import { recordCombatRecovery } from "./fixtures/combat-recovery-proof.js";

let fixture: ReturnType<typeof recordCombatRecovery>;
beforeAll(() => {
  fixture = recordCombatRecovery();
});
function state(tick: number) {
  const saved = fixture.states[tick];
  if (!saved) throw new Error("Missing writer fixture");
  return structuredClone(saved);
}
function records(writer: CombatJournalWriter, from: number, through: number) {
  for (const entry of fixture.entries.slice(from - 1, through))
    writer.record(entry, state(entry.tick));
}
describe("bounded combat persistence writer", () => {
  it("seals a short immutable tail after the in-flight segment with no overlapping writes", async () => {
    let confirm: (() => void) | undefined;
    const writes: number[][] = [],
      pauses: string[] = [];
    const writer = new CombatJournalWriter(
      {
        async commit(start, entries, accepted) {
          writes.push([start.combat.tick, entries.length, accepted.combat.tick]);
          if (writes.length === 1)
            await new Promise<void>((resolve) => {
              confirm = resolve;
            });
          return accepted;
        },
      },
      state(60),
      (reason) => pauses.push(reason),
      () => {},
    );
    records(writer, 61, 89);
    await Promise.resolve();
    const accepted = state(89);
    const sealed = writer.seal(accepted);
    accepted.combat.nextActionId++;
    expect(() => records(writer, 90, 90)).toThrow(/recovery/);
    expect(writes).toEqual([[60, 15, 75]]);
    if (!confirm) throw new Error("Missing in-flight write");
    confirm();
    expect(combatRuntimeHash(await sealed)).toBe(combatRuntimeHash(state(89)));
    expect(writes).toEqual([
      [60, 15, 75],
      [75, 14, 89],
    ]);
    expect(writer.status).toMatchObject({
      committedTick: 89,
      backlogTicks: 0,
      accepting: false,
      writing: false,
    });
    expect(pauses).toEqual([]);
    await writer.retire();
  });
  it("rejects an unconfirmed pause tail but still permits recovery from the previous durable head", async () => {
    const writer = new CombatJournalWriter(
      {
        commit: async () => {
          throw new Error("tail write failed");
        },
      },
      state(60),
      () => {},
      () => {},
    );
    records(writer, 61, 64);
    await expect(writer.seal(state(63))).rejects.toThrow(/boundary changed/);
    await expect(writer.seal(state(64))).rejects.toThrow(/tail write failed/);
    expect(writer.status.committedTick).toBe(60);
    await expect(writer.retire()).resolves.toBeUndefined();
  });
  it("captures the segment boundary before later live mutations and before starting its write", async () => {
    const tasks: Promise<void>[] = [];
    const writer = new CombatJournalWriter(
      {
        async commit(_start, _entries, accepted) {
          return accepted;
        },
      },
      state(60),
      () => {},
      (task) => tasks.push(task),
    );
    records(writer, 61, 74);
    const accepted = state(75),
      entry = fixture.entries[74];
    if (!entry) throw new Error("Missing writer fixture");
    writer.record(entry, accepted);
    accepted.combat.nextActionId++;
    accepted.snapshot.roomMode = "recovering";
    await tasks[0];
    expect(writer.status).toMatchObject({
      committedTick: 75,
      committedHash: combatRuntimeHash(state(75)),
      failure: null,
    });
  });
  it("serializes writes and advances durability only on a matching confirmed result", async () => {
    const pauses: string[] = [],
      tasks: Promise<void>[] = [],
      starts: number[] = [];
    const writer = new CombatJournalWriter(
      {
        async commit(start, entries) {
          starts.push(start.combat.tick);
          expect(entries).toEqual(fixture.entries.slice(start.combat.tick, start.combat.tick + 15));
          return state(start.combat.tick + 15);
        },
      },
      state(60),
      (reason) => pauses.push(reason),
      (task) => tasks.push(task),
    );
    records(writer, 61, 75);
    expect(writer.status.committedTick).toBe(60);
    await tasks[0];
    expect(writer.status.committedTick).toBe(75);
    records(writer, 76, 90);
    await tasks[1];
    expect(starts).toEqual([60, 75]);
    expect(writer.status).toMatchObject({
      committedTick: 90,
      backlogTicks: 0,
      writing: false,
      failure: null,
    });
    expect(pauses).toEqual([]);
  });
  it("pauses at thirty accepted but unconfirmed ticks and never resumes itself", async () => {
    let confirm: ((state: CombatRuntime) => void) | undefined;
    const pauses: string[] = [],
      tasks: Promise<void>[] = [];
    const writer = new CombatJournalWriter(
      {
        commit: () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      },
      state(60),
      (reason) => pauses.push(reason),
      (task) => tasks.push(task),
    );
    records(writer, 61, 90);
    await Promise.resolve();
    expect(writer.status).toMatchObject({
      acceptedTick: 90,
      committedTick: 60,
      backlogTicks: COMBAT_BACKLOG_LIMIT,
      queuedTicks: 15,
      writing: true,
      accepting: false,
    });
    expect(pauses).toEqual(["journal-backlog-limit"]);
    expect(() => records(writer, 91, 91)).toThrow(/recovery/);
    if (!confirm) throw new Error("Missing in-flight write");
    confirm(state(75));
    await tasks[0];
    expect(tasks).toHaveLength(1);
    expect(writer.status).toMatchObject({ committedTick: 75, backlogTicks: 15, accepting: false });
    await writer.retire();
  });
  it.each(["reject", "wrong-ack"])("preserves the prior durable state after %s", async (kind) => {
    const pauses: string[] = [],
      tasks: Promise<void>[] = [];
    const writer = new CombatJournalWriter(
      {
        async commit() {
          if (kind === "reject") throw new Error("injected write failure");
          return state(74);
        },
      },
      state(60),
      (reason) => pauses.push(reason),
      (task) => tasks.push(task),
    );
    records(writer, 61, 75);
    await tasks[0];
    expect(writer.status).toMatchObject({
      acceptedTick: 75,
      committedTick: 60,
      accepting: false,
      writing: false,
    });
    expect(pauses).toHaveLength(1);
  });
  it("retirement waits for the in-flight write and discards only uncommitted remainder", async () => {
    let confirm: ((state: CombatRuntime) => void) | undefined;
    const writer = new CombatJournalWriter(
      {
        commit: () =>
          new Promise((resolve) => {
            confirm = resolve;
          }),
      },
      state(60),
      () => {},
      () => {},
    );
    records(writer, 61, 80);
    await Promise.resolve();
    const closed = writer.retire();
    if (!confirm) throw new Error("Missing in-flight write");
    confirm(state(75));
    await closed;
    expect(writer.status).toMatchObject({
      committedTick: 75,
      acceptedTick: 80,
      queuedTicks: 0,
      writing: false,
      accepting: false,
    });
  });
});
describe("persisted combat recovery boundary", () => {
  it.each(["lobby", "loading", "playing", "intermission"] as const)(
    "retains a paused %s decision across recovery without advancing gameplay",
    (phase) => {
      const before = state(phase === "lobby" ? 0 : 89);
      before.snapshot.roomMode = phase;
      const paused = transitionCombatRuntime(before, "pause");
      expect(paused.pausedFrom).toBe(phase);
      validateCombatCheckpoint(paused);
      expect(() => stageCombatRuntime(paused, [])).toThrow(/playing phase/);
      const recovered = transitionCombatRuntime(paused, "recover");
      validateCombatCheckpoint(recovered);
      expect(recovered.snapshot.roomMode).toBe(
        phase === "lobby" || phase === "intermission" ? phase : "loading",
      );
      expect(recovered.pausedFrom).toBeNull();
      expect(recovered.combat.tick).toBe(before.combat.tick);
      expect(combatContinuationHash(recovered.snapshot)).toBe(
        combatContinuationHash(before.snapshot),
      );
    },
  );
  it("requires lobby/intermission before load and a loading barrier before start", () => {
    const before = state(0);
    before.snapshot.roomMode = "lobby";
    expect(() => transitionCombatRuntime(before, "start")).toThrow(/loading barrier/);
    const loaded = transitionCombatRuntime(before, "load");
    expect(loaded.snapshot.roomMode).toBe("loading");
    expect(loaded.combat).toEqual(before.combat);
    const started = transitionCombatRuntime(loaded, "start");
    expect(started.snapshot.roomMode).toBe("playing");
    expect(() => transitionCombatRuntime(started, "load")).toThrow(/lobby or intermission/);
  });
  it("never plays or recovers completed results, but allows their terminal expiry", () => {
    const completed = state(89);
    completed.snapshot.roomMode = "completed";
    expect(() => stageCombatRuntime(completed, [])).toThrow(/playing phase/);
    for (const command of ["load", "start", "recover", "pause"] as const)
      expect(() => transitionCombatRuntime(completed, command)).toThrow(/Terminal/);
    const expired = transitionCombatRuntime(completed, "expire");
    validateCombatCheckpoint(expired);
    expect(expired.snapshot.roomMode).toBe("expired");
    expect(expired.combat).toEqual(completed.combat);
  });
  it("pauses and expires at an exact accepted tick without advancing combat or resurrecting a terminal room", () => {
    const previous = state(89),
      paused = transitionCombatRuntime(previous, "pause");
    validateCombatCheckpoint(paused);
    expect(paused.combat).toEqual(previous.combat);
    expect(paused.history).toEqual(previous.history);
    expect(paused.connectedPlayerIds).toEqual([]);
    expect(paused.snapshot).toMatchObject({ tick: 89, runEpoch: 1, roomMode: "paused-empty" });
    const recovered = transitionCombatRuntime(paused, "recover");
    expect(combatContinuationHash(recovered.snapshot)).toBe(
      combatContinuationHash(paused.snapshot),
    );
    const expired = transitionCombatRuntime(paused, "expire");
    validateCombatCheckpoint(expired);
    expect(expired.combat).toEqual(previous.combat);
    expect(expired.snapshot.roomMode).toBe("expired");
    for (const kind of ["start", "pause", "recover", "expire"] as const)
      expect(() => transitionCombatRuntime(expired, kind)).toThrow(/Terminal/);
  });
  it("preserves simulation/kill/ID continuation while replacing old input and effect generations", () => {
    const previous = state(105),
      before = combatRuntimeHash(previous);
    const recovered = transitionCombatRuntime(previous, "recover");
    expect(combatContinuationHash(recovered.snapshot)).toBe(
      combatContinuationHash(previous.snapshot),
    );
    const changed = structuredClone(recovered.snapshot);
    if (!changed.players[0]) throw new Error("Missing player");
    changed.players[0].weapon.shotOrdinal++;
    expect(combatContinuationHash(changed)).not.toBe(combatContinuationHash(previous.snapshot));
    validateCombatCheckpoint(recovered);
    expect(combatRuntimeHash(previous)).toBe(before);
    expect(recovered.snapshot).toMatchObject({
      runEpoch: 2,
      roomMode: "loading",
      tick: 105,
      baselineEventCursor: 0,
    });
    expect(recovered.combat.encounter).toEqual(previous.combat.encounter);
    expect(recovered.combat.targets).toEqual(previous.combat.targets);
    expect(recovered.combat.projectiles).toEqual(previous.combat.projectiles);
    expect(recovered.combat.nextActionId).toBe(previous.combat.nextActionId);
    expect(recovered.combat.nextEntityId).toBe(previous.combat.nextEntityId);
    expect(recovered.combat.players.map((p) => p.weapon)).toEqual(
      previous.combat.players.map((p) => p.weapon),
    );
    expect(recovered.history).toMatchObject({ runEpoch: 2, tick: 105, cursor: 0, entries: [] });
    expect(recovered.connectedPlayerIds).toEqual([]);
    expect(
      recovered.snapshot.acknowledgments.map((a) => [
        a.connectionEpoch,
        a.controlEpoch,
        a.lastProcessedSequence,
      ]),
    ).toEqual([
      [2, 2, 0],
      [3, 2, 0],
      [4, 2, 0],
      [5, 2, 0],
    ]);
    const started = transitionCombatRuntime(recovered, "start");
    validateCombatCheckpoint(started);
    expect(started.combat).toEqual(recovered.combat);
    expect(started.snapshot.roomMode).toBe("playing");
    expect(() => transitionCombatRuntime(started, "start")).toThrow(/loading/);
  });
});

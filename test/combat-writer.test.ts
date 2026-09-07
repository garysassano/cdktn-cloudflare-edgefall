import { beforeAll, describe, expect, it } from "vitest";
import { validateCombatCheckpoint } from "../src/shared/diagnostics/combat-checkpoint.js";
import {
  combatContinuationHash,
  transitionCombatRuntime,
} from "../src/shared/diagnostics/combat-recovery.js";
import { type CombatRuntime, combatRuntimeHash } from "../src/shared/diagnostics/combat-runtime.js";
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

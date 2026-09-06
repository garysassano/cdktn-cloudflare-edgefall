import { describe, expect, it } from "vitest";
import {
  type EncounterDefinition,
  type EncounterEvent,
  EncounterLifecycle,
} from "../src/game/encounters/lifecycle.js";

const member = (id: number, required = true) => ({
  id,
  required,
  critical: false,
  retreatAllowed: false,
  watchdogTicks: 3,
  ambientCleanupTicks: null,
});
const definition = (): EncounterDefinition => ({
  id: 10,
  participants: [1, 2],
  members: [member(20), member(21), member(22, false)],
  objectives: [30],
});
const activate = (sequence: number, tick: number, id: number): EncounterEvent => ({
  sequence,
  tick,
  kind: "activate",
  id,
});
const resolve = (
  sequence: number,
  tick: number,
  id: number,
  reason: "killed" | "retreated" | "crushed" | "out-of-bounds",
  killerId: number | null = null,
): EncounterEvent => ({ sequence, tick, kind: "resolve", id, reason, killerId });
const observe = (id: number, progressKey = "0,0", unreachable = false) => ({
  id,
  progressKey,
  unreachable,
});
describe("explicit encounter lifecycle", () => {
  it("waits for required delayed spawns/objectives and ignores ambient survivors at completion", () => {
    const lifecycle = new EncounterLifecycle(definition());
    let result = lifecycle.step(lifecycle.begin(), 1, [], []);
    expect(result.counts.alive).toBe(0);
    expect(result.remaining).toBe(3);
    expect(result.state.phase).toBe("active");
    result = lifecycle.step(
      result.state,
      2,
      [activate(1, 2, 20), activate(2, 2, 22)],
      [observe(20), observe(22)],
    );
    result = lifecycle.step(result.state, 3, [resolve(3, 3, 20, "killed", 2)], [observe(22)]);
    expect(result.remaining).toBe(2);
    result = lifecycle.step(
      result.state,
      4,
      [activate(4, 4, 21), resolve(5, 4, 21, "out-of-bounds")],
      [observe(22)],
    );
    expect(result.remaining).toBe(1);
    expect(result.state.phase).toBe("active");
    result = lifecycle.step(
      result.state,
      5,
      [{ kind: "objective", sequence: 6, tick: 5, id: 30 }],
      [observe(22, "moved")],
    );
    expect(result.state.phase).toBe("complete");
    expect(result.counts).toEqual({ pending: 0, alive: 1, resolved: 2 });
    expect(result.state.kills).toEqual([
      { playerId: 1, count: 0 },
      { playerId: 2, count: 1 },
    ]);
    expect(result.notices.filter((n) => n.kind === "complete")).toHaveLength(1);
    expect(lifecycle.step(result.state, 6, [], [observe(22, "still-moving")]).notices).toEqual([]);
  });
  it("restores receipts and produces the same state regardless of input array order", () => {
    const def = definition(),
      lifecycle = new EncounterLifecycle(def);
    const events = [activate(1, 1, 20), activate(2, 1, 21), resolve(3, 1, 20, "killed", 1)];
    const result = lifecycle.step(lifecycle.begin(), 1, events, [observe(21)]);
    expect(lifecycle.step(lifecycle.begin(), 1, [...events].reverse(), [observe(21)])).toEqual(
      result,
    );
    const reordered = { ...def, members: [...def.members].reverse(), participants: [2, 1] };
    const restored = new EncounterLifecycle(reordered).step(
      JSON.parse(JSON.stringify(result.state)),
      2,
      events,
      [observe(21, "next")],
    );
    expect(restored).toEqual(lifecycle.step(result.state, 2, [], [observe(21, "next")]));
    expect(restored.state.kills[0]?.count).toBe(1);
    expect(result.state.tick).toBe(1);
  });
  it("rejects gaps, conflicting duplicates and double terminal events", () => {
    const lifecycle = new EncounterLifecycle(definition());
    expect(() => lifecycle.step(lifecycle.begin(), 1, [activate(2, 1, 20)], [observe(20)])).toThrow(
      "sequence gap",
    );
    const result = lifecycle.step(lifecycle.begin(), 1, [activate(1, 1, 20)], [observe(20)]);
    expect(() => lifecycle.step(result.state, 2, [activate(1, 1, 21)], [observe(20)])).toThrow(
      "conflicting duplicate",
    );
    expect(() =>
      lifecycle.step(
        result.state,
        2,
        [resolve(2, 2, 20, "killed", 1), resolve(3, 2, 20, "out-of-bounds")],
        [],
      ),
    ).toThrow("nonliving");
    expect(() => lifecycle.step(result.state, 2, [resolve(2, 2, 20, "crushed", 1)], [])).toThrow(
      "attribution",
    );
    expect(() => lifecycle.step(result.state, 2, [resolve(2, 1, 20, "killed", 1)], [])).toThrow(
      "effective tick",
    );
  });
  it("resolves permitted retreats, but fails forbidden retreats without granting kill credit", () => {
    for (const allowed of [true, false]) {
      const def = definition();
      if (!def.members[0]) throw new Error("member");
      def.members[0].retreatAllowed = allowed;
      const lifecycle = new EncounterLifecycle(def);
      const result = lifecycle.step(
        lifecycle.begin(),
        1,
        [activate(1, 1, 20), resolve(2, 1, 20, "retreated")],
        [],
      );
      expect(result.state.phase).toBe(allowed ? "active" : "failed");
      expect(result.state.failure?.reason ?? null).toBe(allowed ? null : "forbidden-retreat");
      expect(result.state.kills.every((k) => k.count === 0)).toBe(true);
    }
  });
  it("records a critical pose loss, handles the whole same-tick batch, and throws in strict tests", () => {
    const def = definition();
    if (!def.members[0]) throw new Error("member");
    def.members[0].critical = true;
    const lifecycle = new EncounterLifecycle(def);
    const events = [
      activate(1, 1, 20),
      activate(2, 1, 21),
      resolve(3, 1, 20, "out-of-bounds"),
      resolve(4, 1, 21, "killed", 1),
    ];
    const initial = lifecycle.begin();
    const result = lifecycle.step(initial, 1, events, []);
    expect(result.state.phase).toBe("failed");
    expect(result.state.failure).toEqual({
      id: 20,
      tick: 1,
      reason: "critical-loss",
      cause: "out-of-bounds",
    });
    expect(result.state.receipts).toHaveLength(4);
    expect(result.state.kills[0]?.count).toBe(1);
    expect(() => lifecycle.step(initial, 1, events, [], "throw")).toThrow("critical-loss: 20");
    expect(initial.members.every((m) => m.status === "pending")).toBe(true);
    expect(lifecycle.step(result.state, 2, [], []).state.phase).toBe("failed");
  });
  it("bookmarks stalled required actors without deleting them or opening the gate", () => {
    const lifecycle = new EncounterLifecycle(definition());
    let result = lifecycle.step(
      lifecycle.begin(),
      1,
      [activate(1, 1, 20)],
      [observe(20, "same", true)],
    );
    const notices = [];
    for (let tick = 2; tick <= 12; tick++) {
      result = lifecycle.step(result.state, tick, [], [observe(20, "same", true)]);
      notices.push(...result.notices);
    }
    expect(notices.map((n) => n.kind)).toEqual(["watchdog", "watchdog"]);
    expect(notices.every((n) => n.kind === "watchdog" && n.tick === 4 && n.sinceTick === 1)).toBe(
      true,
    );
    expect(result.state.phase).toBe("active");
    expect(result.counts.alive).toBe(1);
    expect(result.remaining).toBe(3);
  });
  it("cleans up only explicitly eligible ambient actors after the authored timeout", () => {
    const def = definition();
    if (!def.members[2]) throw new Error("member");
    def.members[2].ambientCleanupTicks = 5;
    const lifecycle = new EncounterLifecycle(def);
    let result = lifecycle.step(
      lifecycle.begin(),
      1,
      [activate(1, 1, 22)],
      [observe(22, "stuck", true)],
    );
    for (let tick = 2; tick <= 5; tick++)
      result = lifecycle.step(result.state, tick, [], [observe(22, "stuck", true)]);
    expect(result.counts.alive).toBe(1);
    result = lifecycle.step(
      JSON.parse(JSON.stringify(result.state)),
      6,
      [],
      [observe(22, "stuck", true)],
    );
    expect(result.notices).toEqual([
      { kind: "remove-ambient", tick: 6, id: 22, reason: "ambient-timeout" },
    ]);
    expect(result.state.members[2]?.reason).toBe("ambient-timeout");
    expect(result.state.kills.every((k) => k.count === 0)).toBe(true);
    expect(lifecycle.step(result.state, 7, [], []).notices).toEqual([]);
    def.members[2].required = true;
    expect(() => new EncounterLifecycle(def)).toThrow("ambient cleanup");
  });
  it("resets progress episodes while retaining continuously unreachable diagnostics", () => {
    const lifecycle = new EncounterLifecycle(definition());
    let result = lifecycle.step(
      lifecycle.begin(),
      1,
      [activate(1, 1, 20)],
      [observe(20, "a", true)],
    );
    for (let tick = 2; tick <= 4; tick++)
      result = lifecycle.step(result.state, tick, [], [observe(20, String(tick), true)]);
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ kind: "watchdog", reason: "unreachable" });
    result = lifecycle.step(result.state, 5, [], [observe(20, "5", false)]);
    result = lifecycle.step(result.state, 6, [], [observe(20, "6", true)]);
    for (let tick = 7; tick <= 9; tick++)
      result = lifecycle.step(result.state, tick, [], [observe(20, String(tick), true)]);
    expect(result.notices[0]).toMatchObject({
      kind: "watchdog",
      reason: "unreachable",
      sinceTick: 6,
      tick: 9,
    });
  });
  it("retires unresolved rosters without fabricating completion or kill credit", () => {
    const lifecycle = new EncounterLifecycle(definition());
    const event: EncounterEvent = { kind: "retire", sequence: 1, tick: 1 };
    const result = lifecycle.step(lifecycle.begin(), 1, [event], []);
    expect(result.state.phase).toBe("retired");
    expect(result.remaining).toBe(0);
    expect(result.state.objectives[0]?.completedTick).toBe(null);
    expect(result.notices.map((n) => n.kind)).toEqual(["retired"]);
    expect(lifecycle.step(result.state, 2, [event], []).notices).toEqual([]);
    expect(() => lifecycle.step(result.state, 2, [activate(2, 2, 20)], [])).toThrow(
      "terminal encounter",
    );
  });
  it("rejects incomplete observations, changed policies and damaged restored counters", () => {
    const lifecycle = new EncounterLifecycle(definition());
    expect(() => lifecycle.step(lifecycle.begin(), 1, [activate(1, 1, 20)], [])).toThrow(
      "missing living",
    );
    const result = lifecycle.step(lifecycle.begin(), 1, [], []);
    const changed = definition();
    if (!changed.members[0]) throw new Error("member");
    changed.members[0].required = false;
    expect(() => new EncounterLifecycle(changed).step(result.state, 2, [], [])).toThrow(
      "definition mismatch",
    );
    if (!result.state.kills[0]) throw new Error("credit");
    result.state.kills[0].count = 1;
    expect(() => lifecycle.step(result.state, 2, [], [])).toThrow("kill count mismatch");
  });
  it("fails on invalid solver poses without converting them into kills or removals", () => {
    const lifecycle = new EncounterLifecycle(definition());
    const result = lifecycle.step(
      lifecycle.begin(),
      1,
      [
        activate(1, 1, 20),
        { kind: "fault", id: 20, sequence: 2, tick: 1, reason: "initial-overlap" },
      ],
      [],
    );
    expect(result.state.phase).toBe("failed");
    expect(result.state.members[0]?.status).toBe("alive");
    expect(result.state.members[0]?.reason).toBe(null);
    expect(result.state.failure).toMatchObject({
      reason: "invalid-pose",
      cause: "initial-overlap",
    });
    expect(result.state.kills.every((k) => k.count === 0)).toBe(true);
  });
});

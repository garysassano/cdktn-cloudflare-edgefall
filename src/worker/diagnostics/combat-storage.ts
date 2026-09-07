import {
  COMBAT_CHECKPOINT_TICKS,
  COMBAT_SEGMENT_TICKS,
  type CombatArchiveIdentity,
  decodeCombatCheckpoint,
  encodeAcceptedCombatJournalSegment,
  encodeCombatCheckpoint,
  restoreCombatJournalSegment,
} from "../../shared/diagnostics/combat-checkpoint.js";
import {
  replaceWaitingCombatConnection,
  transitionCombatRuntime,
} from "../../shared/diagnostics/combat-recovery.js";
import {
  type CombatJournalTick,
  type CombatRuntime,
  combatRuntimeHash,
} from "../../shared/diagnostics/combat-runtime.js";

type ArchiveRow = {
  key: string;
  run_epoch: number;
  tick: number;
  payload: string;
};
const MAX_JOURNAL_SEGMENTS = Math.ceil(COMBAT_CHECKPOINT_TICKS / COMBAT_SEGMENT_TICKS);
/** SQLite laboratory store. Caller pauses gameplay on failure/backlog; no external side effects. */
export class CombatStorage {
  private busy = false;
  readonly commits: Array<{
    runEpoch: number;
    fromTick: number;
    throughTick: number;
    prepareMs: number;
    confirmMs: number;
  }> = [];
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly identity: CombatArchiveIdentity,
    private readonly beforeHeadCommit?: () => void,
  ) {
    storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS combat_archive (key TEXT PRIMARY KEY, run_epoch INTEGER NOT NULL, tick INTEGER NOT NULL, payload TEXT NOT NULL)",
    );
  }
  private head(): ArchiveRow | undefined {
    return this.storage.sql
      .exec<ArchiveRow>(
        "SELECT key, run_epoch, tick, payload FROM combat_archive WHERE key = ?",
        "head",
      )
      .toArray()[0];
  }
  private put(key: string, runEpoch: number, tick: number, payload: string) {
    this.storage.sql.exec(
      "INSERT OR REPLACE INTO combat_archive (key, run_epoch, tick, payload) VALUES (?, ?, ?, ?)",
      key,
      runEpoch,
      tick,
      payload,
    );
  }
  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Combat storage operation already pending");
    this.busy = true;
    try {
      return await operation();
    } finally {
      this.busy = false;
    }
  }
  initialize(current: CombatRuntime): Promise<void> {
    const state = structuredClone(current);
    return this.exclusive(async () => {
      const raw = await encodeCombatCheckpoint(state, this.identity);
      this.storage.transactionSync(() => {
        if (
          this.storage.sql
            .exec<{ count: number }>("SELECT COUNT(*) AS count FROM combat_archive")
            .one().count !== 0
        )
          throw new Error("Combat archive already exists; recover it explicitly");
        this.put("checkpoint", state.snapshot.runEpoch, state.combat.tick, raw);
        this.beforeHeadCommit?.();
        this.put("head", state.snapshot.runEpoch, state.combat.tick, combatRuntimeHash(state));
      });
      await this.storage.sync();
    });
  }
  commit(
    start: CombatRuntime,
    entries: readonly CombatJournalTick[],
    accepted: CombatRuntime,
  ): Promise<CombatRuntime> {
    const previous = structuredClone(start),
      saved = structuredClone([...entries]),
      state = structuredClone(accepted);
    return this.exclusive(async () => {
      const began = performance.now();
      if (saved.length < 1 || saved.length > COMBAT_SEGMENT_TICKS)
        throw new Error("Combat durable segment must contain 1 to 15 ticks");
      const raw = await encodeAcceptedCombatJournalSegment(previous, saved, state, this.identity);
      const checkpoint = this.storage.sql
        .exec<ArchiveRow>(
          "SELECT key, run_epoch, tick, payload FROM combat_archive WHERE key = ?",
          "checkpoint",
        )
        .toArray()[0];
      if (!checkpoint) throw new Error("Missing combat checkpoint");
      const segments = this.storage.sql
        .exec<{ count: number }>(
          "SELECT COUNT(*) AS count FROM combat_archive WHERE key LIKE 'segment:%'",
        )
        .one().count;
      // Partial segments are legal. Compact before a fifth segment would exceed the bounded
      // recovery view, even when fewer than sixty world ticks have elapsed.
      const replace =
        state.combat.tick - checkpoint.tick >= COMBAT_CHECKPOINT_TICKS ||
        segments >= MAX_JOURNAL_SEGMENTS;
      const nextCheckpoint = replace ? await encodeCombatCheckpoint(state, this.identity) : null;
      const preparedAt = performance.now();
      this.storage.transactionSync(() => {
        const head = this.head();
        if (
          !head ||
          head.run_epoch !== previous.snapshot.runEpoch ||
          head.tick !== previous.combat.tick ||
          head.payload !== combatRuntimeHash(previous)
        )
          throw new Error("Combat durable prefix changed");
        if (nextCheckpoint !== null) {
          this.put("checkpoint", state.snapshot.runEpoch, state.combat.tick, nextCheckpoint);
          this.storage.sql.exec("DELETE FROM combat_archive WHERE key LIKE 'segment:%'");
        } else
          this.put(
            `segment:${previous.combat.tick + 1}`,
            state.snapshot.runEpoch,
            state.combat.tick,
            raw,
          );
        this.beforeHeadCommit?.();
        this.put("head", state.snapshot.runEpoch, state.combat.tick, combatRuntimeHash(state));
      });
      // Only this confirmed boundary may advance the caller's durable cursor.
      await this.storage.sync();
      if (this.commits.length < 80)
        this.commits.push({
          runEpoch: state.snapshot.runEpoch,
          fromTick: previous.combat.tick + 1,
          throughTick: state.combat.tick,
          prepareMs: preparedAt - began,
          confirmMs: performance.now() - preparedAt,
        });
      return state;
    });
  }
  transition(
    current: CombatRuntime,
    kind: "load" | "start" | "recover" | "pause" | "expire" | "continue",
    guard?: () => void,
  ): Promise<CombatRuntime> {
    return this.replaceCheckpoint(
      current,
      (previous) => transitionCombatRuntime(previous, kind),
      guard,
    );
  }
  replaceWaitingConnection(current: CombatRuntime, playerId: number): Promise<CombatRuntime> {
    return this.replaceCheckpoint(current, (previous) =>
      replaceWaitingCombatConnection(previous, playerId),
    );
  }
  private replaceCheckpoint(
    current: CombatRuntime,
    change: (previous: CombatRuntime) => CombatRuntime,
    guard?: () => void,
  ): Promise<CombatRuntime> {
    const previous = structuredClone(current);
    return this.exclusive(async () => {
      const state = change(previous);
      const raw = await encodeCombatCheckpoint(state, this.identity);
      this.storage.transactionSync(() => {
        guard?.();
        const head = this.head();
        if (
          !head ||
          head.run_epoch !== previous.snapshot.runEpoch ||
          head.tick !== previous.combat.tick ||
          head.payload !== combatRuntimeHash(previous)
        )
          throw new Error("Combat boundary prefix changed");
        this.put("checkpoint", state.snapshot.runEpoch, state.combat.tick, raw);
        this.storage.sql.exec("DELETE FROM combat_archive WHERE key LIKE 'segment:%'");
        this.beforeHeadCommit?.();
        this.put("head", state.snapshot.runEpoch, state.combat.tick, combatRuntimeHash(state));
      });
      await this.storage.sync();
      return state;
    });
  }
  load(): Promise<CombatRuntime | null> {
    return this.exclusive(async () => {
      // Consume every cursor before awaiting validation/digests; this is one bounded DB view.
      const rows = this.storage.sql
        .exec<ArchiveRow>(
          "SELECT key, run_epoch, tick, payload FROM combat_archive ORDER BY tick, key LIMIT ?",
          MAX_JOURNAL_SEGMENTS + 3,
        )
        .toArray();
      if (rows.length === 0) return null;
      const checkpoint = rows.find((row) => row.key === "checkpoint"),
        head = rows.find((row) => row.key === "head");
      if (
        !checkpoint ||
        !head ||
        rows.length > MAX_JOURNAL_SEGMENTS + 2 ||
        !/^[a-f0-9]{8}$/u.test(head.payload)
      )
        throw new Error("Invalid combat durable metadata");
      let state = await decodeCombatCheckpoint(checkpoint.payload, this.identity);
      if (checkpoint.run_epoch !== state.snapshot.runEpoch || checkpoint.tick !== state.combat.tick)
        throw new Error("Combat checkpoint metadata mismatch");
      for (const segment of rows.filter((row) => row.key !== "checkpoint" && row.key !== "head")) {
        if (
          segment.key !== `segment:${state.combat.tick + 1}` ||
          segment.run_epoch !== state.snapshot.runEpoch ||
          segment.tick <= state.combat.tick ||
          segment.tick > state.combat.tick + COMBAT_SEGMENT_TICKS
        )
          throw new Error("Missing/changed combat durable segment");
        state = await restoreCombatJournalSegment(state, segment.payload, this.identity);
        if (state.combat.tick !== segment.tick) throw new Error("Combat segment metadata mismatch");
      }
      if (
        head.run_epoch !== state.snapshot.runEpoch ||
        head.tick !== state.combat.tick ||
        head.payload !== combatRuntimeHash(state)
      )
        throw new Error("Missing combat durable tail");
      return state;
    });
  }
}

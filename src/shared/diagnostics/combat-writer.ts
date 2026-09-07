import { COMBAT_SEGMENT_TICKS } from "./combat-checkpoint.js";
import { type CombatJournalTick, type CombatRuntime, combatRuntimeHash } from "./combat-runtime.js";

/** Two in-memory segments at most, including the segment awaiting confirmation. */
export const COMBAT_BACKLOG_LIMIT = 30;
export interface CombatWriterPort {
  commit(
    start: CombatRuntime,
    entries: readonly CombatJournalTick[],
    accepted: CombatRuntime,
  ): Promise<CombatRuntime>;
}
export class CombatJournalWriter {
  private durable: CombatRuntime;
  private durableHash: string;
  private acceptedTick: number;
  private acceptedHash: string;
  private queued: CombatJournalTick[] = [];
  private queuedEnd: CombatRuntime | null = null;
  private pending: Promise<void> | null = null;
  private sealed: Promise<CombatRuntime> | null = null;
  private failure: string | null = null;
  private accepting = true;
  constructor(
    private readonly port: CombatWriterPort,
    initial: CombatRuntime,
    private readonly onPause: (reason: string) => void,
    private readonly keepAlive: (work: Promise<void>) => void,
  ) {
    this.durable = structuredClone(initial);
    this.acceptedTick = initial.combat.tick;
    this.acceptedHash = combatRuntimeHash(initial);
    this.durableHash = this.acceptedHash;
  }
  get status() {
    return {
      runEpoch: this.durable.snapshot.runEpoch,
      committedTick: this.durable.combat.tick,
      committedHash: this.durableHash,
      acceptedTick: this.acceptedTick,
      backlogTicks: this.acceptedTick - this.durable.combat.tick,
      queuedTicks: this.queued.length,
      writing: this.pending !== null,
      failure: this.failure,
      accepting: this.accepting,
      limitTicks: COMBAT_BACKLOG_LIMIT,
    };
  }
  record(entry: CombatJournalTick, accepted: CombatRuntime): void {
    if (!this.accepting || this.failure) throw new Error("Combat journal writer requires recovery");
    if (
      entry.tick !== this.acceptedTick + 1 ||
      entry.runEpoch !== this.durable.snapshot.runEpoch ||
      entry.beforeHash !== this.acceptedHash ||
      accepted.combat.tick !== entry.tick ||
      accepted.snapshot.runEpoch !== entry.runEpoch ||
      entry.assertions.length !== 1 ||
      entry.assertions[0]?.kind !== "state-hash"
    )
      throw new Error("Combat writer input prefix changed");
    this.queued.push(structuredClone(entry));
    this.acceptedTick = entry.tick;
    this.acceptedHash = entry.assertions[0].value;
    if (this.queued.length === COMBAT_SEGMENT_TICKS) this.queuedEnd = structuredClone(accepted);
    this.pump();
    if (this.acceptedTick - this.durable.combat.tick >= COMBAT_BACKLOG_LIMIT)
      this.fail("journal-backlog-limit");
  }
  private fail(reason: string) {
    if (this.failure !== null) return;
    this.failure = reason.slice(0, 256);
    this.accepting = false;
    this.onPause(this.failure);
  }
  private pump() {
    if (this.pending || !this.accepting || this.queued.length < COMBAT_SEGMENT_TICKS) return;
    const accepted = this.queuedEnd;
    if (!accepted) throw new Error("Missing accepted combat boundary");
    this.queuedEnd = null;
    const entries = this.queued.splice(0, COMBAT_SEGMENT_TICKS);
    this.write(entries, accepted);
  }
  private write(entries: CombatJournalTick[], accepted: CombatRuntime) {
    // Start on a microtask, after the accepted synchronous world/clock step has returned.
    this.pending = Promise.resolve()
      .then(() => this.port.commit(this.durable, entries, accepted))
      .then((state) => {
        const last = entries.at(-1);
        const hash = combatRuntimeHash(state);
        if (
          !last ||
          state.combat.tick !== last.tick ||
          state.snapshot.runEpoch !== last.runEpoch ||
          hash !== last.assertions[0]?.value
        )
          throw new Error("Combat durable acknowledgment mismatch");
        this.durable = structuredClone(state);
        this.durableHash = hash;
      })
      .catch((error) => {
        this.fail(String(error));
      })
      .finally(() => {
        this.pending = null;
        this.pump();
      });
    this.keepAlive(this.pending);
  }
  /** Stop at the accepted boundary and confirm its final, possibly short segment without new ticks. */
  seal(current: CombatRuntime): Promise<CombatRuntime> {
    if (this.sealed) return this.sealed;
    if (!this.accepting || this.failure)
      return Promise.reject(new Error("Combat journal writer requires recovery"));
    if (
      current.combat.tick !== this.acceptedTick ||
      combatRuntimeHash(current) !== this.acceptedHash
    )
      return Promise.reject(new Error("Combat seal boundary changed"));
    const accepted = structuredClone(current);
    this.accepting = false;
    this.sealed = (async () => {
      await this.pending;
      if (this.failure) throw new Error(this.failure);
      if (this.queued.length) {
        this.write(this.queued.splice(0), accepted);
        this.queuedEnd = null;
        await this.pending;
      }
      if (this.failure) throw new Error(this.failure);
      if (this.durable.combat.tick !== this.acceptedTick || this.durableHash !== this.acceptedHash)
        throw new Error("Unconfirmed combat pause tail");
      return structuredClone(this.durable);
    })();
    return this.sealed;
  }
  /** Stop scheduling new work, wait for the in-flight write, then recover only the durable head. */
  async retire(): Promise<void> {
    this.accepting = false;
    if (this.sealed) await this.sealed.catch(() => {});
    else await this.pending;
    this.queued = [];
    this.queuedEnd = null;
  }
}

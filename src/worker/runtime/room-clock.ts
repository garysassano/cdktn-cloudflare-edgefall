import { COUNTER_LIMIT, integer } from "../../game/core/numeric.js";

export const ROOM_TICK_HZ = 60;
export const MAX_CATCH_UP_STEPS = 4;
export const MAX_SCHEDULING_DEBT_MS = 250;

/** schedule must enqueue asynchronously; its returned cancellation function is idempotent. */
export interface ClockPort {
  now(): number;
  schedule(callback: () => void, delayMs: number): () => void;
}

export type ClockMode = "stopped" | "running" | "recovery" | "closed";
export type ClockFault =
  | "invalid_time"
  | "time_regression"
  | "scheduler_debt"
  | "tick_exhausted"
  | "step_failed"
  | "timer_failed"
  | "observer_failed";

export interface ClockDiscontinuity {
  reason: ClockFault;
  lastCompletedTick: number;
  observedAtMs: number | null;
  debtMs: number | null;
}

export interface ClockSample {
  observedAtMs: number;
  firstDeadlineMs: number;
  latenessMs: number;
  steps: number;
  lastCompletedTick: number;
  remainingDebtMs: number;
}

export interface RoomClockOptions {
  port: ClockPort;
  initialTick: number;
  /** One synchronous world tick. No wall time or variable delta enters the simulation. */
  step(tick: number): undefined;
  onDiscontinuity(event: ClockDiscontinuity): void;
  onSample?(sample: ClockSample): void;
}

/** Owns at most one timeout, no history and no durable alarm. A room adapter owns leases/storage. */
export class RoomClock {
  private modeValue: ClockMode = "stopped";
  private tickValue: number;
  private originMs = 0;
  private epochSteps = 0;
  private lastNow = 0;
  private inCallback = false;
  private notifyingFault = false;
  private timer: { active: boolean; cancel: () => void } | null = null;
  private faultValue: ClockDiscontinuity | null = null;

  constructor(private readonly options: RoomClockOptions) {
    this.tickValue = integer(options.initialTick, 0, COUNTER_LIMIT - 1, "initial clock tick");
  }

  get state(): {
    mode: ClockMode;
    tick: number;
    timerPending: boolean;
    fault: ClockDiscontinuity | null;
  } {
    return {
      mode: this.modeValue,
      tick: this.tickValue,
      timerPending: this.timer !== null,
      fault: this.faultValue && { ...this.faultValue },
    };
  }

  /** Idempotent in play; resume starts a fresh deadline, never catches up paused wall time. */
  start(): void {
    if (this.modeValue === "running") return;
    if (this.inCallback || this.notifyingFault)
      throw new Error("Cannot restart the clock inside its callback");
    if (this.modeValue !== "stopped") throw new Error("Clock needs recovery or is closed");
    const now = this.readTime(false);
    if (now === null) return;
    this.originMs = now;
    this.lastNow = now;
    this.epochSteps = 0;
    this.modeValue = "running";
    this.arm(now);
  }

  /** Call on lobby/empty pause. Recovery cannot be bypassed by stop/start. */
  stop(): void {
    this.cancelTimer();
    if (this.modeValue === "running") this.modeValue = "stopped";
  }

  /** Terminal rooms must construct a new clock for a new run. */
  close(): void {
    this.cancelTimer();
    this.modeValue = "closed";
  }

  /** Caller must first restore/confirm the authoritative world and resynchronize clients. */
  recover(confirmedTick: number): void {
    if (this.inCallback || this.notifyingFault || this.modeValue !== "recovery") {
      throw new Error("Recover only after a discontinuity callback has returned");
    }
    this.tickValue = integer(confirmedTick, 0, COUNTER_LIMIT - 1, "confirmed recovery tick");
    this.faultValue = null;
    this.modeValue = "stopped";
  }

  private deadline(): number {
    // Anchor each deadline rather than repeatedly adding a rounded 16.666... ms delta.
    return this.originMs + ((this.epochSteps + 1) * 1000) / ROOM_TICK_HZ;
  }

  private cancelTimer(): void {
    const timer = this.timer;
    this.timer = null;
    if (timer) {
      timer.active = false;
      timer.cancel();
    }
  }

  private fail(reason: ClockFault, now: number | null, debt: number | null = null): void {
    this.cancelTimer();
    // A terminal decision made by a callback always wins over a later failure.
    if (this.modeValue === "closed") return;
    this.modeValue = "recovery";
    this.faultValue = {
      reason,
      lastCompletedTick: this.tickValue,
      observedAtMs: now,
      debtMs: debt,
    };
    this.notifyingFault = true;
    try {
      this.options.onDiscontinuity({ ...this.faultValue });
    } finally {
      this.notifyingFault = false;
    }
  }

  private readTime(checkRegression: boolean): number | null {
    let now: number;
    try {
      now = this.options.port.now();
    } catch {
      this.fail("invalid_time", null);
      return null;
    }
    // Allows epoch-based Date.now, with enough precision for millisecond deadlines.
    if (!Number.isFinite(now) || now < 0 || now > 2 ** 48) {
      this.fail("invalid_time", null);
      return null;
    }
    if (checkRegression && now < this.lastNow) {
      this.fail("time_regression", now);
      return null;
    }
    return now;
  }

  private arm(now: number): void {
    const timer = { active: true, cancel: () => {} };
    this.timer = timer;
    try {
      timer.cancel = this.options.port.schedule(
        () => {
          if (!timer.active || this.timer !== timer || this.modeValue !== "running") return;
          timer.active = false;
          this.timer = null;
          this.onTimer();
        },
        Math.max(1, this.deadline() - now),
      );
    } catch {
      this.fail("timer_failed", now);
    }
  }

  private onTimer(): void {
    this.inCallback = true;
    try {
      // Workerd time is sampled once on entry, never used as an in-callback CPU timer.
      const now = this.readTime(true);
      if (now === null) return;
      this.lastNow = now;
      const firstDeadline = this.deadline();
      const debt = Math.max(0, now - firstDeadline);
      if (now > firstDeadline + MAX_SCHEDULING_DEBT_MS) {
        this.fail("scheduler_debt", now, debt);
        return;
      }
      let steps = 0;
      while (this.modeValue === "running" && steps < MAX_CATCH_UP_STEPS && now >= this.deadline()) {
        if (this.tickValue >= COUNTER_LIMIT - 1) {
          this.fail("tick_exhausted", now);
          return;
        }
        try {
          const result: unknown = this.options.step(this.tickValue + 1);
          if (result !== undefined) {
            // Reject accidentally asynchronous adapters, including JS callers bypassing types.
            if (result instanceof Promise) void result.catch(() => {});
            throw new Error("World step must be synchronous and return undefined");
          }
        } catch {
          this.fail("step_failed", now);
          return;
        }
        this.tickValue++;
        this.epochSteps++;
        steps++;
      }
      try {
        this.options.onSample?.({
          observedAtMs: now,
          firstDeadlineMs: firstDeadline,
          latenessMs: debt,
          steps,
          lastCompletedTick: this.tickValue,
          remainingDebtMs: Math.max(0, now - this.deadline()),
        });
      } catch {
        this.fail("observer_failed", now);
        return;
      }
      if (this.modeValue === "running") this.arm(now);
    } finally {
      this.inCallback = false;
    }
  }
}

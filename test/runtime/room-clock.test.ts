import { describe, expect, it } from "vitest";
import { COUNTER_LIMIT } from "../../src/game/core/numeric.js";
import {
  type ClockDiscontinuity,
  type ClockPort,
  type ClockSample,
  RoomClock,
} from "../../src/worker/runtime/room-clock.js";

class ManualClock implements ClockPort {
  time = 0;
  reads = 0;
  tasks: Array<{ callback: () => void; delay: number; cancelled: boolean }> = [];
  now(): number {
    this.reads++;
    return this.time;
  }
  schedule(callback: () => void, delay: number): () => void {
    const task = { callback, delay, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }
  fire(time: number): void {
    this.time = time;
    const task = this.tasks.shift();
    if (!task) throw new Error("No scheduled task");
    // Deliberately execute even cancelled tasks, like an already-queued runtime callback.
    task.callback();
  }
}

function fixture(initialTick = 0) {
  const port = new ManualClock();
  const ticks: number[] = [];
  const samples: ClockSample[] = [];
  const faults: ClockDiscontinuity[] = [];
  const clock = new RoomClock({
    port,
    initialTick,
    step: (tick) => {
      ticks.push(tick);
    },
    onSample: (sample) => samples.push(sample),
    onDiscontinuity: (fault) => faults.push(fault),
  });
  return { port, clock, ticks, samples, faults };
}

describe("deadline room clock", () => {
  it("owns one timer, advances no early tick and preserves 60 Hz deadlines for six hours", () => {
    const { port, clock, ticks, faults } = fixture();
    clock.start();
    clock.start();
    expect(port.tasks).toHaveLength(1);
    port.fire(0);
    expect(ticks).toEqual([]);
    expect(port.tasks[0]?.delay).toBeCloseTo(1000 / 60);
    // Integer millisecond clock samples expose repeated-addition drift at exact seconds.
    for (let second = 0; second < 6 * 60 * 60; second++) {
      for (let tick = 1; tick <= 60; tick++)
        port.fire(second * 1000 + Math.ceil((tick * 1000) / 60));
    }
    expect(clock.state.tick).toBe(6 * 60 * 60 * 60);
    expect(ticks[0]).toBe(1);
    expect(ticks.at(-1)).toBe(clock.state.tick);
    expect(faults).toEqual([]);
    expect(port.tasks).toHaveLength(1);
    expect(port.reads).toBe(ticks.length + 2);
  });

  it("limits catch-up to four constant steps and yields at least one millisecond", () => {
    const { port, clock, ticks, samples } = fixture(40);
    clock.start();
    port.fire(100);
    expect(ticks).toEqual([41, 42, 43, 44]);
    expect(samples[0]?.steps).toBe(4);
    expect(port.tasks[0]?.delay).toBe(1);
    port.fire(101);
    expect(ticks).toEqual([41, 42, 43, 44, 45, 46]);
    expect(port.tasks[0]?.delay).toBeCloseTo(116.6666666667 - 101);
  });

  it("pauses before any combat step beyond 250 ms debt and demands explicit recovery", () => {
    const { port, clock, ticks, faults } = fixture(100);
    clock.start();
    port.fire(1000 / 60 + 251);
    expect(ticks).toEqual([]);
    expect(faults).toEqual([
      {
        reason: "scheduler_debt",
        lastCompletedTick: 100,
        observedAtMs: 1000 / 60 + 251,
        debtMs: expect.closeTo(251),
      },
    ]);
    expect(clock.state.timerPending).toBe(false);
    clock.stop();
    expect(() => clock.start()).toThrow(/recovery/);
    expect(() => clock.recover(-1)).toThrow();
    clock.recover(90);
    port.time = 5000;
    clock.start();
    port.fire(5017);
    expect(ticks).toEqual([91]);
    expect(clock.state.fault).toBeNull();
  });

  it("allows the documented debt boundary without unbounded work", () => {
    const { port, clock, faults, ticks } = fixture();
    clock.start();
    port.fire(1000 / 60 + 250);
    expect(ticks).toHaveLength(4);
    expect(faults).toEqual([]);
    expect(port.tasks[0]?.delay).toBe(1);
  });

  it("cancels on pause/terminal and ignores old callbacks after a new epoch starts", () => {
    const { port, clock, ticks } = fixture();
    clock.start();
    const old = port.tasks[0];
    clock.stop();
    expect(old?.cancelled).toBe(true);
    port.time = 10000;
    clock.start();
    port.fire(10001); // Old cancelled callback cannot clear the new timer.
    expect(clock.state.timerPending).toBe(true);
    expect(ticks).toEqual([]);
    port.fire(10017);
    expect(ticks).toEqual([1]);
    clock.close();
    port.fire(11000);
    expect(ticks).toEqual([1]);
    expect(clock.state).toMatchObject({ mode: "closed", timerPending: false });
    expect(() => clock.start()).toThrow();
  });

  it("does not accept a duplicate already-fired callback", () => {
    const { port, clock, ticks } = fixture();
    clock.start();
    const callback = port.tasks[0]?.callback;
    port.fire(17);
    callback?.();
    expect(ticks).toEqual([1]);
    expect(port.tasks).toHaveLength(1);
  });

  it.each([NaN, Infinity, -1, 2 ** 48 + 1])("rejects invalid time %s without arming", (time) => {
    const { port, clock, faults } = fixture();
    port.time = time;
    clock.start();
    expect(faults[0]?.reason).toBe("invalid_time");
    expect(port.tasks).toEqual([]);
  });

  it("treats a regressing clock as a discontinuity", () => {
    const { port, clock, faults } = fixture();
    port.time = 100;
    clock.start();
    port.fire(99);
    expect(faults[0]?.reason).toBe("time_regression");
    expect(clock.state.timerPending).toBe(false);
  });

  it("requires recovery outside fault notification even when startup time is invalid", () => {
    const port = new ManualClock();
    port.time = NaN;
    const clock = new RoomClock({
      port,
      initialTick: 0,
      step() {},
      onDiscontinuity() {
        expect(() => clock.recover(0)).toThrow(/returned/);
        expect(() => clock.start()).toThrow(/callback/);
      },
    });
    clock.start();
    expect(clock.state.mode).toBe("recovery");
    clock.recover(0);
    port.time = 0;
    clock.start();
    expect(clock.state.mode).toBe("running");
    clock.close();
  });

  it("does not acknowledge a failed world step or retry it against uncertain world state", () => {
    const port = new ManualClock();
    const completed: number[] = [];
    const clock = new RoomClock({
      port,
      initialTick: 0,
      step(tick) {
        if (tick === 2) throw new Error("partial world mutation");
        completed.push(tick);
      },
      onDiscontinuity() {},
    });
    clock.start();
    port.fire(100);
    expect(completed).toEqual([1]);
    expect(clock.state).toMatchObject({
      mode: "recovery",
      tick: 1,
      timerPending: false,
      fault: { reason: "step_failed", lastCompletedTick: 1 },
    });
    expect(() => clock.start()).toThrow();
  });

  it("stops catch-up when a world tick reaches terminal or empty pause", () => {
    for (const terminal of [false, true]) {
      const port = new ManualClock();
      const clock = new RoomClock({
        port,
        initialTick: 0,
        step() {
          if (terminal) clock.close();
          else clock.stop();
        },
        onDiscontinuity() {},
      });
      clock.start();
      port.fire(100);
      expect(clock.state).toMatchObject({
        mode: terminal ? "closed" : "stopped",
        tick: 1,
        timerPending: false,
      });
      expect(port.tasks).toEqual([]);
    }
  });

  it("rejects an async world step even when JS bypasses the synchronous type", () => {
    const port = new ManualClock();
    const clock = new RoomClock({
      port,
      initialTick: 0,
      step: (() => Promise.reject(new Error("async"))) as unknown as () => undefined,
      onDiscontinuity() {},
    });
    clock.start();
    port.fire(17);
    expect(clock.state).toMatchObject({
      mode: "recovery",
      tick: 0,
      fault: { reason: "step_failed" },
    });
  });

  it("fails safely on timer or observer failure and stops at the counter bound", () => {
    const first = fixture();
    first.port.schedule = () => {
      throw new Error("timer unavailable");
    };
    first.clock.start();
    expect(first.clock.state).toMatchObject({
      mode: "recovery",
      timerPending: false,
      fault: { reason: "timer_failed" },
    });
    const last = fixture(COUNTER_LIMIT - 2);
    last.clock.start();
    last.port.fire(100);
    expect(last.ticks).toEqual([COUNTER_LIMIT - 1]);
    expect(last.faults[0]?.reason).toBe("tick_exhausted");
    const port = new ManualClock();
    const clock = new RoomClock({
      port,
      initialTick: 0,
      step() {},
      onDiscontinuity() {},
      onSample() {
        throw new Error("observer unavailable");
      },
    });
    clock.start();
    port.fire(17);
    expect(clock.state).toMatchObject({
      mode: "recovery",
      tick: 1,
      timerPending: false,
      fault: { reason: "observer_failed" },
    });
  });
});

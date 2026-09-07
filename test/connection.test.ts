import { describe, expect, it } from "vitest";
import { RoomConnectError, reconnectDelay } from "../src/shared/session/connection.js";

import { harness, required, settle } from "./fixtures/connection-port.js";

describe("generation-fenced room transport", () => {
  it("does not resurrect a connection cancelled synchronously by a status observer", async () => {
    for (const phase of ["connecting", "retrying", "awaiting-baseline", "connected"] as const) {
      const h = harness(undefined, (state) => {
        if (state.phase === phase) h.connection.leave();
      });
      h.connection.start();
      await settle();
      if (phase !== "connecting") {
        const socket = required(h.sockets[0]);
        socket.open();
        if (phase === "retrying") socket.closed();
        if (phase === "connected")
          expect(h.connection.ready(h.connection.status.generation)).toBe(false);
      }
      expect(h.connection.status.phase).toBe("idle");
      expect(h.tasks.filter((t) => t.active)).toHaveLength(0);
      await h.advance(90_000);
      expect(h.connection.status.phase).toBe("idle");
    }
  });
  it("requires an application baseline before marking connected and sends no queued old gameplay", async () => {
    const h = harness();
    const socket = await h.start();
    expect(h.connection.send("before-open")).toBe(false);
    socket.open();
    expect(h.connection.status.phase).toBe("awaiting-baseline");
    h.connection.send("join-or-baseline-ack");
    expect(h.connection.ready(h.connection.status.generation)).toBe(true);
    expect(h.connection.status.phase).toBe("connected");
    socket.closed();
    expect(h.connection.status.phase).toBe("retrying");
    expect(h.connection.send("old-gameplay")).toBe(false);
    await h.advance(225);
    const next = required(h.sockets[1]);
    next.open();
    expect(next.sent).toEqual([]);
  });
  it("ignores delayed messages, opens, closes and baseline acceptance from every retired attempt", async () => {
    const h = harness();
    const old = await h.start();
    old.open();
    const generation = h.connection.status.generation;
    old.closed();
    await h.advance(225);
    const next = required(h.sockets[1]);
    next.open();
    const latest = h.connection.status.generation;
    next.message("current");
    old.message("stale reward");
    old.open();
    old.closed();
    expect(h.connection.ready(generation)).toBe(false);
    expect(h.connection.ready(latest)).toBe(true);
    expect(h.received).toEqual(["current"]);
    expect(h.opened).toHaveLength(2);
    expect(h.tasks.filter((t) => t.active)).toHaveLength(0);
    expect(next.readyState).toBe(1);
  });
  it("cancels unresolved preparation and stale timers when changing rooms or leaving", async () => {
    const waits: Array<{ signal: AbortSignal; resolve: (url: string) => void }> = [];
    const h = harness((signal) => new Promise((resolve) => waits.push({ signal, resolve })));
    h.connection.start();
    const oldTimer = required(h.tasks.at(-1));
    h.connection.start();
    expect(waits[0]?.signal.aborted).toBe(true);
    required(waits[0]).resolve("ws://old-room");
    await settle();
    expect(h.sockets).toHaveLength(0);
    required(waits[1]).resolve("ws://new-room");
    await settle();
    const next = required(h.sockets[0]);
    next.open();
    oldTimer.run();
    expect(h.connection.status.phase).toBe("awaiting-baseline");
    h.connection.leave();
    expect(h.connection.status.phase).toBe("idle");
    await h.advance(100_000);
    expect(h.sockets).toHaveLength(1);
    next.message("late result");
    expect(h.received).toEqual([]);
  });
  it("bounds a silent handshake, preserves backoff across socket opens and expires repeated flapping", async () => {
    const h = harness();
    const socket = await h.start();
    socket.open();
    await h.advance(5000);
    expect(h.connection.status).toMatchObject({ phase: "retrying", attempt: 1 });
    await h.advance(225);
    required(h.sockets[1]).open();
    required(h.sockets[1]).closed();
    expect(h.connection.status).toMatchObject({ phase: "retrying", attempt: 2 });
    await h.advance(90_000);
    expect(h.connection.status).toMatchObject({ phase: "stopped", reason: "reservation-expired" });
    expect(h.tasks.some((t) => t.active)).toBe(false);
    expect(h.sockets.length).toBeLessThan(20);
  });
  it("stops distinct admission failures without retrying or creating another room", async () => {
    for (const reason of [
      "room-full",
      "in-progress",
      "incompatible-build",
      "profile-required",
      "reservation-expired",
    ] as const) {
      const h = harness(async () => {
        throw new RoomConnectError(reason);
      });
      h.connection.start();
      await settle();
      await h.advance(90_000);
      expect(h.connection.status).toMatchObject({ phase: "stopped", reason });
      expect(h.sockets).toHaveLength(0);
    }
  });
  it("drops backpressured gameplay and owns only one retry after error plus close", async () => {
    const h = harness();
    const socket = await h.start();
    socket.open();
    socket.bufferedAmount = 4097;
    expect(h.connection.send("input")).toBe(false);
    socket.dispatchEvent(new Event("error"));
    socket.closed();
    expect(h.connection.status.attempt).toBe(1);
    expect(h.tasks.filter((t) => t.active)).toHaveLength(1);
    expect(h.suspended).toBeGreaterThan(0);
    expect(socket.sent).toEqual([]);
  });
  it("resets backoff only after a stable application connection", async () => {
    const h = harness();
    const socket = await h.start();
    socket.open();
    socket.closed();
    await h.advance(225);
    const next = required(h.sockets[1]);
    next.open();
    h.connection.ready(h.connection.status.generation);
    await h.advance(5000);
    next.closed();
    expect(h.connection.status.attempt).toBe(1);
  });
  it("caps jitter without zero-delay or unbounded retry schedules", () => {
    expect(reconnectDelay(1, 0)).toBe(150);
    expect(reconnectDelay(1, 0.999)).toBe(299);
    expect(reconnectDelay(1000, 0.999)).toBe(2998);
    expect(() => reconnectDelay(1, 1)).toThrow();
    expect(() => reconnectDelay(0, 0)).toThrow();
  });
});

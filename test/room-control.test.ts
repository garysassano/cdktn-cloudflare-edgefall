import { describe, expect, it, vi } from "vitest";
import {
  admitMember,
  createMembership,
  disconnectMember,
} from "../src/shared/session/membership.js";
import {
  HOST_COMMANDS,
  type HostCommand,
  decodeHostCommand,
  decodeRoomControlState,
  readHostCommand,
  requireCurrentHost,
  roomControlState,
} from "../src/shared/session/room-control.js";
import type { RoomMode } from "../src/shared/session/room-phase.js";

const host = "11111111-1111-4111-8111-111111111111";
const guest = "22222222-2222-4222-8222-222222222222";
const outsider = "33333333-3333-4333-8333-333333333333";
const party = () =>
  admitMember(admitMember(createMembership(), host, 0, "lobby", 1000), guest, 1, "lobby", 1001);
describe("phase-aware room membership", () => {
  it.each<[{ mode: RoomMode; newcomer: string | null; member: string | null }]>([
    [{ mode: "lobby", newcomer: null, member: null }],
    [{ mode: "loading", newcomer: "in-progress", member: null }],
    [{ mode: "playing", newcomer: "in-progress", member: null }],
    [{ mode: "intermission", newcomer: null, member: null }],
    [{ mode: "paused-empty", newcomer: "in-progress", member: null }],
    [{ mode: "recovering", newcomer: "outage", member: "outage" }],
    [{ mode: "completed", newcomer: "room-ended", member: null }],
    [{ mode: "expired", newcomer: "room-ended", member: "room-ended" }],
  ])("applies $mode admission to new and reserved identities", ({ mode, newcomer, member }) => {
    const state = disconnectMember(party(), 0, 1, 2000);
    const previous = structuredClone(state);
    const join = () => admitMember(state, outsider, 2, mode, 2001);
    const resume = () => admitMember(state, host, 0, mode, 2001);
    if (newcomer) expect(join).toThrow(newcomer);
    else expect(join().members.find((m) => m.slot === 2)?.connected).toBe(true);
    if (member) expect(resume).toThrow(member);
    else {
      expect(resume().members[0]).toMatchObject({
        generation: 2,
        joinedOrdinal: 1,
        connected: true,
      });
      expect(resume().hostSlot).toBe(1);
    }
    expect(state).toEqual(previous);
  });
  it("does not renew an expired reservation in a lobby, intermission or completed results view", () => {
    const state = disconnectMember(party(), 0, 1, 2000);
    for (const phase of ["lobby", "intermission", "completed"] as const)
      expect(() => admitMember(state, host, 0, phase, 92_000)).toThrow("reconnect-window-expired");
    expect(admitMember(state, outsider, 0, "intermission", 92_000).members[0]?.joinedOrdinal).toBe(
      3,
    );
    expect(() => admitMember(state, outsider, 0, "completed", 92_000)).toThrow("room-ended");
  });
  it("keeps generations distinct when a different profile takes an expired slot", () => {
    const expired = disconnectMember(party(), 0, 1, 2000);
    const joined = admitMember(expired, outsider, 0, "intermission", 92_000);
    expect(joined.members[0]).toMatchObject({
      profileId: outsider,
      generation: 2,
      joinedOrdinal: 3,
    });
    expect(disconnectMember(joined, 0, 1, 92_001)).toEqual(joined);
    expect(() =>
      requireCurrentHost(joined, host, 1, 1, {
        command: "start",
        runEpoch: 1,
        connectionEpoch: 1,
        membershipEpoch: joined.epoch,
      }),
    ).toThrow("host-required");
  });
});
describe("host commands and control state", () => {
  it.each(HOST_COMMANDS)(
    "fences %s with host, membership, run and connection ownership",
    (command) => {
      const state = party();
      const intent: HostCommand = {
        command,
        membershipEpoch: state.epoch,
        runEpoch: 3,
        connectionEpoch: 7,
      };
      expect(() => requireCurrentHost(state, host, 3, 7, intent)).not.toThrow();
      for (const profile of [guest, outsider])
        expect(() => requireCurrentHost(state, profile, 3, 7, intent)).toThrow("host-required");
      for (const stale of [
        { ...intent, membershipEpoch: state.epoch - 1 },
        { ...intent, runEpoch: 2 },
        { ...intent, connectionEpoch: 6 },
      ])
        expect(() => requireCurrentHost(state, host, 3, 7, stale)).toThrow("stale-host-command");
      const left = disconnectMember(state, 0, 1, 2000);
      expect(() => requireCurrentHost(left, host, 3, 7, intent)).toThrow("host-required");
      const rejoined = admitMember(left, host, 0, "loading", 2001);
      expect(() =>
        requireCurrentHost(rejoined, host, 3, 8, {
          ...intent,
          membershipEpoch: rejoined.epoch,
          connectionEpoch: 8,
        }),
      ).toThrow("host-required");
    },
  );
  it("strictly decodes commands and publishes only bounded non-private membership fields", () => {
    const state = party();
    const command: HostCommand = {
      command: "load",
      membershipEpoch: state.epoch,
      runEpoch: 1,
      connectionEpoch: 1,
    };
    expect(decodeHostCommand(JSON.stringify(command))).toEqual(command);
    for (const value of [
      null,
      [],
      { ...command, admin: true },
      { ...command, membershipEpoch: 0 },
      { ...command, command: "grant-lives" },
    ])
      expect(() => decodeHostCommand(JSON.stringify(value))).toThrow();
    expect(() => decodeHostCommand(" ".repeat(513))).toThrow(/size/);
    const view = roomControlState(state, "lobby", 1);
    const raw = JSON.stringify(view);
    expect(raw).not.toContain(host);
    expect(raw).not.toContain(guest);
    expect(decodeRoomControlState(raw)).toEqual(view);
    for (const mutate of [
      { ...view, hostSlot: null },
      { ...view, hostSlot: 3 },
      { ...view, members: [...view.members, view.members[0]] },
      { ...view, extra: true },
      { ...view, roomMode: "unknown" },
    ])
      expect(() => decodeRoomControlState(JSON.stringify(mutate))).toThrow();
  });
  it("bounds streamed commands before parsing and cancels an oversized body", async () => {
    let cancelled = false;
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      duplex: "half",
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(513));
        },
        cancel() {
          cancelled = true;
        },
      }),
    };
    await expect(readHostCommand(new Request("https://room/control", init))).rejects.toThrow(
      /size/,
    );
    expect(cancelled).toBe(true);
  });
  it("expires an incomplete body even if cancelling its stream never settles", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        duplex: "half",
        body: new ReadableStream({
          cancel() {
            cancelled = true;
            return new Promise(() => {});
          },
        }),
      };
      const check = expect(
        readHostCommand(new Request("https://room/control", init)),
      ).rejects.toThrow(/timeout/);
      await vi.advanceTimersByTimeAsync(2001);
      await check;
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

import { describe, expect, it } from "vitest";
import { COUNTER_LIMIT } from "../src/game/core/numeric.js";
import {
  admitMember,
  checkpointMembership,
  createMembership,
  decodeMembership,
  disconnectMember,
  emptyReservationDeadline,
  recoverMembership,
} from "../src/shared/session/membership.js";
import {
  profileCookie,
  signProfileIdentity,
  verifyProfileIdentity,
} from "../src/shared/session/profile.js";

const id = "11111111-1111-4111-8111-111111111111",
  other = "22222222-2222-4222-8222-222222222222",
  secret = "a".repeat(32);
describe("signed anonymous browser identity", () => {
  it("verifies the existing UUID.expiry.HMAC cookie format and rejects tampering, expiration and malformed claims", async () => {
    const signed = await signProfileIdentity(id, 2000, secret);
    expect(await verifyProfileIdentity(signed, secret, 1999)).toBe(id);
    expect(await verifyProfileIdentity(signed, secret, 2000)).toBeUndefined();
    expect(await verifyProfileIdentity(signed, "b".repeat(32), 0)).toBeUndefined();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const noncanonical = signed.slice(0, -1) + alphabet[alphabet.indexOf(signed.at(-1) ?? "") + 1];
    expect(await verifyProfileIdentity(noncanonical, secret, 0)).toBeUndefined();
    for (const value of [
      signed.replace(id, other),
      signed.replace(".2000.", ".3000."),
      `${signed}.extra`,
      signed.replace(".2000.", ".02000."),
      "x".repeat(129),
      "",
      undefined,
    ])
      expect(await verifyProfileIdentity(value, secret, 0)).toBeUndefined();
    await expect(signProfileIdentity(id, 2000, "short")).rejects.toThrow(/32/);
    await expect(signProfileIdentity("unbound-owner", 2000, secret)).rejects.toThrow(/identity/);
  });
  it("rejects ambiguous duplicate cookies and unbounded headers", () => {
    expect(profileCookie("unrelated=x; edgefall_profile=signed; theme=dark")).toBe("signed");
    expect(profileCookie("edgefall_profile=a; edgefall_profile=b")).toBeUndefined();
    expect(profileCookie(`edgefall_profile=${"x".repeat(8192)}`)).toBeUndefined();
    expect(profileCookie(null)).toBeUndefined();
  });
});
describe("profile-bound room reservations", () => {
  it("expires only an empty party at its final reservation deadline without extending it on wake", () => {
    let state = admitMember(createMembership(), id, 0, true, 1000);
    state = admitMember(state, other, 1, true, 2000);
    expect(emptyReservationDeadline(state)).toBeNull();
    state = disconnectMember(state, 0, 1, 3000);
    expect(emptyReservationDeadline(state)).toBeNull();
    state = disconnectMember(state, 1, 1, 4000);
    expect(emptyReservationDeadline(state)).toBe(94_000);
    expect(recoverMembership(state)).toEqual(state);
    expect(recoverMembership(recoverMembership(state))).toEqual(state);
    const admitted = admitMember(state, id, 0, false, 92_999);
    expect(emptyReservationDeadline(admitted)).toBeNull();
    const backwards = disconnectMember(admitted, 0, 2, 1000);
    expect(backwards.members[0]?.lastSeenAtMs).toBe(92_999);
    expect(emptyReservationDeadline(backwards)).toBe(182_999);
    expect(emptyReservationDeadline(createMembership())).toBeNull();
  });
  it("rejects foreign slot claims and one identity controlling multiple slots", () => {
    const joined = admitMember(createMembership(), id, 0, true, 1000);
    expect(() => admitMember(joined, other, 0, true, 1001)).toThrow("slot-reserved");
    expect(() => admitMember(joined, other, 1, false, 1001)).toThrow("in-progress");
    expect(() => admitMember(joined, id, 1, false, 1001)).toThrow("profile-slot-mismatch");
  });
  it("fences old closes on connected takeover and preserves join order on reentry without reclaiming host", () => {
    let state = admitMember(createMembership(), id, 0, true, 1000);
    state = admitMember(state, other, 1, true, 1001);
    const replaced = admitMember(state, id, 0, false, 1002);
    expect(disconnectMember(replaced, 0, 1, 1003)).toEqual(replaced);
    state = disconnectMember(replaced, 0, 2, 1004);
    expect(state.hostSlot).toBe(1);
    const returned = admitMember(state, id, 0, false, 1005);
    expect(returned.hostSlot).toBe(1);
    expect(returned.members[0]).toMatchObject({ generation: 3, joinedOrdinal: 1, connected: true });
    expect(returned.epoch).toBe(state.epoch + 1);
  });
  it("uses a strict 90-second reservation and never admits strangers mid-run after expiry", () => {
    const state = disconnectMember(admitMember(createMembership(), id, 0, true, 1000), 0, 1, 2000);
    expect(admitMember(state, id, 0, false, 91_999).members[0]?.connected).toBe(true);
    expect(() => admitMember(state, id, 0, false, 92_000)).toThrow("reconnect-window-expired");
    expect(() => admitMember(state, other, 0, false, 92_000)).toThrow("in-progress");
    expect(admitMember(state, other, 0, true, 92_000).members[0]?.profileId).toBe(other);
  });
  it("persists the heartbeat and does not extend the reconnect window through repeated cold restarts", () => {
    const state = checkpointMembership(admitMember(createMembership(), id, 0, true, 1000), 5000);
    const restored = recoverMembership(decodeMembership(JSON.stringify(state)));
    const twice = recoverMembership(decodeMembership(JSON.stringify(restored)));
    expect(twice.members[0]).toMatchObject({ connected: false, reservedUntilMs: 95_000 });
    expect(admitMember(twice, id, 0, false, 94_999).members[0]?.generation).toBe(2);
    expect(() => admitMember(twice, id, 0, false, 95_000)).toThrow("reconnect-window-expired");
  });
  it("rejects corrupt durable ownership and counter exhaustion", () => {
    const state = admitMember(createMembership(), id, 0, true, 1000);
    expect(() => decodeMembership(JSON.stringify({ ...state, bypass: true }))).toThrow(/fields/);
    expect(() => decodeMembership("null")).toThrow(/fields/);
    for (const mutate of [
      (s: typeof state) => {
        s.members.push({ ...required(s.members[0]) });
      },
      (s: typeof state) => {
        s.hostSlot = 3;
      },
      (s: typeof state) => {
        required(s.members[0]).reservedUntilMs++;
      },
    ]) {
      const corrupt = structuredClone(state);
      mutate(corrupt);
      expect(() => decodeMembership(JSON.stringify(corrupt))).toThrow();
    }
    required(state.members[0]).generation = COUNTER_LIMIT - 1;
    expect(() => admitMember(state, id, 0, false, 1001)).toThrow(/generation/);
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}

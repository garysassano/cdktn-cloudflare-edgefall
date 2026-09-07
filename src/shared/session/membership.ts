import { COUNTER_LIMIT, integer } from "../../game/core/numeric.js";
import { isProfileId } from "./profile.js";

export const RECONNECT_WINDOW_MS = 90_000;
export interface RoomMember {
  slot: number;
  profileId: string;
  joinedOrdinal: number;
  generation: number;
  connected: boolean;
  lastSeenAtMs: number;
  reservedUntilMs: number;
}
export interface RoomMembership {
  format: 1;
  epoch: number;
  nextOrdinal: number;
  hostSlot: number | null;
  members: RoomMember[];
}
export function createMembership(): RoomMembership {
  return { format: 1, epoch: 1, nextOrdinal: 1, hostSlot: null, members: [] };
}
function time(now: number) {
  integer(now, 0, Number.MAX_SAFE_INTEGER - RECONNECT_WINDOW_MS, "membership clock");
}
function changed(state: RoomMembership): RoomMembership {
  state.epoch = integer(state.epoch + 1, 1, COUNTER_LIMIT - 1, "membership epoch");
  if (!state.members.some((m) => m.slot === state.hostSlot && m.connected))
    state.hostSlot =
      state.members.filter((m) => m.connected).sort((a, b) => a.joinedOrdinal - b.joinedOrdinal)[0]
        ?.slot ?? null;
  return state;
}
/** The gateway authenticates the profile; slot hints never establish ownership. */
export function admitMember(
  current: RoomMembership,
  profileId: string,
  slot: number,
  lobby: boolean,
  now: number,
): RoomMembership {
  time(now);
  integer(slot, 0, 3, "membership slot");
  if (!isProfileId(profileId)) throw new Error("profile-required");
  const state = structuredClone(current);
  const owned = state.members.find((m) => m.profileId === profileId);
  const occupant = state.members.find((m) => m.slot === slot);
  if (owned && owned.slot !== slot) throw new Error("profile-slot-mismatch");
  if (!owned) {
    if (!lobby) throw new Error("in-progress");
    if (occupant && (occupant.connected || now < occupant.reservedUntilMs))
      throw new Error("slot-reserved");
    state.members = state.members.filter((m) => m.slot !== slot);
    state.members.push({
      slot,
      profileId,
      joinedOrdinal: state.nextOrdinal,
      generation: 1,
      connected: true,
      lastSeenAtMs: now,
      reservedUntilMs: now + RECONNECT_WINDOW_MS,
    });
    state.nextOrdinal = integer(state.nextOrdinal + 1, 1, COUNTER_LIMIT - 1, "membership ordinal");
  } else {
    if (!owned.connected && now >= owned.reservedUntilMs)
      throw new Error("reconnect-window-expired");
    owned.generation = integer(owned.generation + 1, 1, COUNTER_LIMIT - 1, "membership generation");
    owned.connected = true;
    owned.lastSeenAtMs = Math.max(now, owned.lastSeenAtMs);
    owned.reservedUntilMs = owned.lastSeenAtMs + RECONNECT_WINDOW_MS;
  }
  state.members.sort((a, b) => a.slot - b.slot);
  return changed(state);
}
/** A delayed close from an older socket cannot reserve or evict its replacement. */
export function disconnectMember(
  current: RoomMembership,
  slot: number,
  generation: number,
  now: number,
): RoomMembership {
  time(now);
  const state = structuredClone(current);
  const member = state.members.find((m) => m.slot === slot && m.generation === generation);
  if (!member?.connected) return state;
  member.connected = false;
  member.lastSeenAtMs = Math.max(now, member.lastSeenAtMs);
  member.reservedUntilMs = member.lastSeenAtMs + RECONNECT_WINDOW_MS;
  return changed(state);
}
export function checkpointMembership(current: RoomMembership, now: number): RoomMembership {
  time(now);
  const state = structuredClone(current);
  for (const member of state.members)
    if (member.connected) {
      member.lastSeenAtMs = Math.max(member.lastSeenAtMs, now);
      member.reservedUntilMs = member.lastSeenAtMs + RECONNECT_WINDOW_MS;
    }
  return state;
}
/** A restart uses the last durable heartbeat, never a newly minted 90-second window. */
export function recoverMembership(current: RoomMembership): RoomMembership {
  const state = structuredClone(current);
  if (!state.members.some((member) => member.connected)) return state;
  for (const member of state.members) member.connected = false;
  return changed(state);
}
/** Expire an empty room only after its final reserved member loses admission. */
export function emptyReservationDeadline(state: RoomMembership): number | null {
  if (!state.members.length || state.members.some((member) => member.connected)) return null;
  return Math.max(...state.members.map((member) => member.reservedUntilMs));
}
export function decodeMembership(raw: string): RoomMembership {
  if (raw.length > 4096) throw new Error("Membership size");
  const state = JSON.parse(raw) as RoomMembership;
  fields(state, "format epoch nextOrdinal hostSlot members");
  if (state.format !== 1 || !Array.isArray(state.members) || state.members.length > 4)
    throw new Error("Membership format");
  integer(state.epoch, 1, COUNTER_LIMIT - 1, "membership epoch");
  integer(state.nextOrdinal, 1, COUNTER_LIMIT - 1, "membership ordinal");
  const profiles = new Set<string>(),
    ordinals = new Set<number>();
  let lastSlot = -1;
  for (const member of state.members) {
    fields(
      member,
      "slot profileId joinedOrdinal generation connected lastSeenAtMs reservedUntilMs",
    );
    integer(member.slot, lastSlot + 1, 3, "membership slot order");
    lastSlot = member.slot;
    integer(member.joinedOrdinal, 1, state.nextOrdinal - 1, "joined ordinal");
    integer(member.generation, 1, COUNTER_LIMIT - 1, "member generation");
    time(member.lastSeenAtMs);
    if (
      !isProfileId(member.profileId) ||
      profiles.has(member.profileId) ||
      ordinals.has(member.joinedOrdinal) ||
      typeof member.connected !== "boolean" ||
      member.reservedUntilMs !== member.lastSeenAtMs + RECONNECT_WINDOW_MS
    )
      throw new Error("Invalid membership record");
    profiles.add(member.profileId);
    ordinals.add(member.joinedOrdinal);
  }
  if (
    state.hostSlot === null
      ? state.members.some((m) => m.connected)
      : !state.members.some((m) => m.slot === state.hostSlot && m.connected)
  )
    throw new Error("Invalid membership host");
  return state;
}
function fields(value: unknown, expected: string) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(" ") !== expected.split(" ").sort().join(" ")
  )
    throw new Error("Membership fields");
}

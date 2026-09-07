import { COUNTER_LIMIT, integer } from "../../game/core/numeric.js";
import { ROOM_MODES } from "../protocol/snapshot-schema.js";
import type { RoomMembership } from "./membership.js";
import type { RoomMode } from "./room-phase.js";

export const HOST_COMMANDS = ["load", "start", "continue", "rematch"] as const;
export type HostAction = (typeof HOST_COMMANDS)[number];
export interface HostCommand {
  command: HostAction;
  runEpoch: number;
  connectionEpoch: number;
  membershipEpoch: number;
}
export interface RoomControlState {
  roomMode: RoomMode;
  runEpoch: number;
  membershipEpoch: number;
  hostSlot: number | null;
  members: Array<{ slot: number; generation: number; connected: boolean; joinedOrdinal: number }>;
}
const counter = (value: number) => integer(value, 1, COUNTER_LIMIT - 1, "room control epoch");
function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(" ") !== names.split(" ").sort().join(" ")
  )
    throw new Error("Invalid room control fields");
}
export function decodeHostCommand(raw: string): HostCommand {
  if (new TextEncoder().encode(raw).byteLength > 512) throw new Error("Room command size");
  const value = JSON.parse(raw) as HostCommand;
  fields(value, "command runEpoch connectionEpoch membershipEpoch");
  if (!HOST_COMMANDS.includes(value.command)) throw new Error("Unknown host command");
  counter(value.runEpoch);
  counter(value.connectionEpoch);
  counter(value.membershipEpoch);
  return value;
}
/** Body size and completion time are bounded before the command can reach the room. */
async function readBody(request: Request | Response, limit: number): Promise<string> {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d{1,4}$/u.test(length) || Number(length) > limit))
    throw new Error("Room command size");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Missing room command");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      (async () => {
        let size = 0,
          text = "";
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) return text + decoder.decode();
          size += chunk.value.byteLength;
          if (size > limit) throw new Error("Room command size");
          text += decoder.decode(chunk.value, { stream: true });
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Room command timeout")), 2000);
      }),
    ]);
    return raw;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function readHostCommand(request: Request): Promise<HostCommand> {
  return decodeHostCommand(await readBody(request, 512));
}
export async function readRoomControlState(response: Response): Promise<RoomControlState> {
  if (!response.ok) throw new Error(`Room state unavailable: ${response.status}`);
  return decodeRoomControlState(await readBody(response, 2048));
}
/** Socket generation, membership epoch and run epoch independently fence delayed host intent. */
export function requireCurrentHost(
  membership: RoomMembership,
  profileId: string,
  runEpoch: number,
  connectionEpoch: number,
  command: HostCommand,
): void {
  const member = membership.members.find((m) => m.profileId === profileId);
  if (!member?.connected || member.slot !== membership.hostSlot) throw new Error("host-required");
  if (
    membership.epoch !== command.membershipEpoch ||
    runEpoch !== command.runEpoch ||
    connectionEpoch !== command.connectionEpoch
  )
    throw new Error("stale-host-command");
}
export function roomControlState(
  membership: RoomMembership,
  roomMode: RoomMode,
  runEpoch: number,
): RoomControlState {
  return {
    roomMode,
    runEpoch,
    membershipEpoch: membership.epoch,
    hostSlot: membership.hostSlot,
    members: membership.members.map(({ slot, generation, connected, joinedOrdinal }) => ({
      slot,
      generation,
      connected,
      joinedOrdinal,
    })),
  };
}
export function decodeRoomControlState(raw: string): RoomControlState {
  if (new TextEncoder().encode(raw).byteLength > 2048) throw new Error("Room state size");
  const state = JSON.parse(raw) as RoomControlState;
  fields(state, "roomMode runEpoch membershipEpoch hostSlot members");
  if (
    !ROOM_MODES.includes(state.roomMode) ||
    !Array.isArray(state.members) ||
    state.members.length > 4
  )
    throw new Error("Invalid room control state");
  counter(state.runEpoch);
  counter(state.membershipEpoch);
  const ordinals = new Set<number>();
  let slot = -1;
  for (const member of state.members) {
    fields(member, "slot generation connected joinedOrdinal");
    integer(member.slot, slot + 1, 3, "room member slot");
    slot = member.slot;
    counter(member.generation);
    counter(member.joinedOrdinal);
    if (typeof member.connected !== "boolean" || ordinals.has(member.joinedOrdinal))
      throw new Error("Invalid room member");
    ordinals.add(member.joinedOrdinal);
  }
  if (
    state.hostSlot === null
      ? state.members.some((m) => m.connected)
      : !state.members.some((m) => m.slot === state.hostSlot && m.connected)
  )
    throw new Error("Invalid room host");
  return state;
}

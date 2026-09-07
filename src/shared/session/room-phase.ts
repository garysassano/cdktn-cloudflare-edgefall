import { ROOM_MODES } from "../protocol/snapshot-schema.js";

export type RoomMode = (typeof ROOM_MODES)[number];
export type PausableRoomMode = "lobby" | "loading" | "playing" | "intermission";
export function isPausableRoom(mode: RoomMode): mode is PausableRoomMode {
  return ["lobby", "loading", "playing", "intermission"].includes(mode);
}
export function isWaitingRoom(mode: RoomMode): boolean {
  return ["lobby", "loading", "intermission", "completed"].includes(mode);
}
/** New members enter only at a party boundary; completed members may reconnect to results. */
export function requireAdmissionPhase(mode: RoomMode, existing: boolean): void {
  if (!ROOM_MODES.includes(mode)) throw new Error("protocol-error");
  if (mode === "recovering") throw new Error("outage");
  if (mode === "expired" || (mode === "completed" && !existing)) throw new Error("room-ended");
  if (!existing && mode !== "lobby" && mode !== "intermission") throw new Error("in-progress");
}

import type { GameIdentity } from "../content-id.js";
import { type ConnectionReason, RoomConnectError } from "./connection.js";

const failures = new Set<ConnectionReason>([
  "outage",
  "reservation-expired",
  "room-full",
  "in-progress",
  "incompatible-build",
  "profile-required",
  "room-ended",
]);
/** Bound the entire preflight response before parsing; failed admission cannot create a session. */
export async function requireRoomAdmission(
  response: Response,
  expected: GameIdentity,
): Promise<void> {
  if (response.status >= 500) {
    await response.body?.cancel();
    throw new RoomConnectError("outage");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RoomConnectError("protocol-error");
  let bytes = 0,
    text = "";
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 2048) throw new RoomConnectError("protocol-error");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    const admission = JSON.parse(text) as {
      code?: string;
      roomMode?: string;
      protocolMajor?: number;
      protocolMinor?: number;
      identity?: GameIdentity;
    };
    if (!admission || typeof admission !== "object" || Array.isArray(admission))
      throw new RoomConnectError("protocol-error");
    if (!response.ok)
      throw new RoomConnectError(
        failures.has(admission.code as ConnectionReason)
          ? (admission.code as ConnectionReason)
          : "protocol-error",
      );
    if (
      admission.code !== "ready" ||
      !["lobby", "loading", "playing", "intermission", "paused-empty", "completed"].includes(
        admission.roomMode ?? "",
      )
    )
      throw new RoomConnectError("protocol-error");
    if (
      admission.protocolMajor !== 3 ||
      admission.protocolMinor !== 1 ||
      !admission.identity ||
      Object.entries(expected).some(
        ([key, value]) => admission.identity?.[key as keyof GameIdentity] !== value,
      )
    )
      throw new RoomConnectError("incompatible-build");
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof RoomConnectError) throw error;
    throw new RoomConnectError("protocol-error");
  } finally {
    reader.releaseLock();
  }
}

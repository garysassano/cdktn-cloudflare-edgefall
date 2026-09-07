import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { HostAction, HostCommand } from "../../src/shared/session/room-control.js";

/** Submit through the actual host browser's signed cookie and observed connection generation. */
export async function roomHostCommand(
  base: string,
  pages: Page[],
  command: HostAction,
  observed?: HostCommand,
  actorSlot?: number,
): Promise<{ status: number }> {
  const response = await fetch(`${base}/combat/status`);
  assert(response.ok);
  const state = (await response.json()) as RoomProbeStatus;
  const slot = actorSlot ?? state.membership?.hostSlot;
  assert(slot !== null && slot !== undefined, "No connected host");
  const page = pages[slot];
  assert(page, "Missing host browser");
  return page.evaluate(
    ({ command, observed }) =>
      (
        globalThis as unknown as {
          controllerNetworkLab: {
            hostCommand(command: HostAction, observed?: HostCommand): Promise<{ status: number }>;
          };
        }
      ).controllerNetworkLab.hostCommand(command, observed),
    { command, observed },
  );
}
export async function loadRoomIfNeeded(base: string, pages: Page[]): Promise<void> {
  const state = (await (await fetch(`${base}/combat/status`)).json()) as RoomProbeStatus;
  if (state.roomMode !== "lobby" && state.roomMode !== "intermission") return;
  assert.equal((await roomHostCommand(base, pages, "load")).status, 200);
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(
        () =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): { roomMode: string } } }
          ).controllerNetworkLab.status().roomMode === "loading",
      ),
    ),
  );
}

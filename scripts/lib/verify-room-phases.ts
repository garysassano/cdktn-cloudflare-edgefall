import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { HostCommand } from "../../src/shared/session/room-control.js";
import { roomHostCommand } from "./room-host-control.js";

interface PhaseClient {
  documentId: string;
  ready: boolean;
  roomMode: string;
  error: string | null;
  runEpoch: number;
  connectionEpoch: number;
  sequence: number;
}
const read = (page: Page) =>
  page.evaluate(() =>
    (
      globalThis as unknown as { controllerNetworkLab: { status(): PhaseClient } }
    ).controllerNetworkLab.status(),
  );
const transport = (page: Page, connect: boolean) =>
  page.evaluate((connect) => {
    const lab = (
      globalThis as unknown as {
        controllerNetworkLab: {
          pauseConnection(): void;
          resumeConnection(): void;
        };
      }
    ).controllerNetworkLab;
    if (connect) lab.resumeConnection();
    else lab.pauseConnection();
  }, connect);
async function ready(page: Page) {
  await page.waitForFunction(() => {
    const state = (
      globalThis as unknown as { controllerNetworkLab?: { status(): PhaseClient } }
    ).controllerNetworkLab?.status();
    return state?.ready || state?.error;
  });
  const state = await read(page);
  assert(state.ready && !state.error, JSON.stringify(state));
  return state;
}
/** Host controls use the browser's cookie; no test-only authority header bypasses the gateway. */
export async function verifyRoomPhases(
  pages: Page[],
  base: string,
  restart: () => Promise<string>,
) {
  const status = async () =>
    (await (await fetch(`${base}/combat/status`)).json()) as RoomProbeStatus;
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const state = await status();
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Room phase boundary timed out");
  };
  const before = await until(
    (state) =>
      state.peers.length === 4 &&
      state.inputStreams.every((input) => input.initialBaseline === null),
  );
  assert.equal(before.roomMode, "lobby");
  assert.equal(before.tick, 0);
  assert(!before.clock.timerPending && !before.watchdogPending);
  const host = before.membership?.hostSlot;
  assert(host !== null && host !== undefined);
  const hostPage = pages[host];
  assert(hostPage);
  const initial = await read(hostPage);
  const command: HostCommand = {
    command: "load",
    runEpoch: initial.runEpoch,
    connectionEpoch: initial.connectionEpoch,
    membershipEpoch: before.membership?.epoch ?? 0,
  };
  const unsigned = await fetch(`${base}/combat/control`, {
    method: "POST",
    headers: { "X-Edgefall-Profile": "forged-owner" },
    body: JSON.stringify(command),
  });
  assert.equal(unsigned.status, 401);
  const bypass = await fetch(`${base}/combat/start`, { method: "POST" });
  assert.equal(bypass.status, 401);
  const denials: Array<{ command: string; reason: string; status: number }> = [];
  for (const action of ["load", "start", "continue", "rematch"] as const) {
    const denied = await roomHostCommand(base, pages, action, undefined, (host + 1) % 4);
    assert.equal(denied.status, 403);
    denials.push({ command: action, reason: "not-host", status: denied.status });
  }
  for (const field of ["membershipEpoch", "connectionEpoch", "runEpoch"] as const) {
    const stale = { ...command, [field]: command[field] + 1 };
    const denied = await roomHostCommand(base, pages, "load", stale);
    assert.equal(denied.status, 409);
    denials.push({ command: "load", reason: field, status: denied.status });
  }
  for (const action of ["continue", "rematch"] as const) {
    const denied = await roomHostCommand(base, pages, action);
    assert.equal(denied.status, 409, "Unimplemented campaign commands must not reset the lab");
    denials.push({ command: action, reason: "campaign-unavailable", status: denied.status });
  }
  const afterDenials = await status();
  assert.deepEqual(afterDenials.combat, before.combat);
  assert.deepEqual(afterDenials.membership, before.membership);
  assert.equal(afterDenials.roomMode, "lobby");
  const replacement = await hostPage.context().newPage();
  await replacement.goto(`${hostPage.url()}&scripted=1`);
  const replaced = await ready(replacement);
  assert.equal(replaced.connectionEpoch, initial.connectionEpoch + 1);
  const obsolete = await roomHostCommand(base, pages, "load", command, host);
  assert.equal(obsolete.status, 409, "The retired host socket's command must be fenced");
  pages[host] = replacement;
  await hostPage.close();
  await transport(replacement, false);
  const left = await until((state) => state.membership?.hostSlot !== host);
  const successor = left.membership?.hostSlot;
  assert(successor !== null && successor !== undefined);
  await transport(replacement, true);
  const returned = await ready(replacement);
  assert.equal(returned.documentId, replaced.documentId);
  assert.equal((await status()).membership?.hostSlot, successor);
  const oldHost = await roomHostCommand(base, pages, "load", undefined, host);
  assert.equal(oldHost.status, 403, "Returning member must not reclaim host commands");
  const beforePause = await status();
  const documents = await Promise.all(pages.map(read));
  await Promise.all(pages.map((page) => transport(page, false)));
  const paused = await until(
    (state) => state.roomMode === "paused-empty" && state.emptyPause !== null,
  );
  assert.equal(paused.pausedFrom, "lobby");
  assert.equal(paused.tick, 0);
  assert(!paused.clock.timerPending);
  const originalBase = base;
  base = await restart();
  assert.equal(base, originalBase);
  const cold = await status();
  assert.notEqual(cold.instanceId, paused.instanceId);
  assert.equal(cold.roomMode, "paused-empty");
  assert.equal(cold.pausedFrom, "lobby");
  assert.deepEqual(cold.emptyPause, paused.emptyPause);
  assert.equal(cold.alarmAtMs, paused.alarmAtMs);
  const first = pages[successor];
  assert(first);
  await transport(first, true);
  await ready(first);
  await Promise.all(
    pages
      .filter((_, slot) => slot !== successor)
      .map(async (page) => {
        await transport(page, true);
        await ready(page);
      }),
  );
  const restored = await status();
  const clients = await Promise.all(pages.map(read));
  assert.equal(restored.roomMode, "lobby");
  assert.equal(restored.pausedFrom, null);
  assert.equal(restored.runEpoch, beforePause.runEpoch + 1);
  assert.equal(restored.tick, 0);
  assert.equal(restored.alarmAtMs, null);
  for (const [slot, client] of clients.entries()) {
    assert.equal(client.documentId, documents[slot]?.documentId);
    assert.equal(client.roomMode, "lobby");
    assert.equal(client.sequence, 0);
    assert.equal(client.runEpoch, restored.runEpoch);
  }
  return {
    before,
    denials,
    afterDenials,
    initial,
    replaced,
    obsolete,
    returned,
    oldHost,
    beforePause,
    paused,
    cold,
    restored,
    clients,
    unsignedStatus: unsigned.status,
    bypassStatus: bypass.status,
  };
}

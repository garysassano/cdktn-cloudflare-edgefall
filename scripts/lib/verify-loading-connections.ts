import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { CONTROLLER_INPUT_PREFILL_TICKS } from "../../src/shared/diagnostics/controller-workload.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import type { ConnectionStatus } from "../../src/shared/session/connection.js";
import { roomHostCommand } from "./room-host-control.js";

interface WaitingClient {
  documentId: string;
  ready: boolean;
  error: string | null;
  sequence: number;
  runEpoch: number;
  connectionEpoch: number;
  initialServerTick: number;
  initialActor: FullSnapshot["players"][number] | null;
  connection: ConnectionStatus;
  receipts: Array<{ ack: number }>;
}
const read = (page: Page) =>
  page.evaluate(() =>
    (
      globalThis as unknown as { controllerNetworkLab: { status(): WaitingClient } }
    ).controllerNetworkLab.status(),
  );
async function ready(page: Page) {
  await page.waitForFunction(() => {
    const state = (
      globalThis as unknown as { controllerNetworkLab?: { status(): WaitingClient } }
    ).controllerNetworkLab?.status();
    return state?.ready || state?.error;
  });
  const state = await read(page);
  assert(!state.error && state.ready, JSON.stringify(state));
  return state;
}

/** Real loading takeover and same-document reentry, followed by the caller's playing regression. */
export async function verifyLoadingConnections(pages: Page[], base: string) {
  const status = async () => {
    const response = await fetch(`${base}/combat/status`);
    assert(response.ok);
    return (await response.json()) as RoomProbeStatus;
  };
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await status();
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Loading connection boundary timed out");
  };
  const initial = await Promise.all(pages.map(ready));
  const before = await status();
  assert.equal(before.roomMode, "loading");
  assert.equal(before.tick, 0);
  assert(!before.clock.timerPending);
  const slot = before.membership?.hostSlot;
  assert(slot !== undefined && slot !== null);
  const stream = (state: RoomProbeStatus, selected = slot) =>
    state.inputStreams.find((input) => input.acknowledgment.playerId === selected + 1);
  const otherStreams = (state: RoomProbeStatus) =>
    state.inputStreams.filter((input) => input.acknowledgment.playerId !== slot + 1);
  const successor = before.membership?.members
    .filter((member) => member.slot !== slot)
    .sort((a, b) => a.joinedOrdinal - b.joinedOrdinal)[0]?.slot;
  assert(successor !== undefined);
  const owner = pages[slot];
  assert(owner);
  await owner.locator("#prepare").click();
  const queued = await until((state) => stream(state)?.queued === CONTROLLER_INPUT_PREFILL_TICKS);
  const wrongSlot = await owner
    .context()
    .request.get(`${base}/combat/admission?slot=${(slot + 1) % 4}`);
  assert.equal(wrongSlot.status(), 409);
  assert.equal((await wrongSlot.json()).code, "profile-required");
  const replacement = await owner.context().newPage();
  await replacement.goto(`${owner.url()}&scripted=1`);
  const installed = await ready(replacement);
  pages[slot] = replacement;
  await owner.waitForFunction(
    () =>
      (
        globalThis as unknown as { controllerNetworkLab: { status(): WaitingClient } }
      ).controllerNetworkLab.status().connection.reason === "replaced",
  );
  const retired = await read(owner);
  const afterTakeover = await status();
  assert.equal(installed.runEpoch, initial[slot]?.runEpoch);
  assert.equal(installed.connectionEpoch, (initial[slot]?.connectionEpoch ?? 0) + 1);
  assert.equal(installed.initialServerTick, 0);
  assert.equal(installed.sequence, 0);
  assert.equal(installed.receipts[0]?.ack, 0);
  assert.deepEqual(installed.initialActor, initial[slot]?.initialActor);
  assert.deepEqual(afterTakeover.combat, before.combat);
  assert.equal(stream(afterTakeover)?.queued, 0);
  assert.equal(afterTakeover.membership?.hostSlot, before.membership?.hostSlot);
  for (let other = 0; other < 4; other++) {
    if (other === slot) continue;
    assert.deepEqual(stream(afterTakeover, other), stream(queued, other));
    assert.equal(afterTakeover.peers.find((peer) => peer.slot === other)?.active, true);
  }
  await owner.close();
  // Only the replacement is missing its acknowledged baseline and fresh preload.
  await Promise.all(
    pages.filter((_, index) => index !== slot).map((page) => page.locator("#prepare").click()),
  );
  await until((state) =>
    otherStreams(state).every((s) => s.queued === CONTROLLER_INPUT_PREFILL_TICKS),
  );
  const unreadyStart = await roomHostCommand(base, pages, "start");
  assert.equal(unreadyStart.status, 409);
  await replacement.locator("#prepare").click();
  await until((state) =>
    state.inputStreams.every((s) => s.queued === CONTROLLER_INPUT_PREFILL_TICKS),
  );
  await replacement.evaluate(() => {
    (
      globalThis as unknown as { controllerNetworkLab: { pauseConnection(): void } }
    ).controllerNetworkLab.pauseConnection();
  });
  const disconnected = await until(
    (state) =>
      !state.membership?.members.find((member) => member.slot === slot)?.connected &&
      !state.peers.find((peer) => peer.slot === slot)?.active,
  );
  assert.equal(disconnected.roomMode, "loading");
  assert.equal(disconnected.tick, 0);
  assert.equal(disconnected.membership?.hostSlot, successor);
  await replacement.evaluate(() => {
    (
      globalThis as unknown as { controllerNetworkLab: { resumeConnection(): void } }
    ).controllerNetworkLab.resumeConnection();
  });
  const returned = await ready(replacement);
  const afterReturn = await status();
  assert.equal(returned.documentId, installed.documentId);
  assert.equal(returned.connectionEpoch, installed.connectionEpoch + 1);
  assert.equal(returned.runEpoch, installed.runEpoch);
  assert.equal(returned.initialServerTick, 0);
  assert.equal(returned.sequence, 0);
  assert.equal(returned.receipts[0]?.ack, 0);
  assert.deepEqual(returned.initialActor, installed.initialActor);
  assert.deepEqual(afterReturn.combat, before.combat);
  assert.equal(afterReturn.tick, 0);
  assert.equal(afterReturn.clock.tick, 0);
  assert(!afterReturn.clock.timerPending && !afterReturn.watchdogPending);
  assert.equal(stream(afterReturn)?.queued, 0);
  assert.equal(
    afterReturn.membership?.hostSlot,
    successor,
    "Returning host must not reclaim authority",
  );
  assert.equal(
    afterReturn.membership?.members.find((member) => member.slot === slot)?.generation,
    (before.membership?.members.find((member) => member.slot === slot)?.generation ?? 0) + 2,
  );
  assert(afterReturn.staleSocketEvents > 0, "Delayed old socket close was not observed");
  for (let other = 0; other < 4; other++) {
    if (other === slot) continue;
    const page = pages[other];
    assert(page);
    const healthy = await read(page);
    assert.equal(healthy.documentId, initial[other]?.documentId);
    assert.equal(healthy.connectionEpoch, initial[other]?.connectionEpoch);
    assert.equal(stream(afterReturn, other)?.queued, CONTROLLER_INPUT_PREFILL_TICKS);
  }
  return {
    slot,
    successor,
    initial,
    before,
    queued,
    installed,
    retired,
    afterTakeover,
    disconnected,
    returned,
    afterReturn,
    wrongSlotStatus: wrongSlot.status(),
    unreadyStartStatus: unreadyStart.status,
  };
}

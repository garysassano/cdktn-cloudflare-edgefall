import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import type { HostCommand } from "../../src/shared/session/room-control.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface CampaignClient {
  documentId: string;
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  prepared: boolean;
  roomMode: string;
  runEpoch: number;
  connectionEpoch: number;
  snapshotTick: number;
  inputClock: { mode: string } | null;
  authoritative: FullSnapshot["players"][number];
  campaign: FullSnapshot["campaign"];
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
}
const read = (page: Page) =>
  page.evaluate(() =>
    (
      globalThis as unknown as { controllerNetworkLab: { status(): CampaignClient } }
    ).controllerNetworkLab.status(),
  );

/** Real keyboard falls, a held final write and same-document continue recovery over four sockets. */
export async function verifyCombatCampaign(pages: Page[], base: string) {
  const status = async () =>
    (await (await fetch(`${base}/combat/status`)).json()) as RoomProbeStatus;
  const until = async (accept: (state: RoomProbeStatus) => boolean, timeout = 20_000) => {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      const state = await status();
      assert(
        !state.persistenceFailure && !state.clock.fault,
        "Room failed before campaign boundary",
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Campaign boundary timed out");
  };
  const clientsUntil = async (accept: (clients: CampaignClient[]) => boolean) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      const clients = await Promise.all(pages.map(read));
      assert(
        clients.every((client) => !client.error),
        JSON.stringify(
          clients.map(({ error, roomMode, runEpoch }) => ({ error, roomMode, runEpoch })),
        ),
      );
      if (accept(clients)) return clients;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error("Campaign browser boundary timed out");
  };
  const keyboard = async (down: boolean) =>
    Promise.all(
      pages.map(async (page) => {
        await page.locator("#game").focus();
        for (const key of ["ArrowRight", "KeyZ"]) {
          if (down) await page.keyboard.down(key);
          else await page.keyboard.up(key);
        }
      }),
    );
  const start = async () => {
    await loadRoomIfNeeded(base, pages);
    await Promise.all(
      pages.map(async (page) => {
        await page.locator("#scripted").uncheck();
        if (!(await read(page)).prepared) await page.locator("#prepare").click();
      }),
    );
    await keyboard(true);
    await until(
      (state) =>
        state.inputStreams.length === 4 &&
        state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
    );
    assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  };
  const initial = await Promise.all(pages.map(read));
  await start();
  // Hold the segment containing the last death presentation, within the unchanged 30-tick backlog cap.
  const dying = await until((state) => {
    assert.equal(state.runEpoch, initial[0]?.runEpoch, "Unexpected recovery before the party wipe");
    const players = state.combat?.world.players;
    const deaths = players?.filter((player) => player.life === "death") ?? [];
    assert.notEqual(state.roomMode, "intermission", "Verifier missed the final death write hold");
    return (
      !!players?.every((player) => player.lives === 0) &&
      deaths.length > 0 &&
      state.tick >= Math.max(...deaths.map((player) => player.lifeStartTick)) + 19
    );
  });
  assert.equal((await fetch(`${base}/combat/hold-next-write`, { method: "POST" })).status, 200);
  const held = await until((state) => state.roomMode === "intermission" && state.persistenceHeld);
  assert.equal(held.combat?.campaign.state.phase, "wipe");
  assert(!held.clock.timerPending && !held.watchdogPending);
  const pausedClients = await clientsUntil((clients) =>
    clients.every(
      (client) => client.roomMode === "intermission" && client.inputClock?.mode === "stopped",
    ),
  );
  assert(
    pausedClients.every(
      (client) =>
        !client.requiresResync &&
        client.authoritative.life === "spectating" &&
        client.authoritative.lives === 0,
    ),
  );
  await keyboard(false);
  const pending = await roomHostCommand(base, pages, "continue");
  assert.equal(pending.status, 409, "Continue passed an unconfirmed final write");
  assert.equal((await status()).combat?.campaign.state.continuesUsed, 0);
  assert.equal((await fetch(`${base}/combat/release-write`, { method: "POST" })).status, 200);
  const confirmed = await until((state) => state.durability === null && !state.persistenceHeld);
  assert.equal(confirmed.tick, held.tick);
  assert.equal(confirmed.persistenceCommits.at(-1)?.throughTick, held.tick);
  const host = confirmed.membership?.hostSlot;
  assert(host !== null && host !== undefined);
  const observed: HostCommand = {
    command: "continue",
    runEpoch: confirmed.runEpoch,
    connectionEpoch: pausedClients[host]?.connectionEpoch ?? 0,
    membershipEpoch: confirmed.membership?.epoch ?? 0,
  };
  const unsigned = await fetch(`${base}/combat/control`, {
    method: "POST",
    body: JSON.stringify(observed),
  });
  assert.equal(unsigned.status, 401);
  const nonhost = await roomHostCommand(base, pages, "continue", undefined, (host + 1) % 4);
  assert.equal(nonhost.status, 403);
  const bypass = await roomHostCommand(base, pages, "load");
  assert.equal(bypass.status, 409);
  const browser = pages[0]?.context().browser();
  assert(browser);
  const stranger = await browser.newContext();
  let admission: { status: number; code: string };
  try {
    assert((await stranger.request.post(`${base}/profile`)).ok());
    const response = await stranger.request.get(`${base}/combat/admission?slot=0`);
    admission = { status: response.status(), code: (await response.json()).code };
    assert.equal(admission.status, 409);
    assert.equal(admission.code, "in-progress");
  } finally {
    await stranger.close();
  }
  assert.equal((await roomHostCommand(base, pages, "continue")).status, 200);
  const returned = await clientsUntil((clients) =>
    clients.every(
      (client) =>
        client.ready && client.roomMode === "loading" && client.runEpoch === confirmed.runEpoch + 1,
    ),
  );
  const reset = await until(
    (state) =>
      state.peers.length === 4 &&
      state.inputStreams.every((input) => input.initialBaseline === null),
  );
  assert.equal(reset.tick, confirmed.tick);
  assert.equal(reset.combat?.campaign.continues.length, 1);
  assert.deepEqual(
    reset.combat?.world.targets.map((target) => target.enemy.body.id),
    [confirmed.combat?.world.nextEntityId, (confirmed.combat?.world.nextEntityId ?? NaN) + 1],
  );
  for (const [slot, client] of returned.entries()) {
    assert.equal(
      client.documentId,
      initial[slot]?.documentId,
      "Continue reloaded a browser document",
    );
    assert.equal(client.snapshotTick, confirmed.tick);
    assert.equal(client.connectionEpoch, (pausedClients[slot]?.connectionEpoch ?? NaN) + 1);
    assert.equal(client.authoritative.lives, 3);
    assert.equal(client.authoritative.invulnerableTicks, 120);
    assert.equal(client.authoritative.weapon.id, "sidearm");
    assert.equal(client.campaign.continuesUsed, 1);
  }
  assert(
    reset.inputStreams.every(
      (input) => input.queued === 0 && input.acknowledgment.lastProcessedSequence === 0,
    ),
  );
  const obsoleteOwner = await roomHostCommand(base, pages, "continue", observed, host);
  assert.equal(obsoleteOwner.status, reset.membership?.hostSlot === host ? 409 : 403);
  const obsolete = await roomHostCommand(base, pages, "continue", observed);
  assert.equal(obsolete.status, 409);
  assert.equal((await status()).combat?.campaign.continues.length, 1);
  await start();
  const clients = await clientsUntil((clients) =>
    clients.every((client) => client.snapshotTick >= confirmed.tick + 45),
  );
  await keyboard(false);
  const resumed = await status();
  assert(
    clients.every(
      (client, slot) =>
        !client.requiresResync &&
        client.authoritative.life === "alive" &&
        client.authoritative.weapon.shotOrdinal >
          (returned[slot]?.authoritative.weapon.shotOrdinal ?? Infinity),
    ),
  );
  assert(resumed.combat?.world.encounter.members.every((member) => member.status !== "pending"));
  assert.equal(resumed.combat?.campaign.state.continuesUsed, 1);
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > confirmed.tick &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 3, "Missing common continued snapshots");
  return {
    initial,
    dying,
    held,
    pausedClients,
    confirmed,
    reset,
    returned,
    resumed,
    clients,
    common,
    denials: {
      pending: pending.status,
      unsigned: unsigned.status,
      nonhost: nonhost.status,
      load: bypass.status,
      stale: obsolete.status,
      previousHost: obsoleteOwner.status,
      admission,
    },
  };
}

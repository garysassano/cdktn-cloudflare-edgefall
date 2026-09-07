import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface OrdnanceClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  authoritative: FullSnapshot["players"][number];
  platforms: FullSnapshot["platforms"];
  receipts: Array<{
    tick: number;
    hash: number;
    continuationHash: string | null;
    platforms: FullSnapshot["platforms"];
  }>;
  events: {
    duplicates: number;
    receipts: Array<{ cursor: number; tick: number; kind: string; hash: string }>;
  };
}

/** Real keyboard throws on a moving lift; snapshots/events must agree through the closing press. */
export async function verifyOrdnanceCombat(pages: Page[], base: string, output: string) {
  const read = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): OrdnanceClient } }
          ).controllerNetworkLab.status(),
        ),
      ),
    );
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline) {
      const state = (await (await fetch(`${base}/combat/status`)).json()) as RoomProbeStatus;
      assert(
        !state.persistenceFailure && !state.clock.fault && !state.worldFailure,
        "Ordnance room failed",
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Ordnance boundary timed out");
  };
  await loadRoomIfNeeded(base, pages);
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#scripted").uncheck();
      await page.locator("#prepare").click();
    }),
  );
  await pages[1]?.evaluate(() =>
    (
      globalThis as unknown as {
        controllerNetworkLab: { configureEvents(value: { duplicate: boolean }): void };
      }
    ).controllerNetworkLab.configureEvents({ duplicate: true }),
  );
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#game").focus();
      await page.keyboard.down("KeyC");
    }),
  );
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const released = await until((state) => state.combat?.world.grenades.length === 4);
  await Promise.all(pages.map((page) => page.keyboard.up("KeyC")));
  assert(released.combat?.world.grenades.every((grenade) => grenade.body.vx === 896));
  const lift = await until((state) => state.tick >= 25);
  await pages[0]?.screenshot({ path: `${output}/ordnance-lift.png` });
  const press = await until((state) => state.tick >= 78);
  await pages[0]?.screenshot({ path: `${output}/ordnance-press.png` });
  const crushed = await until(
    (state) => state.tick >= 83 && state.combat?.world.grenades.length === 0,
  );
  const events = crushed.combat?.events ?? [];
  assert.equal(events.filter(({ event }) => event.kind === "throw").length, 4);
  assert.equal(
    events.filter(
      ({ event }) =>
        event.kind === "impact" && event.definitionId === 5 && event.material === "terrain",
    ).length,
    4,
  );
  assert.equal(events.filter(({ event }) => event.kind === "explosion").length, 0);
  assert(crushed.combat?.world.targets.every((target) => target.health === 1));
  assert(
    crushed.combat?.world.players.every(
      (player) => player.grenadeStock === 9 && player.lives === 3,
    ),
  );
  const final = await until((state) => state.tick >= crushed.tick + 45),
    clients = await read();
  assert(
    clients.every(
      (client) =>
        client.ready && !client.error && !client.requiresResync && client.platforms.length === 2,
    ),
  );
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > crushed.tick &&
        clients.every((client) =>
          client.receipts.some(
            (candidate) =>
              candidate.tick === receipt.tick &&
              candidate.hash === receipt.hash &&
              candidate.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Fewer than ten common snapshots after crush");
  for (const client of clients) {
    assert.equal(client.events.receipts.filter((event) => event.kind === "impact").length, 4);
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
  }
  const commonEvents =
    clients[0]?.events.receipts.filter((event) =>
      clients.every((client) =>
        client.events.receipts.some(
          (candidate) => candidate.cursor === event.cursor && candidate.hash === event.hash,
        ),
      ),
    ) ?? [];
  assert.equal(commonEvents.length, 12);
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  await pages[0]?.screenshot({ path: `${output}/ordnance-crushed.png` });
  return { released, lift, press, crushed, final, clients, common, commonEvents };
}

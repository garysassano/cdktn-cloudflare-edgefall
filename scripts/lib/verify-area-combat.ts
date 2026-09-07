import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { AreaExposure } from "../../src/game/combat/area-attack.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface AreaClient {
  snapshotTick: number;
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  volumes: AreaExposure[];
  receipts: { tick: number; hash: number; continuationHash: string | null; volumes: number }[];
  events: {
    duplicates: number;
    receipts: { cursor: number; tick: number; kind: string; hash: string }[];
  };
}
export async function verifyAreaCombat(
  pages: Page[],
  base: string,
  output: string,
  mode: "shotgun" | "flame",
) {
  const read = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): AreaClient } }
          ).controllerNetworkLab.status(),
        ),
      ),
    );
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      const state = (await (await fetch(`${base}/combat/status`)).json()) as RoomProbeStatus;
      assert(
        !state.persistenceFailure && !state.clock.fault && !state.worldFailure,
        "Area combat room failed",
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Area combat boundary timed out");
  };
  const key = (code: string, down: boolean) =>
    Promise.all(
      pages.map(async (page) => {
        await page.locator("#game").focus();
        if (down) await page.keyboard.down(code);
        else await page.keyboard.up(code);
      }),
    );
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
  await key("ArrowDown", true);
  await key("KeyZ", true);
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const released = await until((state) => state.combat?.world.areas.length === 4);
  // Release before the next cadence; flame's remaining markers belong to this action.
  await key("KeyZ", false);
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() =>
        (
          globalThis as unknown as { controllerNetworkLab: { status(): AreaClient } }
        ).controllerNetworkLab
          .status()
          .receipts.some((receipt) => receipt.volumes > 0),
      ),
    ),
  );
  const presentation = await read();
  await pages[0]?.screenshot({ path: `${output}/area-active.png` });
  const finished = await until(
    (state) => state.tick >= released.tick + 35 && state.combat?.world.areas.length === 0,
  );
  const final = await until((state) => state.tick >= finished.tick + 45),
    clients = await read();
  assert(clients.every((client) => client.ready && !client.error && !client.requiresResync));
  assert(
    final.combat?.world.players.every(
      (player) =>
        player.weapon.ammo === (mode === "shotgun" ? 23 : 29) &&
        player.weapon.shotOrdinal === 1 &&
        player.lives === 3,
    ),
  );
  const shots =
    finished.combat?.events.filter(({ event }) => event.kind === "shot" && event.ownerId <= 4) ??
    [];
  assert.equal(shots.length, mode === "shotgun" ? 4 : 12);
  assert.equal(new Set(shots.map(({ event }) => event.actionInstanceId)).size, 4);
  if (mode === "shotgun") assert.equal(final.combat?.world.encounter.phase, "complete");
  else {
    assert.equal(
      finished.combat?.events.filter(({ event }) => event.kind === "shield-break").length,
      1,
    );
    assert.equal(final.combat?.world.targets[0]?.health, 0);
    assert.equal(
      final.combat?.world.targets[1]?.health,
      1,
      "Distant rifleman must remain outside flame reach",
    );
  }
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > finished.tick &&
        clients.every((client) =>
          client.receipts.some(
            (candidate) =>
              candidate.tick === receipt.tick &&
              candidate.hash === receipt.hash &&
              candidate.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared post-attack snapshots");
  const commonEvents =
    clients[0]?.events.receipts.filter((event) =>
      clients.every((client) =>
        client.events.receipts.some(
          (candidate) => candidate.cursor === event.cursor && candidate.hash === event.hash,
        ),
      ),
    ) ?? [];
  // The live rifleman may emit at the instant of collection; compare through a fixed prefix.
  const prefix = finished.combat?.eventCursor ?? 0;
  for (const client of clients) {
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
    assert(client.receipts.some((receipt) => receipt.volumes > 0));
    assert.deepEqual(
      client.events.receipts.filter((event) => event.cursor <= prefix),
      commonEvents.filter((event) => event.cursor <= prefix),
    );
  }
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  await pages[0]?.screenshot({ path: `${output}/area-finished.png` });
  return {
    mode,
    released,
    presentation,
    finished,
    final,
    clients,
    common,
    commonEvents,
    duplicateDeliverySlot: 1,
  };
}

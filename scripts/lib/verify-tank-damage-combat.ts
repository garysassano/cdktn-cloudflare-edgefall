import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { tankFeedback } from "../../src/shared/animation/tank-feedback.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";
import type { TankClient } from "./verify-tank-combat.js";

/** Actual keyboard admission and WebSocket snapshots; no injected damage or client-owned armor. */
export async function verifyTankDamageCombat(pages: Page[], base: string, output: string) {
  const read = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): TankClient } }
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
        "Tank damage room failed",
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Tank damage boundary timed out");
  };
  await loadRoomIfNeeded(base, pages);
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#scripted").uncheck();
      await page.locator("#prepare").click();
      await page.locator("#game").focus();
      await page.keyboard.down("KeyE");
    }),
  );
  await pages[1]?.evaluate(() =>
    (
      globalThis as unknown as {
        controllerNetworkLab: { configureEvents(value: { duplicate: boolean }): void };
      }
    ).controllerNetworkLab.configureEvents({ duplicate: true }),
  );
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const boarding = await until(
    (state) => state.combat?.world.tanks.every((tank) => tank.lifecycle === "boarding") === true,
  );
  await Promise.all(pages.map((page) => page.keyboard.up("KeyE")));
  const occupied = await until(
    (state) => state.combat?.world.tanks.every((tank) => tank.lifecycle === "occupied") === true,
  );
  assert(occupied.tick < 37, "Players missed the intact occupied boundary");
  const boundaries = [];
  for (const armor of [2, 1, 0]) {
    const state = await until((state) => state.combat?.world.tanks[3]?.armor === armor);
    assert(state.combat);
    const tank = state.combat.world.tanks[3];
    assert(tank);
    boundaries.push({ state, feedback: tankFeedback(tank, state.tick) });
    assert(state.combat.world.players.every((player) => player.lives === 3));
    await Promise.all(
      pages.map((page) =>
        page.waitForFunction(
          (armor) =>
            (
              globalThis as unknown as { controllerNetworkLab: { status(): TankClient } }
            ).controllerNetworkLab.status().vehicles[3]?.armor === armor,
          armor,
        ),
      ),
    );
    await pages[0]?.screenshot({ path: `${output}/armor-${armor}.png` });
  }
  const released = boundaries.at(-1)?.state;
  assert(released?.combat);
  assert.equal(released.combat.world.tanks[3]?.lifecycle, "wreck");
  assert.equal(released.combat.world.players[3]?.vehicleId, null);
  const final = await until((state) => state.tick >= released.tick + 45),
    clients = await read(),
    prefix = released.combat.eventCursor;
  assert.equal(final.combat?.world.players[3]?.lives, 2);
  assert(final.combat?.world.players.slice(0, 3).every((player) => player.lives === 3));
  assert(
    final.combat?.world.tanks
      .slice(0, 2)
      .every((tank) => tank.armor === 3 && tank.lifecycle === "occupied"),
  );
  // Once the fourth hull is a visual-only wreck, the next rifle burst can reach the third hull.
  assert.equal(final.combat?.world.tanks[2]?.armor, 2);
  assert.equal(final.combat?.world.tanks[2]?.lifecycle, "occupied");
  assert(
    final.combat?.events.some(({ event }) => event.kind === "impact" && event.targetId === 32),
  );
  assert(clients.every((client) => client.ready && !client.error && !client.requiresResync));
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > released.tick &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared post-destruction snapshots");
  const commonEvents =
    clients[0]?.events.receipts.filter(
      (event) =>
        event.cursor <= prefix &&
        clients.every((client) =>
          client.events.receipts.some(
            (other) => other.cursor === event.cursor && other.hash === event.hash,
          ),
        ),
    ) ?? [];
  for (const client of clients) {
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
    assert.deepEqual(
      client.events.receipts.filter((event) => event.cursor <= prefix),
      commonEvents,
    );
    for (const armor of [3, 2, 1, 0])
      assert(
        client.receipts.some((receipt) => receipt.vehicles[3]?.armor === armor),
        `Client missed armor stage ${armor}`,
      );
    const wreck = client.vehicles[3];
    assert(wreck);
    assert.deepEqual(tankFeedback(wreck, client.snapshotTick), {
      integrity: "wreck",
      damageAgeTicks: null,
      hitFlash: false,
      hullTint: 0xffffff,
      critical: false,
      warningBright: false,
    });
  }
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  await pages[0]?.screenshot({ path: `${output}/post-destruction.png` });
  return { boarding, occupied, boundaries, released, final, clients, common, commonEvents };
}

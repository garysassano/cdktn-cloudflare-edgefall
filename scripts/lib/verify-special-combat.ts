import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { VehicleState } from "../../src/game/state.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface TankClient {
  snapshotTick: number;
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  vehicles: VehicleState[];
  receipts: {
    tick: number;
    hash: number;
    continuationHash: string | null;
    vehicles: VehicleState[];
  }[];
  events: {
    duplicates: number;
    receipts: { cursor: number; tick: number; kind: string; hash: string }[];
  };
}
export async function verifySpecialCombat(pages: Page[], base: string, output: string) {
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
        "Tank combat room failed",
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Tank combat boundary timed out");
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
  await key("KeyE", true);
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const boarding = await until(
    (state) => state.combat?.world.tanks.every((tank) => tank.lifecycle === "boarding") === true,
  );
  await key("KeyE", false);
  const occupied = await until(
    (state) => state.combat?.world.tanks.every((tank) => tank.lifecycle === "occupied") === true,
  );
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() =>
        (
          globalThis as unknown as { controllerNetworkLab: { status(): TankClient } }
        ).controllerNetworkLab
          .status()
          .vehicles.every((tank) => tank.lifecycle === "occupied"),
      ),
    ),
  );
  await key("KeyZ", true);
  const defeated = await until((state) => state.combat?.world.encounter.phase === "complete");
  await key("KeyZ", false);
  await key("KeyV", true);
  const arming = await until(
    (s) => s.combat?.world.tanks.every((tank) => tank.special.phase === "arming") === true,
  );
  await key("KeyV", false);
  const canceled = await until(
    (s) => s.combat?.world.tanks.every((tank) => tank.special.phase === "canceled") === true,
  );
  assert(
    canceled.combat?.world.players.every(
      (player) => player.vehicleId !== null && player.vehicleSpecialTicks === 0,
    ),
  );
  await until((s) => s.tick >= canceled.tick + 4);
  await key("KeyV", true);
  const rearmed = await until(
    (s) => s.combat?.world.tanks.every((tank) => tank.special.phase === "arming") === true,
  );
  await pages[0]?.screenshot({ path: `${output}/special-arming.png` });
  const released = await until(
    (s) => s.combat?.world.players.every((player) => player.vehicleId === null) === true,
  );
  await key("KeyV", false);
  assert(
    released.combat?.world.tanks.every(
      (tank) => tank.special.commitTick === tank.special.startTick + 29 && tank.armor === 0,
    ),
  );
  const spent = await until(
    (s) => s.combat?.world.tanks.every((tank) => tank.special.phase === "spent") === true,
  );
  const final = await until((s) => s.tick >= spent.tick + 45),
    clients = await read();
  assert(
    final.combat?.world.players.every(
      (player) => player.lives === 3 && player.controlEpoch === 4 && player.vehicleId === null,
    ),
  );
  assert(final.combat?.world.tanks.every((tank) => tank.lifecycle === "wreck"));
  const blasts =
    final.combat?.events.filter(
      ({ event }) => event.kind === "explosion" && event.definitionId === 20,
    ) ?? [];
  assert(blasts.length > 0);
  assert.equal(new Set(blasts.map(({ event }) => event.actionInstanceId)).size, blasts.length);
  for (const tank of final.combat?.world.tanks ?? []) {
    const detonations = blasts.filter(
      ({ event }) => event.actionInstanceId === tank.special.actionInstanceId,
    );
    assert.equal(detonations.length, tank.body.y > 248 * 256 ? 0 : 1);
    assert(
      tank.special.endTick !== null &&
        tank.special.commitTick !== null &&
        tank.special.endTick <= tank.special.commitTick + 60,
    );
  }
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > spent.tick &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared post-sacrifice snapshots");
  const prefix = spent.combat?.eventCursor ?? 0;
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
    assert(client.ready && !client.error && !client.requiresResync);
    for (const phase of ["arming", "canceled", "charging", "spent"])
      assert(
        client.receipts.some((receipt) =>
          receipt.vehicles.some((tank) => tank.special.phase === phase),
        ),
        `Client missed ${phase}`,
      );
    assert.deepEqual(
      client.events.receipts.filter((event) => event.cursor <= prefix),
      commonEvents,
    );
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
  }
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  await pages[0]?.screenshot({ path: `${output}/special-spent.png` });
  return {
    boarding,
    occupied,
    defeated,
    arming,
    canceled,
    rearmed,
    released,
    spent,
    final,
    clients,
    common,
    commonEvents,
    blasts,
  };
}

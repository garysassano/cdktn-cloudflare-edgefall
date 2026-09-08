import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { CANNON_ATTACK } from "../../src/game/content/weapons/tank-cannon.js";
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
export async function verifyTankCombat(
  pages: Page[],
  base: string,
  output: string,
  cannonMode = false,
) {
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
  await key("ArrowUp", true);
  await key("Space", true);
  await key("Space", false);
  const jumping = await until(
    (state) =>
      state.combat?.world.tanks.every(
        (tank) => !tank.body.grounded && tank.body.y < 200 * 256 && tank.heading === 2,
      ) === true,
  );
  await pages[0]?.screenshot({ path: `${output}/tank-jump.png` });
  await key("ArrowUp", false);
  await key("ArrowRight", true);
  const driving = await until(
    (state) =>
      state.tick >= jumping.tick + 8 &&
      state.combat?.world.tanks.every((tank) => tank.heading === 0) === true,
  );
  await key("ArrowRight", false);
  const landed = await until(
    (state) => state.combat?.world.tanks.every((tank) => tank.body.grounded) === true,
  );
  const cannonBoundaries: RoomProbeStatus[] = [];
  if (cannonMode) {
    await key("KeyC", true);
    const released = await until(
      (state) =>
        (state.combat?.events.filter(
          ({ event }) => event.kind === "shot" && event.definitionId === CANNON_ATTACK.id,
        ).length ?? 0) === 4,
    );
    cannonBoundaries.push(released);
    await pages[0]?.screenshot({ path: `${output}/cannon-release.png` });
  }
  await key("KeyZ", true);
  const defeated = await until((state) => state.combat?.world.encounter.phase === "complete");
  await key("KeyZ", false);
  if (cannonMode) {
    const first = cannonBoundaries[0];
    assert(first);
    const held = await until((state) => state.tick >= first.tick + 48);
    assert(
      held.combat?.world.tanks.every(
        (tank) => tank.secondary.ammo === 9 && tank.secondary.shotsFired === 1,
      ),
    );
    assert(
      held.combat?.events.some(
        ({ event }) => event.kind === "explosion" && event.definitionId === CANNON_ATTACK.id,
      ),
      "Missing cannon contact blast",
    );
    cannonBoundaries.push(held);
    await key("KeyC", false);
    await until((state) => state.tick >= held.tick + 4);
    await key("KeyC", true);
    const second = await until(
      (state) =>
        (state.combat?.events.filter(
          ({ event }) => event.kind === "shot" && event.definitionId === CANNON_ATTACK.id,
        ).length ?? 0) === 8,
    );
    assert(
      second.combat?.world.tanks.every(
        (tank) => tank.secondary.ammo === 8 && tank.secondary.shotsFired === 2,
      ),
    );
    cannonBoundaries.push(second);
    await key("KeyC", false);
    await pages[0]?.screenshot({ path: `${output}/cannon-second-release.png` });
  }
  await pages[0]?.screenshot({ path: `${output}/tank-combat.png` });
  await until((state) => state.tick >= defeated.tick + 10);
  await key("KeyE", true);
  const exiting = await until(
    (state) => state.combat?.world.tanks.every((tank) => tank.lifecycle === "exiting") === true,
  );
  await key("KeyE", false);
  const released = await until(
    (state) => state.combat?.world.players.every((player) => player.vehicleId === null) === true,
  );
  const final = await until((state) => state.tick >= released.tick + 45),
    clients = await read();
  if (cannonMode) {
    assert(
      released.combat?.world.projectiles.some((shell) => shell.definitionId === CANNON_ATTACK.id),
      "Exit discarded released shells",
    );
    assert(
      final.combat?.world.tanks.every(
        (tank) => tank.secondary.ammo === 8 && tank.secondary.shotsFired === 2,
      ),
    );
    for (const client of clients) {
      assert(
        client.receipts.some((receipt) =>
          receipt.vehicles.some(
            (tank) =>
              tank.secondary.action.kind === "fire" && tank.secondary.action.nextMarkerIndex === 2,
          ),
        ),
        "Client missed committed cannon recoil",
      );
      assert(
        client.vehicles.every(
          (tank) => tank.secondary.ammo === 8 && tank.secondary.shotsFired === 2,
        ),
      );
    }
  }
  assert(clients.every((client) => client.ready && !client.error && !client.requiresResync));
  assert(
    final.combat?.world.players.every(
      (player) => player.lives === 3 && player.controlEpoch === 5 && player.vehicleId === null,
    ),
  );
  assert(
    final.combat?.world.tanks.every(
      (tank, slot) =>
        tank.lifecycle === "available" &&
        tank.body.x > (60 + slot * 56) * 256 &&
        tank.weapon.shotOrdinal > 0 &&
        tank.weapon.ammo === 0,
    ),
  );
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
  assert(common.length >= 10, "Missing shared post-exit snapshots");
  const prefix = released.combat?.eventCursor ?? 0;
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
    assert(
      client.receipts.some((receipt) =>
        receipt.vehicles.some((tank) => tank.heading === 2 && !tank.body.grounded),
      ),
      "Client missed the authoritative airborne turret pose",
    );
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
    assert.deepEqual(
      client.events.receipts.filter((event) => event.cursor <= prefix),
      commonEvents,
    );
  }
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  await pages[0]?.screenshot({ path: `${output}/tank-exited.png` });
  return {
    cannonBoundaries,
    boarding,
    occupied,
    jumping,
    driving,
    landed,
    defeated,
    exiting,
    released,
    final,
    clients,
    common,
    commonEvents,
  };
}

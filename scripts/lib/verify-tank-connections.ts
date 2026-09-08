import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { TANK_PROFILE } from "../../src/game/labs/combat-content.js";
import type { ControlledActor } from "../../src/game/state.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { ConnectionStatus } from "../../src/shared/session/connection.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";
import type { TankClient } from "./verify-tank-combat.js";

interface TankConnectionClient extends TankClient {
  documentId: string;
  connection: ConnectionStatus;
  runEpoch: number;
  connectionEpoch: number;
  initialActor: ControlledActor | null;
  initialServerTick: number;
  baselineEventCursor: number;
  authoritative: ControlledActor | null;
  prepared: boolean;
  sequence: number;
  held: number;
  pending: number;
}
interface ConnectionLab {
  status(): TankConnectionClient;
  pauseConnection(): void;
  resumeConnection(): void;
  configureEvents(value: { duplicate: boolean }): void;
}

/** Real profile cookies, keyboard input and sockets; the only process fault is a local restart. */
export async function verifyTankConnections(
  pages: Page[],
  base: string,
  output: string,
  restart: () => Promise<string>,
) {
  const readPage = (page: Page, includeReceipts = false) =>
    page.evaluate((includeReceipts) => {
      const state = (
        globalThis as unknown as { controllerNetworkLab: ConnectionLab }
      ).controllerNetworkLab.status();
      // Frequent polling must not serialize the entire growing lab recording on the render thread.
      return {
        documentId: state.documentId,
        connection: state.connection,
        runEpoch: state.runEpoch,
        connectionEpoch: state.connectionEpoch,
        initialActor: state.initialActor,
        initialServerTick: state.initialServerTick,
        baselineEventCursor: state.baselineEventCursor,
        authoritative: state.authoritative,
        prepared: state.prepared,
        sequence: state.sequence,
        held: state.held,
        pending: state.pending,
        snapshotTick: state.snapshotTick,
        ready: state.ready,
        error: state.error,
        requiresResync: state.requiresResync,
        vehicles: state.vehicles,
        receipts: includeReceipts
          ? state.receipts.map(({ tick, hash, continuationHash, vehicles }) => ({
              tick,
              hash,
              continuationHash,
              vehicles,
            }))
          : [],
        events: {
          duplicates: state.events?.duplicates ?? 0,
          receipts: state.events?.receipts ?? [],
        },
      };
    }, includeReceipts);
  const read = (includeReceipts = false) =>
    Promise.all(pages.map((page) => readPage(page, includeReceipts)));
  const status = async () => {
    const response = await fetch(`${base}/combat/status`);
    assert(response.ok);
    const state = (await response.json()) as RoomProbeStatus;
    assert(
      !state.persistenceFailure && !state.clock.fault && !state.worldFailure,
      "Tank connection room failed",
    );
    assert(
      state.peers.every((peer) => !peer.lastInputError && !peer.lastOutputError),
      "Tank connection peer failed",
    );
    return state;
  };
  const until = async (label: string, accept: (state: RoomProbeStatus) => boolean) => {
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      const state = await status();
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Tank connection boundary timed out: ${label}`);
  };
  const clientsUntil = async (
    label: string,
    accept: (clients: TankConnectionClient[]) => boolean,
  ) => {
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      const clients = await read();
      assert(
        clients.every((client) => !client.error),
        `Tank connection client failed: ${label}`,
      );
      await status();
      if (accept(clients)) return clients;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Tank connection clients timed out: ${label}`);
  };
  const key = (code: string, down: boolean, slots = [0, 1, 2, 3]) =>
    Promise.all(
      slots.map(async (slot) => {
        const page = pages[slot];
        assert(page);
        await page.locator("#game").focus();
        if (down) await page.keyboard.down(code);
        else await page.keyboard.up(code);
      }),
    );
  const control = (method: "pauseConnection" | "resumeConnection", slots = [0, 1, 2, 3]) =>
    Promise.all(
      slots.map(async (slot) => {
        const page = pages[slot];
        assert(page);
        await page.evaluate((method) => {
          (globalThis as unknown as { controllerNetworkLab: ConnectionLab }).controllerNetworkLab[
            method
          ]();
        }, method);
      }),
    );
  const boundaries: Array<{ name: string; state: RoomProbeStatus }> = [];
  const retain = async (name: string, state: RoomProbeStatus) => {
    boundaries.push({ name, state });
    // Keep completed boundaries even if a later browser, clock or persistence check fails.
    await writeFile(`${output}/boundaries.json`, `${JSON.stringify(boundaries, null, 2)}\n`);
    return state;
  };
  const prepare = async () => {
    const clients = await read();
    await Promise.all(
      pages.map((page, slot) =>
        clients[slot]?.prepared ? Promise.resolve() : page.locator("#prepare").click(),
      ),
    );
    await until(
      "fresh input preload",
      (state) =>
        state.inputStreams.length === 4 &&
        state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
    );
  };

  await loadRoomIfNeeded(base, pages);
  await Promise.all(pages.map((page) => page.locator("#scripted").uncheck()));
  await prepare();
  await key("KeyE", true);
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  await until(
    "boarding",
    (state) => state.combat?.world.tanks.every((tank) => tank.lifecycle === "boarding") === true,
  );
  await key("KeyE", false);
  const occupied = await retain(
    "occupied",
    await until(
      "occupied",
      (state) => state.combat?.world.tanks.every((tank) => tank.lifecycle === "occupied") === true,
    ),
  );
  await key("KeyZ", true);
  await until(
    "rifle encounter complete",
    (state) => state.combat?.world.encounter.phase === "complete",
  );
  await key("KeyZ", false);
  await key("KeyC", true);
  const armed = await until(
    "one shell spent per hull",
    (state) => state.combat?.world.tanks.every((tank) => tank.secondary.ammo === 9) === true,
  );
  await key("KeyC", false);
  const settled = await retain(
    "settled-combat",
    await until(
      "released projectiles settle",
      (state) => state.tick >= armed.tick + 15 && state.combat?.world.projectiles.length === 0,
    ),
  );
  assert(settled.combat);
  assert(settled.combat.world.players.every((player) => player.lives === 3));
  const stock = settled.combat.world.tanks.map((tank) => ({
    armor: tank.armor,
    ammo: tank.secondary.ammo,
    shotsFired: tank.secondary.shotsFired,
  }));

  // Replace a seated browser while its primary trigger remains physically held.
  await key("KeyZ", true, [0]);
  const before = await clientsUntil("seated baseline", (clients) =>
    clients.every((client) => client.ready && client.authoritative?.vehicleId !== null),
  );
  const retiredPage = pages[0];
  assert(retiredPage);
  const replacementPage = await retiredPage.context().newPage();
  await replacementPage.goto(retiredPage.url());
  pages[0] = replacementPage;
  await replacementPage.waitForFunction(() =>
    Boolean(
      (globalThis as unknown as { controllerNetworkLab?: ConnectionLab }).controllerNetworkLab,
    ),
  );
  const replaced = await clientsUntil(
    "seated takeover",
    (clients) =>
      clients[0]?.ready === true &&
      clients[0].connectionEpoch === (before[0]?.connectionEpoch ?? 0) + 1,
  );
  const takeover = await retain("takeover", await status());
  const retired = await readPage(retiredPage);
  assert.equal(retired.connection.phase, "stopped");
  assert.equal(retired.connection.reason, "replaced");
  assert.equal(retired.connection.retryAtMs, null);
  assert.equal(replaced[0]?.initialActor?.vehicleId, null);
  assert.equal(
    replaced[0]?.initialActor?.controlEpoch,
    (before[0]?.authoritative?.controlEpoch ?? 0) + 1,
  );
  assert.equal(replaced[0]?.held, 0);
  assert.equal(takeover.combat?.world.tanks[0]?.lifecycle, "available");
  assert.equal(takeover.combat?.world.tanks[0]?.occupantId, null);
  assert.notEqual(replaced[0]?.documentId, before[0]?.documentId);
  assert.equal(replaced[0]?.initialActor?.lives, before[0]?.authoritative?.lives);
  const replacement = replaced[0];
  assert(replacement);
  assert(
    replacement.events.receipts.every((event) => event.cursor > replacement.baselineEventCursor),
    "Takeover replayed historical effects",
  );
  await retiredPage.close();
  const takeoverStable = await retain(
    "takeover-stable",
    await until("retired trigger fenced", (state) => state.tick >= takeover.tick + 15),
  );
  assert(takeoverStable.staleSocketEvents > 0, "Retired socket close was not fenced");
  assert.equal(
    takeoverStable.combat?.world.tanks[0]?.weapon.shotOrdinal,
    takeover.combat?.world.tanks[0]?.weapon.shotOrdinal,
    "Retired held input still fired the released tank",
  );
  const healthy = await read();
  for (const slot of [1, 2, 3]) {
    assert.equal(healthy[slot]?.connectionEpoch, before[slot]?.connectionEpoch);
    assert((healthy[slot]?.sequence ?? 0) > (before[slot]?.sequence ?? 0));
  }

  // P2 leaves its original tank, walks to the abandoned P1 hull and claims that specific seat.
  await key("KeyE", true, [1]);
  await until("P2 exit begins", (state) => state.combat?.world.tanks[1]?.lifecycle === "exiting");
  await key("KeyE", false, [1]);
  await until("P2 exits", (state) => state.combat?.world.players[1]?.vehicleId === null);
  const abandonedX = takeover.combat?.world.tanks[0]?.body.x;
  assert(abandonedX !== undefined);
  await key("ArrowLeft", true, [1]);
  await until(
    "P2 reaches abandoned hull",
    (state) => (state.combat?.world.players[1]?.body.x ?? Infinity) <= abandonedX + 8 * 256,
  );
  await key("ArrowLeft", false, [1]);
  await until(
    "P2 reboard cooldown",
    (state) => state.combat?.world.players[1]?.reboardCooldownTicks === 0,
  );
  await key("KeyE", true, [1]);
  await until(
    "P2 claims abandoned hull",
    (state) => state.combat?.world.tanks[0]?.reservedBy === 2,
  );
  await key("KeyE", false, [1]);
  const reclaimed = await retain(
    "reclaimed-by-P2",
    await until(
      "P2 occupies abandoned hull",
      (state) => state.combat?.world.tanks[0]?.occupantId === 2,
    ),
  );
  assert.equal(reclaimed.combat?.world.tanks[1]?.lifecycle, "available");
  await key("ArrowRight", true, [1]);
  await key("KeyZ", true, [1]);
  const driving = await retain(
    "driving-before-disconnect",
    await until(
      "P2 drives abandoned hull",
      (state) => (state.combat?.world.tanks[0]?.body.x ?? 0) >= abandonedX + 9 * 256,
    ),
  );
  const beforeDisconnect = await read();
  await control("pauseConnection", [1]);
  const grace = await retain(
    "disconnect-grace",
    await until(
      "neutral occupied grace",
      (state) => (state.combat?.world.tanks[0]?.disconnectedTicks ?? 0) > 0,
    ),
  );
  const graceTank = grace.combat?.world.tanks[0];
  assert(graceTank);
  assert.equal(graceTank.lifecycle, "occupied");
  assert.equal(graceTank.occupantId, 2);
  assert(graceTank.disconnectedTicks < TANK_PROFILE.disconnectGraceTicks);
  assert.equal(graceTank.body.vx, 0, "Disconnected held movement continued");
  const released = await retain(
    "disconnect-released",
    await until(
      "disconnect seat release",
      (state) => state.combat?.world.tanks[0]?.lifecycle === "available",
    ),
  );
  assert.equal(
    (released.combat?.world.tanks[0]?.action.stateStartTick ?? 0) - grace.tick,
    TANK_PROFILE.disconnectGraceTicks - graceTank.disconnectedTicks,
  );
  assert.equal(released.combat?.world.tanks[0]?.body.x, graceTank.body.x);
  assert.equal(released.combat?.world.tanks[0]?.weapon.shotOrdinal, graceTank.weapon.shotOrdinal);
  assert.equal(released.combat?.world.players[1]?.vehicleId, null);
  assert.equal(
    released.combat?.world.players[1]?.controlEpoch,
    (driving.combat?.world.players[1]?.controlEpoch ?? 0) + 1,
  );
  await key("ArrowRight", false, [1]);
  await key("KeyZ", false, [1]);
  await control("resumeConnection", [1]);
  const resumed = await clientsUntil(
    "same-document P2 return",
    (clients) =>
      clients[1]?.ready === true &&
      clients[1].connectionEpoch === (beforeDisconnect[1]?.connectionEpoch ?? 0) + 1,
  );
  assert.equal(resumed[1]?.documentId, beforeDisconnect[1]?.documentId);
  assert.equal(resumed[1]?.initialActor?.vehicleId, null);
  assert.equal(resumed[1]?.initialActor?.lives, beforeDisconnect[1]?.authoritative?.lives);
  assert.equal(resumed[1]?.held, 0);
  for (const slot of [0, 2, 3]) {
    assert.equal(resumed[slot]?.connectionEpoch, beforeDisconnect[slot]?.connectionEpoch);
    assert((resumed[slot]?.sequence ?? 0) > (beforeDisconnect[slot]?.sequence ?? 0));
  }
  await retain("same-document-return", await status());
  await pages[0]?.screenshot({ path: `${output}/returned.png` });

  // P3/P4 are still seated. Empty pause must settle them without running the disconnect timer.
  const beforeEmpty = await status();
  assert(beforeEmpty.combat?.world.tanks.slice(2).every((tank) => tank.lifecycle === "occupied"));
  await control("pauseConnection");
  const empty = await retain(
    "empty-persisted",
    await until(
      "empty durable seat settlement",
      (state) => !!state.emptyPause && state.roomMode === "paused-empty",
    ),
  );
  assert.equal(empty.clock.timerPending, false);
  assert.equal(empty.durability?.committedTick, empty.tick);
  assert.equal(empty.durability?.backlogTicks, 0);
  assert(
    empty.combat?.world.players.every((player) => player.vehicleId === null && player.lives === 3),
  );
  assert(
    empty.combat?.world.tanks.every(
      (tank) => tank.lifecycle === "available" && tank.disconnectedTicks === 0,
    ),
  );
  assert(empty.tick - beforeEmpty.tick < TANK_PROFILE.disconnectGraceTicks);
  assert.equal(await restart(), base, "Restart changed the room origin");
  const cold = await retain("cold-empty", await status());
  assert.notEqual(cold.instanceId, empty.instanceId);
  assert.equal(cold.roomMode, "paused-empty");
  assert.equal(cold.tick, empty.tick);
  assert.deepEqual(cold.emptyPause, empty.emptyPause);
  assert.deepEqual(cold.combat?.world, empty.combat?.world);
  await control("resumeConnection");
  const restored = await clientsUntil("four cold returns", (clients) =>
    clients.every((client) => client.ready && client.runEpoch === empty.runEpoch + 1),
  );
  const loading = await retain("cold-loading", await status());
  assert.equal(loading.roomMode, "loading");
  assert.equal(loading.tick, empty.tick);
  assert.deepEqual(loading.combat?.world.tanks, empty.combat?.world.tanks);
  for (const [slot, client] of restored.entries()) {
    assert.equal(client.documentId, resumed[slot]?.documentId);
    assert.equal(client.initialServerTick, empty.tick);
    assert.equal(client.initialActor?.vehicleId, null);
    assert.equal(
      client.initialActor?.controlEpoch,
      (empty.combat?.world.players[slot]?.controlEpoch ?? 0) + 1,
    );
    assert(client.connectionEpoch > (resumed[slot]?.connectionEpoch ?? 0));
    assert.equal(client.sequence, 0);
    assert.equal(client.held, 0);
    assert.equal(client.pending, 0);
    assert.equal(client.events.receipts.length, 0, "Cold return replayed historical effects");
    assert.deepEqual(
      client.vehicles.map(({ armor, secondary }) => ({
        armor,
        ammo: secondary.ammo,
        shotsFired: secondary.shotsFired,
      })),
      stock,
    );
  }
  // A start without new input must fail; authority has survived but old preload has not.
  assert.equal((await roomHostCommand(base, pages, "start")).status, 409);
  await prepare();
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  await clientsUntil("shared post-restart snapshots", (clients) =>
    clients.every(
      (client) =>
        client.ready && !client.requiresResync && client.snapshotTick >= loading.tick + 45,
    ),
  );
  const clients = await read(true);
  const final = await retain("continued", await status());
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > loading.tick &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared post-restart tank snapshots");
  assert(
    final.combat?.world.players.every((player) => player.lives === 3 && player.vehicleId === null),
  );
  assert.deepEqual(
    final.combat?.world.tanks.map(({ armor, secondary }) => ({
      armor,
      ammo: secondary.ammo,
      shotsFired: secondary.shotsFired,
    })),
    stock,
  );
  await pages[0]?.screenshot({ path: `${output}/cold-return.png` });
  return {
    occupied,
    boundaries,
    before,
    replaced,
    retired,
    resumed,
    restored,
    final,
    clients,
    common,
  };
}

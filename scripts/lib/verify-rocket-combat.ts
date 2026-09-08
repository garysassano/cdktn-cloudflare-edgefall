import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { CombatLab } from "../../src/game/labs/combat.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface RocketClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  authoritative: CombatLab["players"][number];
  projectiles: FullSnapshot["projectiles"];
  initialServerTick: number;
  timeline: Array<{ kind: string; lastSequence: number; snapshotTick: number }>;
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
  events: {
    counts: Record<string, number>;
    duplicates: number;
    receipts: Array<{ cursor: number; tick: number; kind: string; hash: string }>;
  };
}

/** Two short taps on each real keyboard; room ticks and accepted inputs own all gameplay. */
export async function verifyRocketCombat(pages: Page[], base: string, output: string) {
  const samples: Array<Pick<CombatLab, "tick" | "rockets" | "players" | "events">> = [];
  const world = (state: RoomProbeStatus) => {
    assert(state.combat);
    return state.combat.world;
  };
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline) {
      const response = await fetch(`${base}/combat/status`);
      assert(response.ok);
      const state = (await response.json()) as RoomProbeStatus,
        current = world(state);
      assert(
        !state.clock.fault && !state.worldFailure && !state.persistenceFailure,
        "Rocket room failed",
      );
      assert(
        current.players.every(
          (player) =>
            player.lives === 3 &&
            player.weapon.ammo === 20 - player.weapon.shotOrdinal &&
            player.weapon.shotOrdinal <= 2,
        ),
      );
      if (samples.at(-1)?.tick !== current.tick)
        samples.push({
          tick: current.tick,
          rockets: current.rockets,
          players: current.players,
          events: current.events,
        });
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Rocket room boundary timed out");
  };
  const clientsNow = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as {
              controllerNetworkLab: { status(includeTimeline: boolean): RocketClient };
            }
          ).controllerNetworkLab.status(true),
        ),
      ),
    );
  const tap = () => Promise.all(pages.map((page) => page.keyboard.press("KeyZ", { delay: 10 })));
  await loadRoomIfNeeded(base, pages);
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#scripted").uncheck();
      await page.locator("#prepare").click();
      await page.locator("#game").focus();
    }),
  );
  await pages[1]?.evaluate(() =>
    (
      globalThis as unknown as {
        controllerNetworkLab: { configureEvents(value: { duplicate: boolean }): void };
      }
    ).controllerNetworkLab.configureEvents({ duplicate: true }),
  );
  await tap();
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const flight = await until(
    (state) =>
      world(state).players.every((player) => player.weapon.shotOrdinal === 1) &&
      world(state).rockets.length === 4,
  );
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() => {
        const client = (
          globalThis as unknown as { controllerNetworkLab: { status(): RocketClient } }
        ).controllerNetworkLab.status();
        return (
          client.projectiles.filter((projectile) => projectile.definitionId === 17).length === 4
        );
      }),
    ),
  );
  const flightClients = await clientsNow();
  for (const client of flightClients)
    for (const projectile of client.projectiles) {
      assert.equal(projectile.definitionId, 17);
      assert.equal(projectile.shapeId, 19);
      assert.equal(projectile.lifetimeTicks, 90);
      assert(projectile.heading >= 0 && projectile.heading < 32);
    }
  await pages[0]?.screenshot({ path: `${output}/rocket-flight.png` });
  await until((state) => world(state).players.every((player) => player.weapon.cooldownTicks === 0));
  await tap();
  const second = await until((state) =>
    world(state).players.every((player) => player.weapon.shotOrdinal === 2),
  );
  const final = await until(
    (state) => state.tick >= second.tick + 135 && world(state).rockets.length === 0,
  );
  const accepted = world(final),
    clients = await clientsNow();
  assert.equal(accepted.encounter.phase, "complete");
  assert.equal(
    accepted.encounter.kills.reduce((sum, item) => sum + item.count, 0),
    2,
  );
  for (const client of clients) {
    assert(client.ready && !client.error && !client.requiresResync);
    assert.equal(client.authoritative.weapon.ammo, 18);
    assert.equal(client.authoritative.weapon.shotOrdinal, 2);
    assert.equal(client.events.counts.shot, 8);
    assert.equal(client.events.counts.killed, 2);
    assert((client.events.counts.explosion ?? 0) > 0);
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
    const sends = client.timeline.filter(
      (entry) => entry.kind === "send" && entry.lastSequence > 0,
    );
    assert(sends.length > 0);
    assert(
      sends.every(
        (entry) => client.initialServerTick + entry.lastSequence - entry.snapshotTick <= 6,
      ),
    );
  }
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick >= second.tick + 90 &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared terminal rocket snapshots");
  const commonEvents =
    clients[0]?.events.receipts.filter((event) =>
      clients.every((client) =>
        client.events.receipts.some(
          (other) => other.cursor === event.cursor && other.hash === event.hash,
        ),
      ),
    ) ?? [];
  for (const kind of ["shot", "explosion", "killed"])
    assert(commonEvents.some((event) => event.kind === kind));
  await pages[0]?.screenshot({ path: `${output}/rocket-complete.png` });
  return { flight, flightClients, second, final, samples, clients, common, commonEvents };
}

import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { stateHash } from "../../src/game/core/canonical.js";
import type { CombatLab } from "../../src/game/labs/combat.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { EventEnvelope, GameplayEvent } from "../../src/shared/protocol/events.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface PickupClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  authoritative: CombatLab["players"][number];
  pickups: CombatLab["pickups"]["items"];
  supplyMarkers: Array<{
    sourceId: number;
    remaining: number;
    visible: boolean;
    textVisible: boolean;
    text: string;
  }>;
  initialServerTick: number;
  timeline: Array<{ kind: string; lastSequence: number; snapshotTick: number }>;
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
  events: {
    counts: Record<string, number>;
    duplicates: number;
    framesDropped: number;
    receipts: Array<
      Pick<
        GameplayEvent,
        | "kind"
        | "ownerId"
        | "x"
        | "y"
        | "definitionId"
        | "confirmation"
        | "beam"
        | "pickup"
        | "targetId"
      > & { cursor: number; tick: number; hash: string }
    >;
    renderedPickups: Array<{
      cursor: number;
      tick: number;
      receivedAtTick: number;
      presentedAtTick: number;
      claimId: number;
    }>;
  };
}

/** Four real keyboards share finite piles, with one reader dropping frames and duplicating redelivery. */
export async function verifyPickupCombat(pages: Page[], base: string, output: string) {
  const samples: Array<Pick<CombatLab, "tick" | "pickups" | "pickupClaims" | "players">> = [];
  const history = new Map<number, EventEnvelope>();
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
        "Pickup room failed",
      );
      assert(
        current.players.every((player) => player.lives === 3 && player.body.x < 392 * 256),
        "Pickup route left its safe floor",
      );
      for (const event of state.combat?.events ?? []) history.set(event.cursor, event);
      if (samples.at(-1)?.tick !== current.tick)
        samples.push({
          tick: current.tick,
          pickups: current.pickups,
          pickupClaims: current.pickupClaims,
          players: current.players,
        });
      assert(samples.length <= 1000, "Unbounded pickup observation");
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Pickup room boundary timed out");
  };
  const clientsNow = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as {
              controllerNetworkLab: { status(timeline: boolean): PickupClient };
            }
          ).controllerNetworkLab.status(true),
        ),
      ),
    );
  await loadRoomIfNeeded(base, pages);
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#scripted").uncheck();
      await page.locator("#prepare").click();
      await page.locator("#game").focus();
      await page.keyboard.down("ArrowUp");
      await page.keyboard.down("KeyZ");
      await page.keyboard.down("ArrowRight");
    }),
  );
  await pages[1]?.evaluate(() =>
    (
      globalThis as unknown as {
        controllerNetworkLab: {
          configureEvents(value: { duplicate: boolean; dropNext: number }): void;
        };
      }
    ).controllerNetworkLab.configureEvents({ duplicate: true, dropNext: 6 }),
  );
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const shared = await until((state) =>
    world(state).players.every((player) => player.weapon.id === "laser"),
  );
  await Promise.all(
    pages.map(async (page) => {
      await page.keyboard.up("ArrowRight");
      await page.keyboard.up("KeyZ");
      await page.keyboard.up("ArrowUp");
    }),
  );
  const final = await until(
      (state) => state.tick >= shared.tick + 48 && world(state).beams.length === 0,
    ),
    accepted = world(final);
  const clients = await clientsNow();
  const events = [...history.values()].sort((a, b) => a.cursor - b.cursor),
    eventHashes = new Map<number, string>();
  let eventHash = "0";
  for (const [index, event] of events.entries()) {
    assert.equal(event.cursor, index + 1, "Missing authoritative pickup event prefix");
    eventHash = stateHash([eventHash, { runEpoch: final.runEpoch, ...event }]);
    eventHashes.set(event.cursor, eventHash);
  }
  const claims = events.filter((event) => event.event.kind === "pickup");
  assert.equal(claims.length, 20);
  assert.equal(new Set(claims.map((event) => event.event.pickup?.claimId)).size, 20);
  for (const sourceId of [500, 501, 502, 503, 504]) {
    const station = claims.filter((event) => event.event.definitionId === sourceId);
    assert.equal(station.length, 4);
    assert.equal(new Set(station.map((event) => event.event.ownerId)).size, 4);
  }
  assert.deepEqual(
    accepted.pickups.items.find((item) => item.id === 621),
    { id: 621, status: "expired", resolvedTick: 24, claimedBy: null },
  );
  for (const player of accepted.players) {
    assert.equal(player.weapon.id, "laser");
    const laserClaims = claims.filter(
      (event) =>
        event.event.ownerId === player.playerId && event.event.pickup?.weaponId === "laser",
    );
    const pickupTick = laserClaims[0]?.tick;
    assert(pickupTick);
    const charges = events.filter(
      (event) =>
        event.tick > pickupTick &&
        event.event.ownerId === player.playerId &&
        event.event.kind === "shot" &&
        event.event.beam,
    );
    assert.equal(player.weapon.ammo, 120 - charges.length);
    assert.equal(player.lives, 3);
  }
  for (const client of clients) {
    assert(client.ready && !client.error && !client.requiresResync);
    assert.deepEqual(client.pickups, accepted.pickups.items);
    assert.equal(client.events.counts.pickup, 20);
    assert.equal(client.events.renderedPickups.length, 20);
    assert(
      client.supplyMarkers.length === 6 &&
        client.supplyMarkers.every(
          (marker) => marker.remaining === 0 && !marker.visible && !marker.textVisible,
        ),
    );
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
    for (const receipt of client.events.receipts) {
      const event = history.get(receipt.cursor)?.event;
      assert(event);
      for (const field of ["beam", "confirmation", "pickup"] as const)
        assert.deepEqual(receipt[field], event[field]);
      for (const field of ["kind", "ownerId", "definitionId", "x", "y", "targetId"] as const)
        assert.equal(receipt[field], event[field]);
      assert.equal(
        receipt.hash,
        eventHashes.get(receipt.cursor),
        "Decoded pickup event differs from authority",
      );
    }
    const sends = client.timeline.filter(
      (entry) => entry.kind === "send" && entry.lastSequence > 0,
    );
    assert(
      sends.length > 0 &&
        sends.every(
          (entry) => client.initialServerTick + entry.lastSequence - entry.snapshotTick <= 6,
        ),
    );
  }
  assert.equal(clients[1]?.events.framesDropped, 6);
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  assert(
    clients[1]?.events.renderedPickups.some((event) => event.receivedAtTick - event.tick > 8),
    "Delayed pickup claim was never rendered",
  );
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick >= shared.tick + 9 &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared terminal pickup snapshots");
  await pages[0]?.screenshot({ path: `${output}/pickups-complete.png` });
  return { shared, final, clients, common, events, eventHash, claims, samples };
}

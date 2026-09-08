import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { beamSegments } from "../../src/game/combat/beam.js";
import { stateHash } from "../../src/game/core/canonical.js";
import type { CombatLab } from "../../src/game/labs/combat.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { EventEnvelope, GameplayEvent } from "../../src/shared/protocol/events.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface LaserClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  authoritative: CombatLab["players"][number];
  volumes: NonNullable<FullSnapshot["combat"]>["volumes"];
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
        "kind" | "ownerId" | "x" | "y" | "definitionId" | "confirmation" | "beam"
      > & { cursor: number; tick: number; hash: string }
    >;
    renderedBeams: Array<{
      cursor: number;
      tick: number;
      receivedAtTick: number;
      presentedAtTick: number;
      geometryHash: string;
    }>;
  };
}

/** Real keyboard taps and held energy, including a beam event delayed beyond its original visual lifetime. */
export async function verifyLaserCombat(pages: Page[], base: string, output: string) {
  const samples: Array<Pick<CombatLab, "tick" | "beams" | "players" | "events">> = [];
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
        "Laser room failed",
      );
      assert(
        current.players.every(
          (player) =>
            player.lives === 3 &&
            player.weapon.ammo === 120 - player.weapon.shotOrdinal &&
            player.weapon.shotOrdinal <= 12,
        ),
      );
      for (const event of state.combat?.events ?? []) history.set(event.cursor, event);
      if (samples.at(-1)?.tick !== current.tick)
        samples.push({
          tick: current.tick,
          beams: current.beams,
          players: current.players,
          events: current.events,
        });
      assert(samples.length <= 1000, "Unbounded laser observation");
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Laser room boundary timed out");
  };
  const clientsNow = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as {
              controllerNetworkLab: { status(timeline: boolean): LaserClient };
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
        controllerNetworkLab: {
          configureEvents(value: { duplicate: boolean; dropNext: number }): void;
        };
      }
    ).controllerNetworkLab.configureEvents({ duplicate: true, dropNext: 4 }),
  );
  await tap();
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const first = await until((state) =>
    world(state).players.every((player) => player.weapon.shotOrdinal === 1),
  );
  await until((state) => state.tick >= first.tick + 20 && world(state).beams.length === 0);
  await pages[1]?.waitForFunction(() =>
    (
      globalThis as unknown as { controllerNetworkLab: { status(): LaserClient } }
    ).controllerNetworkLab
      .status()
      .events.renderedBeams.some((event) => event.receivedAtTick - event.tick > 8),
  );
  const delayed = await clientsNow();
  assert.equal(delayed[1]?.events.framesDropped, 4);
  for (const client of delayed) {
    assert.equal(client.events.counts.shot, 4);
    assert(client.events.renderedBeams.length > 0);
    for (const rendered of client.events.renderedBeams) {
      const receipt = client.events.receipts.find((event) => event.cursor === rendered.cursor);
      assert(receipt?.beam);
      assert.equal(
        rendered.geometryHash,
        stateHash(
          beamSegments(
            { x: receipt.x, y: receipt.y },
            receipt.beam.heading,
            receipt.beam.length,
            receipt.beam.width,
          ),
        ),
      );
    }
  }
  await pages[1]?.screenshot({ path: `${output}/laser-delayed-tap.png` });
  await Promise.all(
    pages.map(async (page) => {
      await page.keyboard.down("ArrowUp");
      await page.keyboard.down("KeyZ");
    }),
  );
  const held = await until(
    (state) =>
      world(state).players.every((player) => player.weapon.shotOrdinal >= 4) &&
      world(state).beams.length === 4,
  );
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(() =>
        (
          globalThis as unknown as { controllerNetworkLab: { status(): LaserClient } }
        ).controllerNetworkLab
          .status()
          .volumes.some((volume) => volume.definitionId === 18 && volume.heading === 1),
      ),
    ),
  );
  const heldClients = await clientsNow();
  await pages[0]?.screenshot({ path: `${output}/laser-held.png` });
  await Promise.all(
    pages.map(async (page) => {
      await page.keyboard.up("KeyZ");
      await page.keyboard.up("ArrowUp");
    }),
  );
  const released = await until(
    (state) =>
      state.tick >= held.tick + 18 &&
      world(state).beams.length === 0 &&
      world(state).players.every((player) => player.weapon.cooldownTicks === 0),
  );
  const ordinals = world(released).players.map((player) => player.weapon.shotOrdinal);
  await tap();
  const second = await until((state) =>
    world(state).players.every((player, i) => player.weapon.shotOrdinal === (ordinals[i] ?? 0) + 1),
  );
  const final = await until(
      (state) => state.tick >= second.tick + 48 && world(state).beams.length === 0,
    ),
    accepted = world(final),
    clients = await clientsNow();
  const events = [...history.values()].sort((a, b) => a.cursor - b.cursor);
  const eventHashes = new Map<number, string>();
  let eventHash = "0";
  for (const [index, event] of events.entries()) {
    assert.equal(event.cursor, index + 1, "Missing authoritative event prefix");
    eventHash = stateHash([eventHash, { runEpoch: final.runEpoch, ...event }]);
    eventHashes.set(event.cursor, eventHash);
  }
  assert.equal(accepted.encounter.phase, "complete");
  assert.equal(
    accepted.encounter.kills.reduce((sum, kill) => sum + kill.count, 0),
    2,
  );
  for (const player of accepted.players) {
    const shots = events.filter(
      (event) => event.event.kind === "shot" && event.event.ownerId === player.playerId,
    );
    assert.equal(shots.length, player.weapon.shotOrdinal);
    assert.equal(player.weapon.ammo, 120 - shots.length);
    const sustained = shots.filter((event) => event.event.beam?.heading === 1);
    assert(sustained.length >= 3);
    for (let i = 1; i < sustained.length; i++)
      assert.equal((sustained[i]?.tick ?? 0) - (sustained[i - 1]?.tick ?? 0), 6);
    assert(
      shots.every((event) => event.event.beam?.width === 1024 && event.event.beam.length <= 131072),
    );
  }
  for (const client of clients) {
    assert(client.ready && !client.error && !client.requiresResync);
    assert.equal(
      client.events.counts.shot,
      accepted.players.reduce((sum, player) => sum + player.weapon.shotOrdinal, 0),
    );
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
    for (const receipt of client.events.receipts) {
      const event = history.get(receipt.cursor)?.event;
      assert(event);
      assert.deepEqual(receipt.beam, event.beam);
      assert.deepEqual(receipt.confirmation, event.confirmation);
      for (const field of ["kind", "ownerId", "definitionId", "x", "y"] as const)
        assert.equal(receipt[field], event[field]);
      assert.equal(
        receipt.hash,
        eventHashes.get(receipt.cursor),
        "Decoded event differs from authority",
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
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick >= second.tick + 9 &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared terminal laser snapshots");
  await pages[0]?.screenshot({ path: `${output}/laser-complete.png` });
  return {
    first,
    delayed,
    held,
    heldClients,
    released,
    second,
    final,
    clients,
    common,
    events,
    eventHash,
    samples,
  };
}

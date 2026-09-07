import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { BallisticProjectile } from "../../src/game/combat/projectile.js";
import type { ControlledActor } from "../../src/game/state.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface HmgClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  authoritative: ControlledActor;
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
  events: {
    duplicates: number;
    receipts: Array<{ cursor: number; tick: number; kind: string; hash: string }>;
  };
}

/** Four actual keyboards slew while firing, mirror, jump/down-fire and lower the gun on landing. */
export async function verifyHmgCombat(pages: Page[], base: string, output: string) {
  const samples: Array<{
    tick: number;
    players: Array<
      Pick<
        ControlledActor,
        "playerId" | "firearmAim" | "facing" | "locomotion" | "weapon" | "action"
      >
    >;
  }> = [];
  const projectiles = new Map<number, BallisticProjectile>();
  const world = (state: RoomProbeStatus) => {
    assert(state.combat);
    return state.combat.world;
  };
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    const deadline = performance.now() + 12000;
    while (performance.now() < deadline) {
      const response = await fetch(`${base}/combat/status`);
      assert(response.ok);
      const state = (await response.json()) as RoomProbeStatus;
      assert(
        !state.persistenceFailure && !state.clock.fault && !state.worldFailure,
        "HMG room failed",
      );
      const current = world(state);
      if (samples.at(-1)?.tick !== current.tick)
        samples.push({
          tick: current.tick,
          players: current.players.map(
            ({ playerId, firearmAim, facing, locomotion, weapon, action }) => ({
              playerId,
              firearmAim,
              facing,
              locomotion,
              weapon,
              action,
            }),
          ),
        });
      for (const shot of current.projectiles)
        if (shot.definitionId === 2 && !projectiles.has(shot.id)) projectiles.set(shot.id, shot);
      assert(
        current.players.every(
          (player) =>
            player.weapon.ammo === 150 - player.weapon.shotOrdinal &&
            player.lives === 3 &&
            player.grenadeStock === 10,
        ),
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("HMG boundary timed out");
  };
  const key = (name: string, down: boolean) =>
    Promise.all(pages.map((page) => (down ? page.keyboard.down(name) : page.keyboard.up(name))));
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
  await key("KeyZ", true);
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  await until((state) => world(state).players.every((player) => player.weapon.shotOrdinal >= 1));
  await key("ArrowUp", true);
  const up = await until((state) =>
    world(state).players.every((player) => player.firearmAim.pitch === 4),
  );
  await pages[0]?.screenshot({ path: `${output}/hmg-up.png` });
  await key("ArrowUp", false);
  await key("ArrowLeft", true);
  const mirrored = await until((state) =>
    world(state).players.every((player) => player.firearmAim.pitch === 0 && player.facing === -1),
  );
  await key("ArrowLeft", false);
  await key("Space", true);
  await key("ArrowDown", true);
  await until((state) => world(state).players.every((player) => player.locomotion === "airborne"));
  await key("Space", false);
  const down = await until((state) =>
    world(state).players.every((player) => player.firearmAim.pitch === -4),
  );
  await pages[0]?.screenshot({ path: `${output}/hmg-down.png` });
  const crouched = await until((state) =>
    world(state).players.every(
      (player) => player.locomotion === "crouched" && player.firearmAim.pitch === 0,
    ),
  );
  await pages[0]?.screenshot({ path: `${output}/hmg-crouched.png` });
  await key("ArrowDown", false);
  await key("KeyZ", false);
  await key("ArrowUp", true);
  const idleUp = await until((state) =>
    world(state).players.every((player) => player.firearmAim.pitch === 4),
  );
  const final = await until((state) => state.tick >= idleUp.tick + 45);
  assert.deepEqual(
    world(final).players.map((player) => player.weapon.shotOrdinal),
    world(idleUp).players.map((player) => player.weapon.shotOrdinal),
  );
  for (const player of world(final).players) {
    const shots = [...projectiles.values()].filter((shot) => shot.ownerId === player.playerId);
    assert(
      shots.some((shot) => shot.velocity.x !== 0 && shot.velocity.y < 0),
      "Missing rising sweep bullet",
    );
    assert(
      shots.some((shot) => shot.velocity.x < 0 && shot.velocity.y > 0),
      "Missing mirrored descending sweep bullet",
    );
  }
  const clients = await Promise.all(
    pages.map((page) =>
      page.evaluate(() =>
        (
          globalThis as unknown as { controllerNetworkLab: { status(): HmgClient } }
        ).controllerNetworkLab.status(),
      ),
    ),
  );
  assert(
    clients.every(
      (client) =>
        client.ready &&
        !client.error &&
        !client.requiresResync &&
        client.authoritative.firearmAim.pitch === 4,
    ),
  );
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > idleUp.tick &&
        clients.every((client) =>
          client.receipts.some(
            (candidate) =>
              candidate.tick === receipt.tick &&
              candidate.hash === receipt.hash &&
              candidate.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Fewer than ten matching snapshots after sweep");
  for (const client of clients)
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
  const commonEvents =
    clients[0]?.events.receipts.filter((event) =>
      clients.every((client) =>
        client.events.receipts.some(
          (candidate) => candidate.cursor === event.cursor && candidate.hash === event.hash,
        ),
      ),
    ) ?? [];
  assert(commonEvents.length >= 12);
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  return {
    up,
    mirrored,
    down,
    crouched,
    idleUp,
    final,
    samples,
    observedProjectiles: [...projectiles.values()],
    clients,
    common,
    commonEvents,
  };
}

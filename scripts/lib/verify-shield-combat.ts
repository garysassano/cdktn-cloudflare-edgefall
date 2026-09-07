import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { pixels } from "../../src/game/core/numeric.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface ShieldClient {
  snapshotTick: number;
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  enemies: FullSnapshot["enemies"];
  threats: FullSnapshot["threats"];
  receipts: { tick: number; hash: number; continuationHash: string | null }[];
  events: {
    duplicates: number;
    receipts: { cursor: number; tick: number; kind: string; hash: string }[];
  };
}
export async function verifyShieldCombat(pages: Page[], base: string, output: string) {
  const read = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): ShieldClient } }
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
        "Shield combat room failed",
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Shield combat boundary timed out");
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
  await key("KeyC", true);
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const released = await until((state) => state.combat?.world.grenades.length === 4);
  await key("KeyC", false);
  await key("ArrowDown", false);
  await key("ArrowRight", true);
  const windup = await until((state) => state.combat?.world.targets[0]?.guard?.phase === "bash");
  await key("Space", true);
  await key("Space", false);
  await pages[0]?.screenshot({ path: `${output}/shield-windup.png` });
  await until((state) => (state.combat?.world.players[0]?.body.x ?? 0) >= pixels(192));
  await key("ArrowRight", false);
  await key("ArrowDown", true);
  const broken = await until((state) => state.combat?.world.targets[0]?.guard?.integrity === 0);
  assert.equal(
    broken.combat?.world.targets[0]?.health,
    1,
    "Break must leave the fragile body alive",
  );
  assert(
    broken.combat?.world.players.every((player) => player.lives === 3),
    "Jump/crouch route failed to evade the committed attacks",
  );
  await until((state) => state.tick >= broken.tick + 12);
  await pages[0]?.waitForFunction(() =>
    (
      globalThis as unknown as {
        controllerNetworkLab: { status(): ShieldClient };
      }
    ).controllerNetworkLab
      .status()
      .enemies.some((enemy) => enemy.definitionId === 4 && enemy.mode === 10),
  );
  await pages[0]?.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const presentation = await read();
  await pages[0]?.screenshot({ path: `${output}/shield-broken.png` });
  const recovered = await until(
    (state) =>
      !!state.combat?.world.targets[0]?.guard &&
      state.combat.world.targets[0].guard.phase !== "stunned",
  );
  await key("ArrowDown", false);
  await key("ArrowLeft", true);
  await key("KeyZ", true);
  const guardKilled = await until((state) => state.combat?.world.targets[0]?.health === 0);
  await key("ArrowLeft", false);
  await key("ArrowRight", true);
  // One admitted turn is sufficient; crouch retains the right-facing firing lane.
  await until((state) => !!state.combat?.world.players.every((player) => player.facing === 1));
  await key("ArrowRight", false);
  await key("ArrowDown", true);
  const clear = await until((state) => state.combat?.world.encounter.phase === "complete");
  await key("KeyZ", false);
  const final = await until((state) => state.tick >= clear.tick + 45);
  const clients = await read();
  assert(clients.every((client) => client.ready && !client.error && !client.requiresResync));
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > clear.tick &&
        clients.every((client) =>
          client.receipts.some(
            (candidate) =>
              candidate.tick === receipt.tick &&
              candidate.hash === receipt.hash &&
              candidate.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing common snapshots after shield combat");
  const events = clear.combat?.events ?? [];
  assert.equal(events.filter(({ event }) => event.kind === "shield-break").length, 1);
  // The server keeps only a bounded event window; inspect release before age eviction.
  assert.equal(released.combat?.events.filter(({ event }) => event.kind === "throw").length, 4);
  assert.equal(
    clear.combat?.world.encounter.kills.reduce((sum, item) => sum + item.count, 0),
    2,
  );
  for (const client of clients) {
    assert.equal(client.events.receipts.filter((event) => event.kind === "throw").length, 4);
    assert.equal(client.events.receipts.filter((event) => event.kind === "shield-break").length, 1);
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
  assert.equal(commonEvents.length, clients[0]?.events.receipts.length);
  assert((clients[1]?.events.duplicates ?? 0) > 0);
  await pages[0]?.screenshot({ path: `${output}/shield-cleared.png` });
  return {
    released,
    windup,
    broken,
    presentation,
    recovered,
    guardKilled,
    clear,
    final,
    clients,
    common,
    commonEvents,
    duplicateDeliverySlot: 1,
  };
}

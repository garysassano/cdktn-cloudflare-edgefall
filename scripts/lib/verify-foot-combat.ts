import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import { pixels } from "../../src/game/core/numeric.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface FootClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  authoritative: FullSnapshot["players"][number];
  threats: FullSnapshot["threats"];
  projectiles: FullSnapshot["projectiles"];
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
  events: {
    duplicates: number;
    receipts: Array<{ cursor: number; tick: number; kind: string; hash: string }>;
  };
}

/** Real keyboard intent and ordinary snapshot/event reception in four browser contexts. */
export async function verifyFootCombat(
  pages: Page[],
  base: string,
  output: string,
  mode: "melee" | "grenade",
) {
  const read = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): FootClient } }
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
        "Foot combat room failed",
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Foot ${mode} boundary timed out`);
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
  await key(mode === "melee" ? "ArrowRight" : "KeyC", true);
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  if (mode === "melee") {
    await until((state) => (state.combat?.world.players[0]?.body.x ?? 0) >= pixels(160));
    await key("ArrowRight", false);
    await key("KeyZ", true);
  }
  const released = await until((state) =>
    mode === "melee"
      ? !!state.combat?.world.players.some((player) => player.action.kind === "melee")
      : state.combat?.world.grenades.length === 4,
  );
  if (mode === "grenade") await key("KeyC", false);
  await pages[0]?.waitForFunction(
    (mode) => {
      const state = (
        globalThis as unknown as { controllerNetworkLab: { status(): FootClient } }
      ).controllerNetworkLab.status();
      return mode === "melee"
        ? state.threats.some((threat) => threat.shapeId === 9)
        : state.projectiles.some((projectile) => projectile.definitionId === 5);
    },
    mode,
    { timeout: 1500 },
  );
  await pages[0]?.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const presentation = await read();
  await pages[0]?.screenshot({ path: `${output}/${mode}-action.png` });
  const clear = await until((state) => state.combat?.world.encounter.phase === "complete");
  const events = clear.combat?.events ?? [];
  const releases = events.filter(
    ({ event }) => event.kind === (mode === "melee" ? "melee" : "throw"),
  );
  assert(
    releases.length > 0 && releases.length <= 4,
    "Missing or duplicated accepted foot actions",
  );
  if (mode === "grenade") {
    assert.equal(releases.length, 4);
    const explosions = events.filter(({ event }) => event.kind === "explosion");
    assert.equal(explosions.length, 4);
    for (const explosion of explosions) {
      const birth = releases.find(
        ({ event }) => event.actionInstanceId === explosion.event.actionInstanceId,
      );
      assert(birth);
      assert.equal(explosion.tick - birth.tick, 90);
    }
  }
  assert.equal(
    clear.combat?.world.encounter.kills.reduce((total, credit) => total + credit.count, 0),
    2,
  );
  assert(
    clear.combat?.world.players.every(
      (player) => player.grenadeStock === (mode === "melee" ? 10 : 9),
    ),
  );
  const final = await until((state) => state.tick >= clear.tick + 45);
  const clients = await read();
  assert(
    clients.every((client) => client.ready && !client.error && !client.requiresResync),
    "A browser failed foot action reconciliation",
  );
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
  assert(common.length >= 10, "Fewer than ten common snapshots after foot combat");
  for (const client of clients) {
    const accepted = client.events.receipts.filter(
      (event) => event.kind === (mode === "melee" ? "melee" : "throw"),
    );
    assert.equal(accepted.length, releases.length);
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
      "Duplicate gameplay effect escaped reception deduplication",
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
  await pages[0]?.screenshot({ path: `${output}/${mode}-cleared.png` });
  return {
    mode,
    released,
    presentation,
    clear,
    final,
    clients,
    common,
    commonEvents,
    duplicateDeliverySlot: 1,
  };
}

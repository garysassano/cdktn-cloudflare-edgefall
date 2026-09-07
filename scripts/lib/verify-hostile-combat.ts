import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { GameplayEvent } from "../../src/shared/protocol/events.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface RifleClient {
  ready: boolean;
  prepared: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  authoritative: FullSnapshot["players"][number];
  threats: FullSnapshot["threats"];
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
  events: {
    receipts: Array<{
      cursor: number;
      tick: number;
      kind: string;
      origin: string;
      ownerId: number;
      confirmation: GameplayEvent["confirmation"];
      hash: string;
    }>;
  };
}

/** Four real keyboard clients dodge a committed burst, take hostile damage, and return fire. */
export async function verifyHostileCombat(pages: Page[], base: string, output: string) {
  const read = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): RifleClient } }
          ).controllerNetworkLab.status(),
        ),
      ),
    );
  const status = async () =>
    (await (await fetch(`${base}/combat/status`)).json()) as RoomProbeStatus;
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      const state = await status();
      assert(
        !state.persistenceFailure && !state.clock.fault && !state.worldFailure,
        "Hostile combat room failed",
      );
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Hostile combat boundary timed out");
  };
  const key = (key: string, down: boolean) =>
    Promise.all(
      pages.map(async (page) => {
        await page.locator("#game").focus();
        if (down) await page.keyboard.down(key);
        else await page.keyboard.up(key);
      }),
    );
  await loadRoomIfNeeded(base, pages);
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#scripted").uncheck();
      await page.locator("#prepare").click();
    }),
  );
  await key("ArrowDown", true);
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const raised = await until((state) => state.tick >= 9);
  assert(raised.tick < 25, "Missed visible weapon raise");
  assert(raised.combat?.world.targets.every((target) => target.rifle?.action.kind === "fire"));
  const raisingClients = await read();
  assert(
    raisingClients.every((client) => client.threats.length === 2),
    "A browser missed the attack telegraph",
  );
  await pages[0]?.screenshot({ path: `${output}/rifle-raise.png` });
  const dodged = await until((state) => state.tick >= 120);
  assert(
    dodged.combat?.world.players.every((player) => player.lives === 3 && player.life === "alive"),
    "Crouched players took level rifle damage",
  );
  assert(dodged.combat?.world.targets.every((target) => target.health === 1));
  const dodgingClients = await read();
  assert(
    dodgingClients.every(
      (client) =>
        client.authoritative.locomotion === "crouched" && client.authoritative.lives === 3,
    ),
  );
  assert(
    dodgingClients.every(
      (client) =>
        client.events.receipts
          .filter((event) => event.kind === "shot" && event.ownerId === 20)
          .slice(0, 3)
          .map((event) => event.tick)
          .join() === "25,31,37",
    ),
  );
  await key("ArrowDown", false);
  const hit = await until(
    (state) => !!state.combat?.world.players.some((player) => player.life === "death"),
  );
  await key("KeyZ", true);
  const cleared = await until((state) => state.combat?.world.encounter.phase === "complete");
  assert.equal(
    cleared.combat?.world.encounter.kills.reduce((total, credit) => total + credit.count, 0),
    2,
  );
  const final = await until(
    (state) =>
      state.tick >= cleared.tick + 45 &&
      !!state.combat?.world.players.every((player) => player.life === "alive"),
  );
  const clients = await read();
  assert(
    clients.every((client) => client.ready && !client.error && !client.requiresResync),
    "A browser failed hostile hit reconciliation",
  );
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick > cleared.tick &&
        clients.every((client) =>
          client.receipts.some(
            (candidate) =>
              candidate.tick === receipt.tick &&
              candidate.hash === receipt.hash &&
              candidate.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Fewer than ten common authoritative snapshots after combat");
  for (const client of clients) {
    assert(
      client.events.receipts.some((event) => event.kind === "killed" && event.origin === "enemy"),
      "Missing acknowledged hostile death",
    );
    assert(
      client.events.receipts
        .filter((event) => event.origin === "enemy")
        .every((event) => event.confirmation === null),
      "Hostile event acquired a player confirmation",
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
  assert(
    commonEvents.some((event) => event.origin === "enemy" && event.kind === "killed"),
    "Hostile event histories differ between clients",
  );
  await pages[0]?.screenshot({ path: `${output}/rifle-cleared.png` });
  return { raised, dodged, hit, cleared, final, clients, common, commonEvents };
}

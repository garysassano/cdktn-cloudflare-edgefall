import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import {
  FIREARM_FEEDBACK_MS,
  type FirearmFeedback,
} from "../../src/shared/prediction/firearm-feedback.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface FeedbackClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  actor: FullSnapshot["players"][number];
  authoritative: FullSnapshot["players"][number];
  firearmFeedback: FirearmFeedback["status"];
  events: { duplicates: number; framesDropped: number };
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
}

/** Real pre-acknowledgment frames, delayed confirmation and moving held fire in four sockets. */
export async function verifyFirearmFeedback(pages: Page[], base: string, output: string) {
  const samples: RoomProbeStatus[] = [];
  const read = () =>
    Promise.all(
      pages.map((page) =>
        page.evaluate(() =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): FeedbackClient } }
          ).controllerNetworkLab.status(),
        ),
      ),
    );
  const until = async (accept: (state: RoomProbeStatus) => boolean) => {
    const deadline = performance.now() + 12_000;
    while (performance.now() < deadline) {
      const response = await fetch(`${base}/combat/status`);
      assert(response.ok);
      const state = (await response.json()) as RoomProbeStatus;
      assert(
        !state.clock.fault && !state.worldFailure && !state.persistenceFailure,
        "Feedback room failed",
      );
      if (samples.at(-1)?.tick !== state.tick) samples.push(state);
      assert(samples.length <= 600, "Feedback observation limit");
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Feedback boundary timed out");
  };
  await loadRoomIfNeeded(base, pages);
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#scripted").uncheck();
      await page.locator("#prepare").click();
      await page.locator("#game").focus();
    }),
  );
  await until(
    (s) =>
      s.inputStreams.length === 4 &&
      s.inputStreams.every((i) => i.queued === 5 && i.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  await until((s) => s.tick >= 12);
  await Promise.all(
    pages.map(async (page) => {
      await page.evaluate(() =>
        (
          globalThis as unknown as {
            controllerNetworkLab: {
              configureEvents(value: { duplicate: boolean; dropNext: number }): void;
            };
          }
        ).controllerNetworkLab.configureEvents({ duplicate: true, dropNext: 6 }),
      );
      await page.keyboard.down("ArrowUp");
      await page.keyboard.press("KeyZ", { delay: 10 });
    }),
  );
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(
        () =>
          (
            globalThis as unknown as { controllerNetworkLab: { status(): FeedbackClient } }
          ).controllerNetworkLab
            .status()
            .firearmFeedback.items.some(
              (item) => item.presentedAtMs !== null && item.confirmedAtMs === null,
            ),
        undefined,
        { timeout: 3000 },
      ),
    ),
  );
  const predicted = await read();
  const first = await until(
    (s) => s.combat?.world.players.every((p) => p.weapon.shotOrdinal === 1) ?? false,
  );
  await until((s) => s.tick >= first.tick + 30);
  const delayed = await read();
  for (const client of delayed) {
    const shot = client.firearmFeedback.items.find(
      (i) => i.confirmation.shotOrdinal === 1 && i.markerIndex === 0,
    );
    assert(
      shot &&
        shot.presentedAtMs !== null &&
        shot.lastPresentedAtMs !== null &&
        shot.confirmedAtMs !== null &&
        shot.acknowledgedAtMs !== null,
      "Missing actual local flash/ack/confirmation timestamps",
    );
    assert.equal(shot.state, "confirmed");
    assert(
      shot.presentedAtMs < shot.acknowledgedAtMs,
      "Local feedback waited for input acknowledgment",
    );
    assert(
      shot.confirmedAtMs - shot.bornAtMs > FIREARM_FEEDBACK_MS,
      "Confirmation was not delayed beyond the flash lifetime",
    );
    assert(
      shot.lastPresentedAtMs < shot.confirmedAtMs,
      "Delayed confirmation replayed the muzzle flash",
    );
    assert.equal(client.events.framesDropped, 6);
    assert(client.events.duplicates > 0);
  }
  await pages[0]?.screenshot({ path: `${output}/feedback-delayed.png` });
  await Promise.all(
    pages.map(async (page) => {
      await page.keyboard.down("ArrowRight");
      await page.keyboard.down("KeyZ");
      await page.keyboard.press("Space", { delay: 10 });
    }),
  );
  await Promise.all(
    pages.map((page) =>
      page.waitForFunction(
        () => {
          const client = (
            globalThis as unknown as { controllerNetworkLab: { status(): FeedbackClient } }
          ).controllerNetworkLab.status();
          return (
            !client.actor.body.grounded &&
            client.actor.body.vx > 0 &&
            client.actor.action.kind === "fire"
          );
        },
        undefined,
        { timeout: 3000 },
      ),
    ),
  );
  const moving = await read();
  await Promise.all(pages.map((page) => page.keyboard.up("ArrowRight")));
  const held = await until(
    (s) => s.combat?.world.players.every((p) => p.weapon.shotOrdinal >= 3) ?? false,
  );
  await Promise.all(
    pages.map(async (page) => {
      await page.keyboard.up("KeyZ");
      await page.keyboard.up("ArrowRight");
      await page.keyboard.up("ArrowUp");
    }),
  );
  const final = await until((s) => s.tick >= held.tick + 30);
  const clients = await read();
  for (const client of clients) {
    assert(client.ready && !client.error && !client.requiresResync);
    assert(client.firearmFeedback.predicted >= 3);
    assert(client.firearmFeedback.promoted >= 3);
    assert.equal(client.firearmFeedback.evicted, 0);
    assert.equal(client.authoritative.lives, 3);
    assert.equal(
      new Set(client.firearmFeedback.items.map((i) => i.id)).size,
      client.firearmFeedback.items.length,
    );
  }
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick >= held.tick + 9 &&
        clients.every((client) =>
          client.receipts.some(
            (other) =>
              other.tick === receipt.tick &&
              other.hash === receipt.hash &&
              other.continuationHash === receipt.continuationHash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 5, "Missing shared final boundaries");
  await pages[0]?.screenshot({ path: `${output}/feedback-complete.png` });
  return { predicted, first, delayed, moving, held, final, clients, common, samples };
}

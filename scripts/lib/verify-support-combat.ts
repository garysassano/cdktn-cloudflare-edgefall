import assert from "node:assert/strict";
import type { Page } from "@playwright/test";
import type { DestructibleState } from "../../src/game/combat/destructible.js";
import type { CombatLab } from "../../src/game/labs/combat.js";
import type { RoomProbeStatus } from "../../src/shared/diagnostics/room-probe-types.js";
import type { CombatSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import { loadRoomIfNeeded, roomHostCommand } from "./room-host-control.js";

interface SupportClient {
  ready: boolean;
  error: string | null;
  requiresResync: boolean;
  snapshotTick: number;
  geometryRevision: number;
  remainingEnemies: number;
  props: DestructibleState[];
  removedIds: number[];
  combatBaseline: CombatSnapshot;
  authoritative: CombatLab["players"][number];
  initialServerTick: number;
  timeline: Array<{ kind: string; lastSequence: number; snapshotTick: number }>;
  receipts: Array<{ tick: number; hash: number; continuationHash: string | null }>;
  events: {
    counts: Record<string, number>;
    duplicates: number;
    receipts: Array<{ cursor: number; tick: number; kind: string; hash: string }>;
  };
}
/** Two actual short taps per keyboard destroy support; no world editing or synthetic tick advance. */
export async function verifySupportCombat(pages: Page[], base: string, output: string) {
  const samples: Array<Pick<CombatLab, "tick" | "props" | "targets" | "encounter">> = [];
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
        !state.clock.fault && !state.worldFailure && !state.persistenceFailure,
        "Support room failed",
      );
      const current = world(state);
      assert(
        current.players.every((player) => player.lives === 3),
        "Unexpected player damage",
      );
      if (samples.at(-1)?.tick !== current.tick)
        samples.push({
          tick: current.tick,
          props: current.props,
          targets: current.targets,
          encounter: current.encounter,
        });
      const removedAt = current.props[0]?.destroyedTick;
      if (removedAt !== null && removedAt !== undefined) {
        const age = current.tick - removedAt;
        for (const target of current.targets)
          if (target.enemy.life === "alive") {
            assert.equal(target.enemy.body.supportId, null);
            assert.equal(target.enemy.body.vy, 55 * age);
            assert.equal(target.enemy.body.y, 160 * 256 + (55 * age * (age + 1)) / 2);
          }
      }
      if (accept(state)) return state;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Support boundary timed out");
  };
  const tap = () => Promise.all(pages.map((page) => page.keyboard.press("KeyZ", { delay: 10 })));
  await loadRoomIfNeeded(base, pages);
  await Promise.all(
    pages.map(async (page) => {
      await page.locator("#scripted").uncheck();
      await page.locator("#prepare").click();
      await page.locator("#game").focus();
    }),
  );
  await tap();
  await until(
    (state) =>
      state.inputStreams.length === 4 &&
      state.inputStreams.every((input) => input.queued === 5 && input.initialBaseline === null),
  );
  assert.equal((await roomHostCommand(base, pages, "start")).status, 200);
  const partial = await until((state) => world(state).props[0]?.health === 4);
  assert(world(partial).players.every((player) => player.weapon.shotOrdinal === 1));
  assert(world(partial).targets.every((target) => target.enemy.body.supportId === 104));
  const page = pages[0];
  assert(page);
  await page.waitForFunction(() => {
    const state = (
      globalThis as unknown as {
        controllerNetworkLab: { status(): SupportClient };
      }
    ).controllerNetworkLab.status();
    return state.props[0]?.health === 4 && state.geometryRevision === 1;
  });
  await pages[0]?.screenshot({ path: `${output}/support-damaged.png` });
  await tap();
  const falling = await until((state) => world(state).props[0]?.health === 0);
  assert(world(falling).targets.every((target) => target.enemy.life === "alive"));
  await page.waitForFunction(() => {
    const state = (
      globalThis as unknown as {
        controllerNetworkLab: { status(): SupportClient };
      }
    ).controllerNetworkLab.status();
    const removedAt = state.props[0]?.destroyedTick;
    return (
      removedAt !== null &&
      removedAt !== undefined &&
      state.geometryRevision === 2 &&
      state.snapshotTick >= removedAt + 6 &&
      state.remainingEnemies === 2
    );
  });
  await page.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const fallingCapture = await page.evaluate(() =>
    (
      globalThis as unknown as {
        controllerNetworkLab: { status(): SupportClient };
      }
    ).controllerNetworkLab.status(),
  );
  assert.equal(fallingCapture.remainingEnemies, 2);
  await page.screenshot({ path: `${output}/support-falling.png` });
  const complete = await until((state) => world(state).encounter.phase === "complete");
  const resolvedTick = world(complete).encounter.members[0]?.resolvedTick;
  assert(resolvedTick);
  const final = await until((state) => world(state).tick >= resolvedTick + 60);
  const accepted = world(final);
  assert(
    accepted.encounter.members.every(
      (member) => member.reason === "out-of-bounds" && member.killerId === null,
    ),
  );
  assert(accepted.encounter.kills.every((kill) => kill.count === 0));
  assert.equal(accepted.encounter.receipts.length, 4);
  assert(accepted.players.every((player) => player.weapon.shotOrdinal === 2));
  const clients = await Promise.all(
    pages.map((page) =>
      page.evaluate(() =>
        (
          globalThis as unknown as {
            controllerNetworkLab: { status(includeTimeline: boolean): SupportClient };
          }
        ).controllerNetworkLab.status(true),
      ),
    ),
  );
  for (const client of clients) {
    assert(client.ready && !client.error && !client.requiresResync);
    assert.equal(client.geometryRevision, 2);
    assert.deepEqual(client.props, accepted.props);
    assert.deepEqual(client.removedIds, [20, 21, 104]);
    assert.equal(client.events.counts["prop-destroyed"], 1);
    assert.equal(client.events.counts.killed ?? 0, 0);
    assert.equal(
      new Set(client.events.receipts.map((event) => event.cursor)).size,
      client.events.receipts.length,
    );
    assert.equal(client.combatBaseline.phase, "complete");
    assert(
      client.combatBaseline.members.every(
        (member) => member.reason === "out-of-bounds" && member.killerId === null,
      ),
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
  const common =
    clients[0]?.receipts.filter(
      (receipt) =>
        receipt.tick >= resolvedTick &&
        clients.every((client) =>
          client.receipts.some(
            (other) => other.tick === receipt.tick && other.hash === receipt.hash,
          ),
        ),
    ) ?? [];
  assert(common.length >= 10, "Missing shared terminal snapshots");
  const commonEvents =
    clients[0]?.events.receipts.filter((event) =>
      clients.every((client) =>
        client.events.receipts.some(
          (other) => other.cursor === event.cursor && other.hash === event.hash,
        ),
      ),
    ) ?? [];
  assert(
    commonEvents.some((event) => event.kind === "prop-destroyed"),
    "Missing shared destruction event",
  );
  return {
    partial,
    falling,
    fallingCapture,
    complete,
    final,
    samples,
    clients,
    common,
    commonEvents,
  };
}

import assert from "node:assert/strict";
import type { Grenade } from "../../src/game/combat/grenade.js";
import type { EventEnvelope } from "../../src/shared/protocol/events.js";
import type { FullSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import {
  DELAYED_ORDNANCE_BOUNDARIES,
  ORDNANCE_BOUNDARIES,
} from "../../test/fixtures/ordnance-proof.js";

export async function verifyStoredOrdnance(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const scenarios = [];
  for (const delayed of [false, true]) {
    const request = async (action: string) => {
      const response = await fetch(
        `${await origin()}/${delayed ? "ordnance-delayed" : "ordnance-press"}/${action}`,
        { method: "POST" },
      );
      assert(response.ok, `Stored ordnance ${action}: ${await response.clone().text()}`);
      return (await response.json()) as {
        instance: string;
        tick: number;
        hash: string;
        archiveRows: number;
        health: number;
        ordnance: {
          grenades: Grenade[];
          platforms: FullSnapshot["platforms"];
          players: FullSnapshot["players"];
        };
        events: EventEnvelope[];
      };
    };
    const boundaries = [];
    for (const tick of [...(delayed ? DELAYED_ORDNANCE_BOUNDARIES : ORDNANCE_BOUNDARIES), 120]) {
      const saved = await request(String(tick));
      assert.equal(saved.tick, tick);
      assert(saved.archiveRows <= 6);
      assert.equal(saved.ordnance.platforms.length, 2);
      assert(
        saved.ordnance.players.every((player) => player.grenadeStock === 9 && player.lives === 3),
      );
      assert.equal(saved.health, 1);
      assert.equal(saved.ordnance.grenades.length, tick < (delayed ? 10 : 5) || tick >= 83 ? 0 : 4);
      assert.equal(saved.events.filter(({ event }) => event.kind === "explosion").length, 0);
      assert.equal(
        saved.events.filter(({ event }) => event.kind === "impact" && event.definitionId === 5)
          .length,
        tick < 83 ? 0 : 4,
      );
      await restart();
      const cold = await request("restore");
      assert.notEqual(cold.instance, saved.instance);
      assert.deepEqual({ ...cold, instance: saved.instance }, saved);
      boundaries.push({ tick, saved, coldInstance: cold.instance });
    }
    scenarios.push({ delayed, boundaries });
  }
  return {
    scenarios,
    rollback:
      "Each segment injected a transaction failure, verified the unchanged prefix, then committed and restored in a fresh workerd process",
  };
}

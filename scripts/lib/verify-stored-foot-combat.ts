import assert from "node:assert/strict";
import type { Grenade } from "../../src/game/combat/grenade.js";
import type { MeleeStrike } from "../../src/game/combat/volume.js";
import type { ControlledActor } from "../../src/game/state.js";
import type { EventEnvelope } from "../../src/shared/protocol/events.js";

export async function verifyStoredFootCombat(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const scenarios = [];
  for (const mode of ["melee", "grenade"] as const) {
    const request = async (action: string) => {
      const response = await fetch(`${await origin()}/foot-${mode}/${action}`, { method: "POST" });
      assert(response.ok, `Stored ${mode} ${action}: ${await response.clone().text()}`);
      return (await response.json()) as {
        instance: string;
        tick: number;
        hash: string;
        players: Pick<ControlledActor, "grenadeStock" | "action">[];
        strikes: MeleeStrike[];
        grenades: Grenade[];
        events: EventEnvelope[];
      };
    };
    const boundaries = [];
    for (const action of ["seed", "release", "active", "finish"]) {
      const saved = await request(action);
      await restart();
      const cold = await request("restore");
      assert.notEqual(cold.instance, saved.instance, "Expected a fresh Worker process");
      assert.deepEqual({ ...cold, instance: saved.instance }, saved);
      if (mode === "melee") {
        assert(saved.players.every((player) => player.grenadeStock === 10));
        if (action === "release" || action === "active") {
          assert.equal(saved.strikes.length, 4);
          assert(
            saved.strikes.every((strike) => strike.hitIds.length === 1 && strike.hitIds[0] === 20),
          );
        }
      } else {
        assert(saved.players.every((player) => player.grenadeStock === 9));
        if (action === "release" || action === "active") {
          assert.equal(saved.grenades.length, 4);
          assert(
            saved.grenades.every(
              (grenade) =>
                grenade.spawnTick === 5 && grenade.bounces === (action === "release" ? 1 : 3),
            ),
          );
        }
        assert.equal(
          saved.events.filter(({ event }) => event.kind === "explosion").length,
          action === "finish" ? 4 : 0,
        );
      }
      if (action === "finish") {
        assert.equal(
          saved.events.filter(({ event }) => event.kind === (mode === "melee" ? "melee" : "throw"))
            .length,
          4,
        );
        assert.deepEqual(
          saved.events
            .filter(({ event }) => event.kind === "killed")
            .map(({ event }) => event.targetId)
            .sort(),
          [20, 21],
        );
        assert.equal(saved.strikes.length + saved.grenades.length, 0);
      }
      boundaries.push({ action, saved, coldInstance: cold.instance });
    }
    scenarios.push({ mode, boundaries });
  }
  return {
    scenarios,
    rollback:
      "Every journal segment was rejected inside its SQLite transaction, its unchanged prefix checked, then committed and recovered in a fresh workerd process",
  };
}

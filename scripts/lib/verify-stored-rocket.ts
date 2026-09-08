import assert from "node:assert/strict";
import type { Rocket } from "../../src/game/combat/rocket.js";
import type { WeaponState } from "../../src/game/state.js";
import { combatRuntimeHash } from "../../src/shared/diagnostics/combat-runtime.js";
import type { ProjectileSnapshot } from "../../src/shared/protocol/snapshot-schema.js";
import {
  ROCKET_COMBAT_BOUNDARIES,
  recordRocketCombat,
} from "../../test/fixtures/rocket-combat-proof.js";

export async function verifyStoredRocket(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const fixture = recordRocketCombat();
  const request = async (action: string) => {
    const response = await fetch(`${await origin()}/rocket-flight/${action}`, { method: "POST" });
    assert(response.ok, `Stored rocket ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      archiveRows: number;
      weapons: WeaponState[];
      rocket: { rockets: Rocket[]; projectiles: ProjectileSnapshot[] };
    };
  };
  const boundaries = [];
  for (const tick of [...ROCKET_COMBAT_BOUNDARIES, 160]) {
    const saved = await request(String(tick)),
      expected = fixture.states[tick];
    assert(expected);
    assert.equal(saved.tick, tick);
    assert(saved.archiveRows <= 6);
    assert.equal(saved.hash, combatRuntimeHash(expected));
    assert.deepEqual(saved.rocket.rockets, expected.combat.rockets);
    assert.deepEqual(saved.rocket.projectiles, expected.snapshot.projectiles);
    assert.deepEqual(
      saved.weapons,
      expected.combat.players.map((p) => p.weapon),
    );
    await restart();
    const cold = await request("restore");
    assert.notEqual(cold.instance, saved.instance);
    assert.deepEqual({ ...cold, instance: saved.instance }, saved);
    boundaries.push({ tick, saved, coldInstance: cold.instance });
  }
  return {
    boundaries,
    rollback:
      "Each journal segment injected a transaction failure and verified the unchanged prefix before committing and restoring in a fresh workerd process.",
  };
}

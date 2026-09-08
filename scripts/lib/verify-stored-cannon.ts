import assert from "node:assert/strict";
import { combatRuntimeHash } from "../../src/shared/diagnostics/combat-runtime.js";
import {
  CANNON_BOUNDARIES,
  CANNON_TICKS,
  recordCannonCombat,
} from "../../test/fixtures/cannon-proof.js";

export async function verifyStoredCannon(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const fixture = recordCannonCombat(),
    boundaries = [];
  const request = async (action: string) => {
    const response = await fetch(`${await origin()}/tank-cannon/${action}`, { method: "POST" });
    assert(response.ok, `Stored cannon ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      archiveRows: number;
      tanks: typeof fixture.state.combat.tanks;
      vehicles: typeof fixture.state.snapshot.vehicles;
      shells: typeof fixture.state.combat.projectiles;
      events: typeof fixture.state.history.entries;
    };
  };
  for (const tick of [...CANNON_BOUNDARIES, CANNON_TICKS]) {
    const saved = await request(String(tick)),
      expected = fixture.states[tick];
    assert(expected);
    assert.equal(saved.tick, tick);
    assert(saved.archiveRows <= 6);
    assert.equal(saved.hash, combatRuntimeHash(expected));
    assert.deepEqual(saved.tanks, expected.combat.tanks);
    assert.deepEqual(saved.vehicles, expected.snapshot.vehicles);
    assert.deepEqual(saved.shells, expected.combat.projectiles);
    assert.deepEqual(saved.events, expected.history.entries);
    await restart();
    const cold = await request("restore");
    assert.notEqual(cold.instance, saved.instance);
    assert.deepEqual({ ...cold, instance: saved.instance }, saved);
    boundaries.push({ tick, saved, coldInstance: cold.instance });
  }
  return {
    boundaries,
    rollback:
      "Each accepted journal segment is first rolled back inside SQLite; each boundary is then compared after a fresh workerd process starts.",
  };
}

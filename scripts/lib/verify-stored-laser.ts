import assert from "node:assert/strict";
import type { AreaExposure } from "../../src/game/combat/area-attack.js";
import type { BeamPulse } from "../../src/game/combat/beam.js";
import type { WeaponState } from "../../src/game/state.js";
import { combatRuntimeHash } from "../../src/shared/diagnostics/combat-runtime.js";
import type { EventEnvelope } from "../../src/shared/protocol/events.js";
import {
  LASER_COMBAT_BOUNDARIES,
  recordLaserCombat,
} from "../../test/fixtures/laser-combat-proof.js";

export async function verifyStoredLaser(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const fixture = recordLaserCombat();
  const request = async (action: string) => {
    const response = await fetch(`${await origin()}/laser-charge/${action}`, { method: "POST" });
    assert(response.ok, `Stored laser ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      archiveRows: number;
      weapons: WeaponState[];
      laser: { beams: BeamPulse[]; volumes: AreaExposure[] };
      events: EventEnvelope[];
    };
  };
  const boundaries = [];
  for (const tick of [...LASER_COMBAT_BOUNDARIES, 72]) {
    const saved = await request(String(tick)),
      expected = fixture.states[tick];
    assert(expected);
    assert.equal(saved.tick, tick);
    assert(saved.archiveRows <= 6);
    assert.equal(saved.hash, combatRuntimeHash(expected));
    assert.deepEqual(saved.laser.beams, expected.combat.beams);
    assert.deepEqual(saved.laser.volumes, expected.snapshot.combat?.volumes);
    assert.deepEqual(
      saved.weapons,
      expected.combat.players.map((p) => p.weapon),
    );
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
      "Each journal segment injected a transaction failure and verified the unchanged prefix before committing and restoring in a fresh workerd process.",
  };
}

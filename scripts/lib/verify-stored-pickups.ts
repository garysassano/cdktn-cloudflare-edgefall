import assert from "node:assert/strict";
import type { WeaponPickupClaim, WeaponPickupState } from "../../src/game/combat/pickups.js";
import type { WeaponState } from "../../src/game/state.js";
import { combatRuntimeHash } from "../../src/shared/diagnostics/combat-runtime.js";
import type { EventEnvelope } from "../../src/shared/protocol/events.js";
import {
  PICKUP_COMBAT_BOUNDARIES,
  PICKUP_COMBAT_TICKS,
  recordPickupCombat,
} from "../../test/fixtures/pickup-combat-proof.js";

export async function verifyStoredPickups(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const fixture = recordPickupCombat();
  const request = async (action: string) => {
    const response = await fetch(`${await origin()}/pickup-travel/${action}`, { method: "POST" });
    assert(response.ok, `Stored pickups ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      archiveRows: number;
      weapons: WeaponState[];
      pickups: {
        state: WeaponPickupState;
        claims: WeaponPickupClaim[];
        public: WeaponPickupState["items"];
      };
      events: EventEnvelope[];
    };
  };
  const boundaries = [];
  for (const tick of [...PICKUP_COMBAT_BOUNDARIES, PICKUP_COMBAT_TICKS]) {
    const saved = await request(String(tick)),
      expected = fixture.states[tick];
    assert(expected);
    assert.equal(saved.tick, tick);
    assert(saved.archiveRows <= 6);
    assert.equal(saved.hash, combatRuntimeHash(expected));
    assert.deepEqual(saved.pickups, {
      state: expected.combat.pickups,
      claims: expected.combat.pickupClaims,
      public: expected.snapshot.combat?.pickups,
    });
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
      "Each journal segment injected a transaction failure and checked the unchanged inventory, latches, claim events and acknowledged prefix before committing and restoring in a fresh workerd process.",
  };
}

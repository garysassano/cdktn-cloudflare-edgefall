import assert from "node:assert/strict";
import type { AreaAttack, AreaExposure } from "../../src/game/combat/area-attack.js";
import { AREA_BOUNDARIES } from "../../test/fixtures/area-proof.js";

export async function verifyStoredArea(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const scenarios = [];
  for (const mode of ["shotgun", "flame"] as const) {
    const request = async (action: string) => {
      const response = await fetch(`${await origin()}/area-${mode}/${action}`, { method: "POST" });
      assert(response.ok, `Stored area ${mode}/${action}: ${await response.clone().text()}`);
      return (await response.json()) as {
        instance: string;
        tick: number;
        hash: string;
        archiveRows: number;
        areas: AreaAttack[];
        volumes: AreaExposure[];
        health: number;
        guard?: { integrity: number };
        weapons: { ammo: number; shotOrdinal: number }[];
        players: { lives: number }[];
        encounter: string;
      };
    };
    const boundaries = [];
    for (const tick of [...AREA_BOUNDARIES[mode], 120]) {
      const saved = await request(String(tick));
      assert.equal(saved.tick, tick);
      assert(saved.archiveRows <= 6);
      assert(
        saved.weapons.every(
          (weapon) => weapon.ammo === (mode === "shotgun" ? 23 : 29) && weapon.shotOrdinal === 1,
        ),
      );
      assert(saved.players.every((player) => player.lives === 3));
      if (mode === "shotgun" && tick >= 5) assert.equal(saved.encounter, "complete");
      if (mode === "flame" && tick === 13) {
        assert.equal(saved.health, 1);
        assert.equal(saved.guard?.integrity, 0);
        assert(saved.areas.every((area) => area.emitted === 3));
      }
      if (tick === 120) assert.deepEqual(saved.areas, []);
      await restart();
      const cold = await request("restore");
      assert.notEqual(cold.instance, saved.instance);
      assert.deepEqual({ ...cold, instance: saved.instance }, saved);
      boundaries.push({ saved, coldInstance: cold.instance });
    }
    scenarios.push({ mode, boundaries });
  }
  return {
    scenarios,
    rollback:
      "Each segment is rolled back inside SQLite, checked for an unchanged prefix, committed and restored in a fresh process; exact lobes, cooldowns, clipped reach and ammunition are retained",
  };
}

import assert from "node:assert/strict";
import type { VehicleState } from "../../src/game/state.js";
import type { TankState } from "../../src/game/vehicles/tank.js";
import { TANK_BOUNDARIES, TANK_DAMAGE_BOUNDARIES } from "../../test/fixtures/tank-proof.js";

export async function verifyStoredTank(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const scenarios = [];
  for (const mode of ["drive", "damage"] as const) {
    const request = async (action: string) => {
      const response = await fetch(`${await origin()}/tank-${mode}/${action}`, { method: "POST" });
      assert(response.ok, `Stored tank ${mode}/${action}: ${await response.clone().text()}`);
      return (await response.json()) as {
        instance: string;
        tick: number;
        hash: string;
        archiveRows: number;
        tanks: TankState[];
        vehicles: VehicleState[];
        players: { lives: number }[];
        encounter: string;
      };
    };
    const boundaries = [];
    for (const tick of [
      ...(mode === "drive" ? TANK_BOUNDARIES : TANK_DAMAGE_BOUNDARIES),
      mode === "drive" ? 120 : 210,
    ]) {
      const saved = await request(String(tick));
      assert.equal(saved.tick, tick);
      assert(saved.archiveRows <= 6);
      assert.equal(saved.tanks.length, 4);
      assert.equal(saved.vehicles.length, 4);
      if (mode === "drive") {
        assert(saved.players.every((player) => player.lives === 3));
        if (tick >= 97)
          assert(
            saved.tanks.every((tank) => tank.lifecycle === "available" && tank.occupantId === null),
          );
        if (tick === 120) assert.equal(saved.encounter, "complete");
      } else if (tick === 183) {
        assert.equal(saved.tanks[3]?.lifecycle, "wreck");
        assert.equal(saved.tanks[3]?.occupantId, null);
        assert.equal(saved.players[3]?.lives, 3);
      } else if (tick === 195) assert.equal(saved.players[3]?.lives, 2);
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
      "Every segment rolls back inside SQLite before commit; each boundary is restored by a fresh process within the six-row archive bound",
  };
}

import assert from "node:assert/strict";
import type { ControlledActor } from "../../src/game/state.js";
import { HMG_BOUNDARIES } from "../../test/fixtures/hmg-proof.js";

export async function verifyStoredHmg(origin: () => Promise<string>, restart: () => Promise<void>) {
  const request = async (action: string) => {
    const response = await fetch(`${await origin()}/hmg-sweep/${action}`, { method: "POST" });
    assert(response.ok, `Stored HMG ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      archiveRows: number;
      hmg: { players: ControlledActor[] };
    };
  };
  const boundaries = [];
  for (const tick of [...HMG_BOUNDARIES, 120]) {
    const saved = await request(String(tick));
    assert.equal(saved.tick, tick);
    assert(saved.archiveRows <= 6);
    const shots = Math.min(20, Math.floor((tick - 1) / 5) + 1);
    assert(
      saved.hmg.players.every(
        (player) =>
          player.weapon.shotOrdinal === shots &&
          player.weapon.ammo === 150 - shots &&
          player.lives === 3 &&
          player.grenadeStock === 10,
      ),
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
      "Each journal segment injected a transaction failure and verified the unchanged prefix before committing and restoring in a fresh workerd process",
  };
}

import assert from "node:assert/strict";
import type { CombatLab } from "../../src/game/labs/combat.js";
import { SUPPORT_BOUNDARIES } from "../../test/fixtures/support-proof.js";

export async function verifyStoredSupport(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const request = async (action: string) => {
    const response = await fetch(`${await origin()}/support-fall/${action}`, { method: "POST" });
    assert(response.ok, `Stored support ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      archiveRows: number;
      support: Pick<CombatLab, "props" | "targets" | "players" | "encounter"> & {
        geometryRevision: number;
      };
    };
  };
  const boundaries = [];
  for (const tick of [...SUPPORT_BOUNDARIES, 120]) {
    const saved = await request(String(tick));
    assert.equal(saved.tick, tick);
    assert(saved.archiveRows <= 6);
    assert.equal(saved.support.geometryRevision, tick < 35 ? 1 : 2);
    if (tick === 11) assert.equal(saved.support.props[0]?.health, 4);
    if (tick >= 35)
      assert.deepEqual(saved.support.props, [
        {
          id: 104,
          definitionId: 1,
          health: 0,
          destroyedTick: 35,
          destroyerId: 1,
          destroyActionId: 7,
        },
      ]);
    if (tick >= 59) {
      assert.equal(saved.support.encounter.phase, "complete");
      assert(
        saved.support.encounter.members.every(
          (member) =>
            member.reason === "out-of-bounds" &&
            member.killerId === null &&
            member.resolvedTick === 59,
        ),
      );
      assert(saved.support.encounter.kills.every((kill) => kill.count === 0));
      assert.equal(saved.support.encounter.receipts.length, 4);
    }
    await restart();
    const cold = await request("restore");
    assert.notEqual(cold.instance, saved.instance);
    assert.deepEqual({ ...cold, instance: saved.instance }, saved);
    boundaries.push({ tick, saved, coldInstance: cold.instance });
  }
  return {
    boundaries,
    rollback:
      "Every journal commit injects a transaction failure, checks the unchanged prefix, then commits and restores from a fresh workerd process.",
  };
}

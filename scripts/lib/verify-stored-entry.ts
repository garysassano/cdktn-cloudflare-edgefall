import assert from "node:assert/strict";
import type { ControlledActor } from "../../src/game/state.js";

export async function verifyStoredEntry(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const request = async (action: string) => {
    const response = await fetch(`${await origin()}/entry-moving/${action}`, { method: "POST" });
    assert(response.ok, `Stored entry ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      players: Pick<
        ControlledActor,
        "life" | "lifeStartTick" | "bodyPresence" | "lives" | "invulnerableTicks" | "body"
      >[];
    };
  };
  const boundaries = [];
  for (const [action, tick, life, presence, lives] of [
    ["seed", 6, "respawning", "present", 3],
    ["crush", 69, "death", "removed", 2],
    ["entry", 105, "respawning", "present", 2],
    ["resume", 114, "alive", "present", 2],
  ] as const) {
    const committed = await request(action);
    assert.equal(committed.tick, tick);
    assert.equal(committed.players.length, 4);
    for (const player of committed.players) {
      assert.equal(player.life, life);
      assert.equal(player.bodyPresence, presence);
      assert.equal(player.lives, lives);
    }
    await restart();
    const restored = await request("restore");
    assert.notEqual(restored.instance, committed.instance);
    assert.equal(restored.hash, committed.hash);
    assert.deepEqual(restored.players, committed.players);
    boundaries.push({ action, committed, restored });
  }
  return {
    boundaries,
    scope:
      "Seeded initial entry; four admitted controllers on the real lift/press, rollback on each attempted segment, four cold SQLite process boundaries through carry, crush, reentry and control.",
  };
}

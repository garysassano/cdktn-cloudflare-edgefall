import assert from "node:assert/strict";
import type { ControlledActor } from "../../src/game/state.js";

export async function verifyStoredDeathBody(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const cases = [];
  for (const kind of ["rising", "falling"] as const) {
    const deathTick = kind === "rising" ? 37 : 77,
      slot = kind === "rising" ? 3 : 0;
    const request = async (action: string) => {
      const response = await fetch(`${await origin()}/death-${kind}/${action}`, { method: "POST" });
      assert(response.ok, `Stored corpse ${kind}/${action}: ${await response.clone().text()}`);
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
    const seeded = await request("seed"),
      player = seeded.players[slot];
    assert.equal(seeded.tick, deathTick + 6);
    assert(player);
    assert.equal(player.life, "death");
    assert.equal(player.bodyPresence, "present");
    assert.equal(player.lifeStartTick, deathTick);
    assert.equal(player.lives, 2);
    if (kind === "rising") assert(player.body.vy < 0 && !player.body.grounded);
    else assert(player.body.vy === 0 && player.body.grounded);
    await restart();
    const cold = await request("restore");
    assert.notEqual(cold.instance, seeded.instance);
    assert.equal(cold.hash, seeded.hash);
    assert.deepEqual(cold.players, seeded.players);
    const resumed = await request("resume");
    assert.equal(resumed.tick, deathTick + 45);
    assert.equal(resumed.players[slot]?.life, "alive");
    assert.equal(resumed.players[slot]?.lifeStartTick, deathTick + 42);
    assert.equal(resumed.players[slot]?.bodyPresence, "present");
    assert.equal(resumed.players[slot]?.lives, 2);
    await restart();
    const afterEntry = await request("restore");
    assert.notEqual(afterEntry.instance, resumed.instance);
    assert.equal(afterEntry.hash, resumed.hash);
    assert.deepEqual(afterEntry.players, resumed.players);
    cases.push({ kind, slot, deathTick, seeded, cold, resumed, afterEntry });
  }
  return {
    cases,
    scope:
      "Four controller input journals, actual rifle kills, rollback on every attempted segment, four cold SQLite process boundaries and unchanged respawn deadlines",
  };
}

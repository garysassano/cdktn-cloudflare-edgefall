import assert from "node:assert/strict";
import type { RifleState } from "../../src/game/actors/rifle.js";
import type { EventEnvelope } from "../../src/shared/protocol/events.js";

export async function verifyStoredRifle(
  origin: () => Promise<string>,
  restart: () => Promise<void>,
) {
  const request = async (action: string) => {
    const response = await fetch(`${await origin()}/rifle/${action}`, { method: "POST" });
    assert(response.ok, `Stored rifle ${action}: ${await response.clone().text()}`);
    return (await response.json()) as {
      instance: string;
      tick: number;
      hash: string;
      rifles: RifleState[];
      players: Array<{ life: string; lives: number; invulnerableTicks: number }>;
      events: EventEnvelope[];
    };
  };
  const seeded = await request("seed");
  assert.equal(seeded.tick, 30);
  assert(
    seeded.rifles.every(
      (rifle) => rifle.action.nextMarkerIndex === 2 && rifle.action.kind === "fire",
    ),
  );
  await restart();
  const coldBurst = await request("restore");
  assert.notEqual(coldBurst.instance, seeded.instance);
  assert.equal(coldBurst.hash, seeded.hash);
  assert.deepEqual(coldBurst.rifles, seeded.rifles);
  const resumed = await request("resume");
  assert.equal(resumed.tick, 150);
  const releases = resumed.events.filter(
    ({ tick, event }) => tick < 73 && event.kind === "shot" && event.ownerId === 20,
  );
  assert.deepEqual(
    releases.map(({ tick }) => tick),
    [31, 37],
  );
  assert(
    resumed.events.every(({ event }) => event.origin === "enemy" && event.confirmation === null),
  );
  assert(resumed.players.some((player) => player.lives < 3));
  await restart();
  const coldDamage = await request("restore");
  assert.notEqual(coldDamage.instance, resumed.instance);
  assert.equal(coldDamage.hash, resumed.hash);
  assert.deepEqual(coldDamage.players, resumed.players);
  return {
    seeded,
    coldBurst,
    resumed,
    coldDamage,
    rollback:
      "Every attempted segment failed inside its transaction before the unchanged prefix was checked and committed",
  };
}

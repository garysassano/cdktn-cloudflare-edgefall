import { describe, expect, it } from "vitest";
import { damagePlayer, enterPlayer, entryBody, stepPlayerLife } from "../src/game/campaign/life.js";
import { pixels } from "../src/game/core/numeric.js";
import { FOOT_FLOOR, FOOT_SHAPES, footActor, footTerrain } from "../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import { ARCADE } from "../src/game/rules.js";
import { playerLifeProof } from "./fixtures/player-life-proof.js";

function context(tick: number, anchors = [{ x: 0, y: 0 }], terrain = [FOOT_FLOOR]) {
  const shape = FOOT_SHAPES.get(1);
  if (!shape) throw new Error("Missing life shape");
  const frame = { tick, geometryRevision: 1 };
  return {
    anchors,
    shape,
    index: new CollisionIndex(new CollisionGrid(terrain), [], frame),
    frame,
  };
}
describe("authoritative player lives", () => {
  it("decrements once per death and preserves a pending respawn across reconstruction", () => {
    const initial = footActor();
    initial.weapon = {
      ...initial.weapon,
      id: "heavy-machine-gun",
      ammo: 23,
      shotOrdinal: 7,
      lastActionInstanceId: 10,
    };
    const killed = damagePlayer(initial, 1, 1, "classic");
    expect(killed.actor).toMatchObject({ life: "death", lifeStartTick: 1, health: 0, lives: 2 });
    expect(killed.notice?.kind).toBe("death");
    expect(damagePlayer(killed.actor, 2, 9, "classic").actor.lives).toBe(2);
    expect(initial.lives).toBe(3);
    const saved = JSON.parse(JSON.stringify(killed.actor));
    expect(stepPlayerLife(saved, 30, "classic", context(30)).actor.life).toBe("death");
    const entered = stepPlayerLife(saved, 31, "classic", context(31));
    expect(entered.actor).toMatchObject({
      life: "respawning",
      lifeStartTick: 31,
      lives: 2,
      health: 1,
      invulnerableTicks: 120,
      weapon: { id: "sidearm", ammo: 0, shotOrdinal: 7, lastActionInstanceId: 10 },
      grenadeStock: 10,
    });
    let current = entered.actor;
    for (let tick = 32; tick <= 43; tick++)
      current = stepPlayerLife(current, tick, "classic", context(tick)).actor;
    expect(current).toMatchObject({
      life: "alive",
      lifeStartTick: 43,
      lives: 2,
      invulnerableTicks: 108,
    });
    expect(damagePlayer(current, 43, 1, "classic").notice).toBeNull();
    for (let tick = 44; tick <= 151; tick++)
      current = stepPlayerLife(current, tick, "classic", context(tick)).actor;
    expect(damagePlayer(current, 151, 1, "classic").actor.lives).toBe(1);
  });
  it("checks footprint and support, waits at blocked anchors, and tries later authored candidates", () => {
    const actor = damagePlayer(footActor(), 1, 1, "classic").actor;
    const blocked = context(31, [{ x: pixels(500), y: 0 }]);
    expect(stepPlayerLife(actor, 31, "classic", blocked).actor).toEqual(actor);
    expect(enterPlayer(actor, 31, "classic", blocked)).toBeNull();
    const collision = context(
      31,
      [
        { x: 0, y: 0 },
        { x: pixels(50), y: 0 },
      ],
      [FOOT_FLOOR, footTerrain(101, -20, -50, 40, 50)],
    );
    expect(entryBody(actor, collision)).toMatchObject({
      x: pixels(50),
      y: 0,
      grounded: true,
      supportId: 100,
    });
    expect(actor.lives).toBe(2);
  });
  it("separates accessible foot health from life count and makes falls lethal despite protection", () => {
    const initial = { ...footActor(), health: 3 };
    const first = damagePlayer(initial, 1, 1, "accessible").actor;
    expect(first).toMatchObject({ health: 2, lives: 3, life: "alive" });
    const second = damagePlayer(first, 2, 1, "accessible").actor;
    expect(second).toMatchObject({ health: 1, lives: 3 });
    expect(damagePlayer(second, 3, 1, "accessible").actor).toMatchObject({ health: 0, lives: 2 });
    expect(
      damagePlayer({ ...initial, invulnerableTicks: 120 }, 1, 1, "accessible", "fall").actor.lives,
    ).toBe(2);
  });
  it("spectates at zero, refuses invalid lifecycle state and cannot release vehicle ownership", () => {
    const last = damagePlayer({ ...footActor(), lives: 1 }, 1, 1, "classic").actor;
    const spectator = stepPlayerLife(last, 1 + ARCADE.deathTicks, "classic", context(31)).actor;
    expect(spectator).toMatchObject({ life: "spectating", health: 0, lives: 0 });
    expect(stepPlayerLife(spectator, 500, "classic", context(500)).actor).toEqual(spectator);
    expect(() => damagePlayer({ ...footActor(), lifeStartTick: 2 }, 1, 1, "classic")).toThrow(
      /life phase tick/,
    );
    expect(() => damagePlayer({ ...footActor(), lives: 0 }, 1, 1, "classic")).toThrow(
      /inconsistent/,
    );
    expect(() => damagePlayer({ ...footActor(), vehicleId: 100 }, 1, 1, "classic")).toThrow(
      /vehicle/,
    );
    expect(() => enterPlayer({ ...last, lives: 1 }, 31, "classic", context(30))).toThrow(
      /tick mismatch/,
    );
  });
  it("consumes three lives through real controller falls and replays death/entry checkpoints exactly", () => {
    const proof = playerLifeProof();
    expect(
      proof.notices.filter((notice) => notice.kind === "death").map((notice) => notice.lives),
    ).toEqual([2, 1, 0]);
    expect(proof.notices.filter((notice) => notice.kind === "respawn")).toHaveLength(2);
    expect(proof.player).toMatchObject({ life: "spectating", lives: 0, health: 0 });
    expect(proof.checkpoints.some((checkpoint) => checkpoint.life === "respawning")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { type Grenade, grenadeLaunchVelocity, stepGrenade } from "../src/game/combat/grenade.js";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_SHAPES, GRENADE_PROFILE } from "../src/game/labs/combat-content.js";
import { combatCollisionIndex } from "../src/game/labs/combat-terrain.js";
import { footActor, footTerrain } from "../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  validateCombatCheckpoint,
} from "../src/shared/diagnostics/combat-checkpoint.js";
import { combatArchiveIdentity } from "./fixtures/combat-recovery-proof.js";
import { recordOrdnance } from "./fixtures/ordnance-proof.js";

function grenadeShape() {
  const value = COMBAT_SHAPES.get(GRENADE_PROFILE.bodyShapeId);
  if (!value) throw new Error("Missing grenade shape");
  return value;
}
const shape = grenadeShape();
function grenade(): Grenade {
  return {
    id: 1000,
    ownerId: 1,
    actionInstanceId: 1,
    definitionId: 5,
    team: 1,
    spawnTick: 1,
    bounces: 3,
    body: { ...footActor(97, 97).body, id: 1000, shapeId: GRENADE_PROFILE.bodyShapeId },
  };
}
function step(current: Grenade, terrain: SweepTarget[], tick = 2) {
  const frame = { tick, geometryRevision: 1 };
  const fixed = terrain.filter((target) => !target.delta.x && !target.delta.y);
  const moving = terrain.filter((target) => target.delta.x || target.delta.y);
  return stepGrenade(
    current,
    GRENADE_PROFILE,
    shape,
    new CollisionIndex(new CollisionGrid(fixed), moving, frame),
    frame,
  );
}
const idle = {
  held: 0,
  firePressed: false,
  grenadePressed: false,
  jumpPressed: false,
  interactPressed: false,
};

describe("grenade launch and moving terrain authority", () => {
  it.each([
    ["standing", 0, 896],
    ["running right", Held.Right, 1664],
    ["running left", Held.Left, -1152],
    ["crouched", Held.Down, 1280],
  ])("inherits the lift once at the actual %s hand release", (_name, held, expected) => {
    let world = createCombatLab("ordnance");
    for (let tick = 1; tick <= 5; tick++)
      world = stepCombatLab(world, [{ ...idle, held, grenadePressed: tick === 1 }]);
    const released = world.grenades[0];
    expect(released?.body.vx).toBe(expected);
    expect(released?.body).toMatchObject({ grounded: false, supportId: null });
    expect(world.players[0]?.grenadeStock).toBe(9);
    expect(world.events.filter((event) => event.kind === "throw")).toHaveLength(1);
  });

  it("inherits vertical body/lift velocity with an explicit bound and rejects stale geometry", () => {
    const frame = { tick: 2, geometryRevision: 1 };
    const lift = { ...footTerrain(100, 0, 100, 200, 8), delta: { x: pixels(3), y: -pixels(2) } };
    const index = new CollisionIndex(new CollisionGrid([]), [lift], frame);
    const actor = footActor(40, 98);
    actor.body.vx = pixels(2);
    expect(grenadeLaunchVelocity(actor, GRENADE_PROFILE, index, frame)).toEqual({
      x: pixels(7) + 128,
      y: -pixels(6) - 128,
    });
    actor.body.grounded = false;
    actor.body.supportId = null;
    actor.body.vy = -pixels(6);
    expect(grenadeLaunchVelocity(actor, GRENADE_PROFILE, index, frame)).toEqual({
      x: pixels(4) + 128,
      y: -pixels(10) - 128,
    });
    actor.body.vx = actor.body.vy = pixels(256);
    expect(grenadeLaunchVelocity(actor, GRENADE_PROFILE, index, frame)).toEqual({
      x: pixels(10) + 128,
      y: pixels(3) + 128,
    });
    expect(() =>
      grenadeLaunchVelocity(actor, GRENADE_PROFILE, index, { ...frame, tick: 3 }),
    ).toThrow("Stale");
  });

  it("carries a settled grenade through lift reversal without storing carry as its own velocity", () => {
    const first = step(grenade(), [
      { ...footTerrain(100, 0, 100, 200, 8), delta: { x: pixels(2), y: -pixels(1) } },
    ]);
    expect(first.status).toBe("active");
    if (first.status !== "active") throw new Error("Missing carried grenade");
    expect(first.grenade.body).toMatchObject({
      x: pixels(99),
      y: pixels(96),
      vx: 0,
      vy: 0,
      supportId: 100,
      grounded: true,
    });
    const next = step(
      first.grenade,
      [{ ...footTerrain(100, 2, 99, 200, 8), delta: { x: -pixels(2), y: pixels(1) } }],
      3,
    );
    expect(next.status).toBe("active");
    if (next.status !== "active") throw new Error("Missing reversed grenade");
    expect(next.grenade.body).toMatchObject({
      x: pixels(97),
      y: pixels(97),
      vx: 0,
      vy: 0,
      supportId: 100,
    });
  });

  it("rebounds relative to a moving surface and detaches before the next carry step", () => {
    const current = grenade();
    current.bounces = 0;
    current.body.vy = pixels(2);
    const result = step(current, [
      { ...footTerrain(100, 0, 100, 200, 8), delta: { x: pixels(2), y: -pixels(1) } },
    ]);
    expect(result.status).toBe("active");
    if (result.status !== "active") throw new Error("Missing rebound");
    expect(result.grenade.bounces).toBe(1);
    expect(result.grenade.body).toMatchObject({
      vx: pixels(2),
      vy: -539,
      grounded: false,
      supportId: null,
    });
    const free = step(result.grenade, [], 3);
    expect(free.status).toBe("active");
    if (free.status !== "active") throw new Error("Missing detached rebound");
    expect(free.grenade.body.x - result.grenade.body.x).toBe(pixels(2));
  });

  it("falls when its support is removed and keeps the original fuse", () => {
    const current = grenade();
    const result = step(current, [], 90);
    expect(result.status).toBe("active");
    if (result.status !== "active") throw new Error("Missing falling grenade");
    expect(result.grenade.body).toMatchObject({
      y: pixels(97) + 55,
      supportId: null,
      grounded: false,
      vy: 55,
    });
    expect(step(result.grenade, [], 91).status).toBe("detonated");
  });

  it("does not add a descending lift's carry again while the rebound separates from it", () => {
    const current = grenade();
    current.bounces = 0;
    const first = step(current, [
      { ...footTerrain(100, 0, 100, 200, 8), delta: { x: pixels(2), y: pixels(2) } },
    ]);
    if (first.status !== "active") throw new Error("Missing downward rebound");
    expect(first.grenade.body).toMatchObject({
      vx: pixels(2),
      vy: 485,
      grounded: false,
      supportId: null,
    });
    // Increase lift descent so gravity cannot close the new separation this tick.
    const next = step(
      first.grenade,
      [{ ...footTerrain(100, 2, 102, 200, 8), delta: { x: pixels(2), y: pixels(3) } }],
      3,
    );
    if (next.status !== "active") throw new Error("Missing detached grenade");
    expect(next.grenade.body).toMatchObject({
      x: first.grenade.body.x + pixels(2),
      y: first.grenade.body.y + 540,
      vx: pixels(2),
      vy: 540,
      grounded: false,
      supportId: null,
    });
  });

  it.each(["vertical", "horizontal"] as const)(
    "settles a proved %s crush without returning a live partial body, even on the fuse tick",
    (axis) => {
      const terrain =
        axis === "vertical"
          ? [
              footTerrain(100, 0, 100, 200, 8),
              { ...footTerrain(101, 0, 90, 200, 4), delta: { x: 0, y: pixels(1) } },
            ]
          : [
              footTerrain(100, 0, 100, 200, 8),
              footTerrain(101, 90, 80, 4, 20),
              { ...footTerrain(102, 100, 80, 4, 20), delta: { x: -pixels(1), y: 0 } },
            ];
      const current = grenade(),
        before = structuredClone(current);
      const result = step(current, terrain, 91);
      expect(result).toMatchObject({
        status: "crushed",
        position: { x: pixels(97), y: pixels(97) },
        colliderIds: axis === "vertical" ? [100, 101] : [101, 102],
      });
      expect("grenade" in result).toBe(false);
      expect(step(current, [...terrain].reverse(), 91)).toEqual(result);
      expect(current).toEqual(before);
    },
  );

  it("keeps unresolved overlap as an error instead of manufacturing a crush or detonation", () => {
    const current = grenade(),
      before = structuredClone(current);
    expect(() => step(current, [footTerrain(100, 80, 80, 40, 40)])).toThrow("initial-overlap");
    expect(current).toEqual(before);
  });

  it("accepts the exact-fit end pose from the browser's later throw, then proves crush on the following tick", () => {
    const current = grenade();
    current.spawnTick = 10;
    current.bounces = 2;
    current.body = {
      ...current.body,
      x: 74656,
      y: 40192,
      vx: 504,
      vy: -343,
      grounded: false,
      supportId: null,
    };
    const frame = { tick: 82, geometryRevision: 1 };
    const fitted = stepGrenade(
      current,
      GRENADE_PROFILE,
      shape,
      combatCollisionIndex("ordnance", frame),
      frame,
    );
    expect(fitted.status).toBe("active");
    if (fitted.status !== "active") throw new Error("Exact fit was rejected");
    expect(fitted.grenade.body.y).toBe(40192);
    const nextFrame = { tick: 83, geometryRevision: 1 };
    expect(
      stepGrenade(
        fitted.grenade,
        GRENADE_PROFILE,
        shape,
        combatCollisionIndex("ordnance", nextFrame),
        nextFrame,
      ).status,
    ).toBe("crushed");
  });

  it("commits four crush impacts, distinct stocks and exact platform recovery after real admitted inputs", async () => {
    const fixture = recordOrdnance(),
      before = fixture.states[82],
      after = fixture.states[83];
    if (!before || !after) throw new Error("Missing press boundary");
    expect(before.combat.grenades).toHaveLength(4);
    expect(after.combat.grenades).toHaveLength(0);
    expect(
      after.combat.events.map((event) => [event.kind, event.ownerId, event.impact?.damage]),
    ).toEqual([
      ["impact", 1, 0],
      ["impact", 2, 0],
      ["impact", 3, 0],
      ["impact", 4, 0],
    ]);
    expect(after.combat.players.map((player) => [player.grenadeStock, player.lives])).toEqual(
      Array(4).fill([9, 3]),
    );
    expect(
      fixture.states
        .flatMap((state) => state.combat.events)
        .filter((event) => event.kind === "explosion"),
    ).toHaveLength(0);
    expect(fixture.state.combat.targets.every((target) => target.health === 1)).toBe(true);
    expect(
      fixture.states.some((state) =>
        state.combat.targets.some((target) => target.enemy.body.contacts.length > 1),
      ),
    ).toBe(true);
    expect(fixture.duplicates).toBe(480);
    const identity = await combatArchiveIdentity();
    const restored = await decodeCombatCheckpoint(
      await encodeCombatCheckpoint(before, identity),
      identity,
    );
    expect(canonical(restored)).toBe(canonical(before));
    for (const state of fixture.states) validateCombatCheckpoint(state);
    const forged = structuredClone(before);
    if (!forged.snapshot.platforms[0]) throw new Error("Missing platform");
    forged.snapshot.platforms[0].x++;
    expect(() => validateCombatCheckpoint(forged)).toThrow();
    const frame = { tick: 83, geometryRevision: 1 };
    expect(combatCollisionIndex("ordnance", frame).get(103)?.delta.y).toBe(pixels(2));
  });
});

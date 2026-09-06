import { describe, expect, it } from "vitest";
import {
  type RoutedEnemy,
  RoutedEnemyDriver,
  createRoutedEnemy,
} from "../src/game/actors/routed.js";
import { stepFootController } from "../src/game/controller/foot.js";
import { pixels } from "../src/game/core/numeric.js";
import {
  FOOT_DEFINITION,
  FOOT_SHAPES,
  footActor,
  footState,
  footTerrain,
} from "../src/game/labs/foot-fixture.js";
import { routeFixture } from "../src/game/labs/route.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";

const bounds = { x: pixels(-30), y: pixels(-80), w: pixels(700), h: pixels(470) };
function fixture() {
  const context = routeFixture();
  const actor = footState(50, 300);
  actor.body.id = 2;
  return {
    ...context,
    enemy: createRoutedEnemy(actor, context.destination),
    driver: new RoutedEnemyDriver(context.graph, FOOT_SHAPES, bounds),
  };
}
function index(targets: SweepTarget[], tick: number, geometryRevision = 1) {
  const frame = { tick, geometryRevision };
  return new CollisionIndex(
    new CollisionGrid(targets.filter((t) => t.delta.x === 0 && t.delta.y === 0)),
    targets.filter((t) => t.delta.x !== 0 || t.delta.y !== 0),
    frame,
  );
}
describe("enemy-owned shared navigation", () => {
  it("uses locomotion-only state and matches player physics without adding player identity", () => {
    if (!FOOT_DEFINITION) throw new Error("Missing definition");
    const enemy = footState(50, 300);
    const player = footActor(50, 300);
    const geometry = index([footTerrain(100, 0, 300, 100, 40)], 1);
    const intent = { held: 2, jumpPressed: true };
    const a = stepFootController(
      enemy,
      intent,
      FOOT_DEFINITION,
      FOOT_SHAPES,
      geometry,
      geometry.frame,
    );
    const b = stepFootController(
      player,
      intent,
      FOOT_DEFINITION,
      FOOT_SHAPES,
      geometry,
      geometry.frame,
    );
    if (a.status !== "complete" || b.status !== "complete") throw new Error("Controller failed");
    expect(a.actor.body).toEqual(b.actor.body);
    expect(a.actor).not.toHaveProperty("playerId");
    expect(a.actor).not.toHaveProperty("weapon");
    expect(a.actor).not.toHaveProperty("processedEdgeIds");
    expect(enemy.body.y).toBe(pixels(300));
  });
  it("routes an enemy independently and restores both actor and driver cache every tick", () => {
    const { enemy: initial, driver, graph, targets, destination } = fixture();
    let enemy: RoutedEnemy = initial;
    let starts = 0;
    for (let tick = 1; tick <= 130; tick++) {
      const geometry = index(targets, tick);
      const result = driver.step(enemy, destination, geometry, geometry.frame);
      const restored = new RoutedEnemyDriver(
        tick === 60 ? routeFixture().graph : graph,
        FOOT_SHAPES,
        bounds,
      ).step(JSON.parse(JSON.stringify(enemy)), destination, geometry, geometry.frame);
      expect(restored).toEqual(result);
      if (result.status !== "complete") throw new Error("Enemy failed");
      enemy = result.enemy;
      starts += result.events.filter((event) => event.kind === "route-started").length;
    }
    expect(starts).toBe(1);
    expect(enemy.status).toBe("arrived");
    expect(enemy.actor.body.x).toBe(destination.x);
    expect(enemy.actor.body.supportId).toBe(102);
    expect(enemy.actor.body.id).toBe(2);
    expect(enemy.plans).toBe(1);
    expect(enemy.actor).not.toHaveProperty("playerId");
  });
  it("throttles unreachable goals and never follows a goal vertically", () => {
    const { enemy: initial, driver, targets } = fixture();
    const goal = { x: pixels(80), y: pixels(200), facing: 1 as const };
    let enemy: RoutedEnemy = { ...initial, goal };
    for (let tick = 1; tick <= 90; tick++) {
      const geometry = index(targets, tick);
      const result = driver.step(enemy, goal, geometry, geometry.frame);
      if (result.status !== "complete") throw new Error("Enemy failed");
      enemy = result.enemy;
      expect(enemy.actor.body.y).toBe(pixels(300));
      expect(enemy.actor.body.grounded).toBe(true);
    }
    expect(enemy.status).toBe("unreachable");
    expect(enemy.plans).toBe(3);
  });
  it("cancels a changed goal in flight, lands under gravity, then replans from its actual root", () => {
    const { enemy: initial, driver, targets, destination } = fixture();
    let enemy = initial;
    let cancellations = 0;
    const replacement = { x: pixels(80), y: pixels(300), facing: 1 as const };
    for (let tick = 1; tick <= 100; tick++) {
      const geometry = index(targets, tick);
      const result = driver.step(
        enemy,
        tick <= 10 ? destination : replacement,
        geometry,
        geometry.frame,
      );
      if (result.status !== "complete") throw new Error("Enemy failed");
      if (tick === 11)
        expect(result.enemy.actor.body.y).toBe(enemy.actor.body.y + enemy.actor.body.vy + 55);
      cancellations += result.events.filter((event) => event.kind === "route-cancelled").length;
      enemy = result.enemy;
    }
    expect(cancellations).toBe(1);
    expect(enemy.status).toBe("arrived");
    expect(enemy.actor.body.x).toBe(replacement.x);
    expect(enemy.plans).toBe(2);
  });
  it("waits for a current catalog, keeps gravity, and resolves out-of-bounds once", () => {
    const { enemy: initial, driver, destination } = fixture();
    let enemy = initial;
    let removals = 0;
    for (let tick = 1; tick <= 100; tick++) {
      const geometry = index([], tick, 2);
      const result = driver.step(enemy, destination, geometry, geometry.frame);
      if (result.status !== "complete") throw new Error("Enemy failed");
      enemy = result.enemy;
      removals += result.events.filter((event) => event.kind === "removed").length;
    }
    expect(enemy.status).toBe("removed");
    expect(enemy.removalReason).toBe("out-of-bounds");
    expect(removals).toBe(1);
    expect(enemy.plans).toBe(0);
  });
  it("separates proven crush removal from failed authored overlap", () => {
    const { enemy: initial, driver } = fixture();
    const actor = {
      ...initial.actor,
      body: { ...initial.actor.body, x: pixels(320), supportId: 102 },
    };
    const enemy = createRoutedEnemy(actor, { x: actor.body.x, y: actor.body.y, facing: 1 });
    const floor = footTerrain(102, 280, 300, 220, 40);
    const geometry = index(
      [floor, { ...footTerrain(200, 280, 260, 220, 4), delta: { x: 0, y: pixels(3) } }],
      1,
      2,
    );
    const crushed = driver.step(enemy, enemy.goal, geometry, geometry.frame);
    expect(crushed.status === "complete" && crushed.enemy.removalReason).toBe("crushed");
    const overlap = index([footTerrain(200, 280, 280, 220, 40)], 1, 2);
    const failure = driver.step(enemy, enemy.goal, overlap, overlap.frame);
    expect(failure.status).toBe("failed");
    expect(failure).not.toHaveProperty("enemy");
  });
});

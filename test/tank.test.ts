import { describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { COMBAT_CATALOG, COMBAT_SHAPES, TANK_PROFILE } from "../src/game/labs/combat-content.js";
import { footActor, footTerrain } from "../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import {
  attachTankDriver,
  createTank,
  moveTank,
  releaseTank,
  requestTankExit,
  reserveTank,
  stepTankTransfer,
  tankExitBody,
} from "../src/game/vehicles/tank.js";

const floor = footTerrain(100, 0, 200, 384, 16);
function footShape() {
  const shape = COMBAT_SHAPES.get(1);
  if (!shape) throw new Error("Missing foot shape");
  return shape;
}
const shape = footShape();
function geometry(tick: number, terrain = [floor], moving: SweepTarget[] = []) {
  const frame = { tick, geometryRevision: 1 };
  return { frame, index: new CollisionIndex(new CollisionGrid(terrain), moving, frame) };
}
function boarding() {
  const tank = createTank(30, { x: pixels(60), y: pixels(200) }, 100, TANK_PROFILE),
    player = footActor(30, 200);
  const { index, frame } = geometry(1);
  expect(reserveTank(tank, player, 1, 1, TANK_PROFILE, COMBAT_SHAPES, index, frame)).toBe(true);
  return { tank, player };
}
function occupied() {
  const state = boarding();
  for (let tick = 1; tick <= 12; tick++) {
    const { index, frame } = geometry(tick);
    stepTankTransfer(
      state.tank,
      state.player,
      tick,
      TANK_PROFILE,
      COMBAT_CATALOG,
      shape,
      index,
      frame,
    );
  }
  return state;
}
describe("tank controller and one-seat lifecycle", () => {
  it("reserves atomically, rejects a second claim and grants control only at the boarding marker", () => {
    const { tank, player } = boarding(),
      second = footActor(34, 200),
      before = canonical(tank);
    second.playerId = second.body.id = 2;
    const { index, frame } = geometry(1);
    expect(reserveTank(tank, second, 1, 2, TANK_PROFILE, COMBAT_SHAPES, index, frame)).toBe(false);
    expect(canonical(tank)).toBe(before);
    expect(second.vehicleId).toBeNull();
    expect(tank).toMatchObject({
      lifecycle: "boarding",
      reservedBy: 1,
      occupantId: null,
      controlEpoch: 2,
    });
    for (let tick = 1; tick <= 12; tick++) {
      const g = geometry(tick);
      const result = stepTankTransfer(
        tank,
        player,
        tick,
        TANK_PROFILE,
        COMBAT_CATALOG,
        shape,
        g.index,
        g.frame,
      );
      expect(result).toBe(tick === 12 ? "board" : null);
      expect(tank.occupantId).toBe(tick === 12 ? 1 : null);
    }
    expect(player).toMatchObject({
      vehicleId: 30,
      locomotion: "seated",
      action: { kind: "ready" },
    });
  });

  it("uses actual grounded motion and a bounded jump, with the seat following both axes", () => {
    const state = occupied();
    let tank = state.tank,
      airborne = false;
    for (let tick = 13; tick <= 70; tick++) {
      const { index, frame } = geometry(tick);
      const moved = moveTank(
        tank,
        { held: tick < 30 ? Held.Right : 0, jumpPressed: tick === 15 },
        TANK_PROFILE,
        COMBAT_SHAPES,
        index,
        frame,
      );
      expect(moved.fault).toBeNull();
      tank = moved.tank;
      attachTankDriver(tank, state.player, TANK_PROFILE);
      expect(state.player.body.x).toBe(tank.body.x);
      expect(state.player.body.y).toBe(tank.body.y - pixels(6));
      airborne ||= !tank.body.grounded;
    }
    expect(airborne).toBe(true);
    expect(tank.body).toMatchObject({
      x: pixels(111),
      y: pixels(200),
      grounded: true,
      supportId: 100,
    });
  });

  it("keeps hull facing independent from the eight authored turret directions", () => {
    let { tank } = occupied();
    const headings = [];
    for (let tick = 13; tick <= 22; tick++) {
      const { index, frame } = geometry(tick);
      tank = moveTank(
        tank,
        { held: Held.Left | Held.Up, jumpPressed: false },
        TANK_PROFILE,
        COMBAT_SHAPES,
        index,
        frame,
      ).tank;
      headings.push(tank.heading);
      expect(tank.facing).toBe(-1);
    }
    expect(headings).toEqual([1, 1, 1, 2, 2, 2, 3, 3, 3, 3]);
  });

  it("checks the full ejection path, allows landing contact and enforces reboard cooldown", () => {
    const { tank, player } = occupied(),
      { index, frame } = geometry(13);
    expect(tankExitBody(tank, player, TANK_PROFILE, shape, index, frame)).toMatchObject({
      x: pixels(90),
      y: pixels(200),
      supportId: 100,
    });
    expect(requestTankExit(tank, player, 13, 2, TANK_PROFILE, shape, index, frame)).toBe(true);
    for (let tick = 13; tick <= 20; tick++) {
      const g = geometry(tick);
      expect(
        stepTankTransfer(tank, player, tick, TANK_PROFILE, COMBAT_CATALOG, shape, g.index, g.frame),
      ).toBe(tick === 20 ? "exit" : null);
    }
    expect(tank).toMatchObject({
      lifecycle: "available",
      occupantId: null,
      reservedBy: null,
      controlEpoch: 3,
    });
    expect(player).toMatchObject({
      vehicleId: null,
      reboardCooldownTicks: 30,
      invulnerableTicks: 12,
    });
    expect(reserveTank(tank, player, 21, 3, TANK_PROFILE, COMBAT_SHAPES, index, frame)).toBe(false);
  });

  it("tries the opposite landing pad, then rejects a completely blocked voluntary exit", () => {
    const { tank, player } = occupied();
    const right = footTerrain(101, 83, 140, 4, 60),
      left = footTerrain(102, 33, 140, 4, 60),
      ceiling = footTerrain(103, 0, 120, 128, 12);
    const opposite = geometry(13, [floor, right]);
    expect(tankExitBody(tank, player, TANK_PROFILE, shape, opposite.index, opposite.frame)?.x).toBe(
      pixels(30),
    );
    const blocked = geometry(13, [floor, right, left, ceiling]),
      before = canonical({ tank, player });
    expect(
      requestTankExit(tank, player, 13, 2, TANK_PROFILE, shape, blocked.index, blocked.frame),
    ).toBe(false);
    expect(canonical({ tank, player })).toBe(before);
    expect(releaseTank(tank, player, 13, TANK_PROFILE, shape, blocked.index, blocked.frame)).toBe(
      false,
    );
    expect(tank.occupantId).toBeNull();
    expect(player.vehicleId).toBeNull();
  });

  it("carries a resting tank on a moving support and checks exit at the support's endpoint", () => {
    const { tank, player } = occupied();
    tank.body.supportId = 200;
    const platform = { ...footTerrain(200, 0, 200, 384, 16), delta: { x: pixels(2), y: 0 } };
    const { index, frame } = geometry(13, [], [platform]);
    const result = moveTank(
      tank,
      { held: 0, jumpPressed: false },
      TANK_PROFILE,
      COMBAT_SHAPES,
      index,
      frame,
    );
    expect(result.fault).toBeNull();
    expect(result.tank.body.x).toBe(pixels(62));
    attachTankDriver(result.tank, player, TANK_PROFILE);
    expect(tankExitBody(result.tank, player, TANK_PROFILE, shape, index, frame)).toMatchObject({
      x: pixels(92),
      supportId: 200,
    });
  });

  it("reports a real moving-platform crush without mutating the accepted tank", () => {
    const { tank } = occupied();
    tank.body.supportId = 200;
    const before = canonical(tank),
      platform = { ...footTerrain(200, 0, 200, 384, 16), delta: { x: 0, y: -pixels(4) } };
    const { index, frame } = geometry(13, [footTerrain(101, 0, 150, 384, 24)], [platform]);
    expect(
      moveTank(tank, { held: 0, jumpPressed: false }, TANK_PROFILE, COMBAT_SHAPES, index, frame)
        .fault?.reason,
    ).toBe("crushed");
    expect(canonical(tank)).toBe(before);
  });
});

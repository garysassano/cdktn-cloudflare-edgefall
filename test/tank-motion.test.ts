import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import { Held } from "../src/game/input/types.js";
import { type CombatCommand, createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { COMBAT_SHAPES, TANK_PROFILE } from "../src/game/labs/combat-content.js";
import { footTerrain } from "../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import { createTank, moveTank } from "../src/game/vehicles/tank.js";
import { tankPresentation } from "../src/shared/animation/cast.js";
import type { NativeAtlas } from "../src/shared/animation/native.js";
import { advanceTankMotion, initialTankMotion } from "../src/shared/animation/tank-motion.js";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing tank acting fixture");
  return value;
}
const atlas = JSON.parse(
  await readFile("public/assets/art/vehicles/kestrel.atlas.json", "utf8"),
) as NativeAtlas;
const floor = footTerrain(100, 0, 200, 384, 16);
const neutral: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  interactPressed: false,
};
function physics(initial = createTank(30, { x: 100 * 256, y: 200 * 256 }, 100, TANK_PROFILE)) {
  let tank = initial,
    tick = 0,
    motion = initialTankMotion(tank, tick);
  tank.lifecycle = "occupied";
  const read = () => ({ tank, tick, motion, frames: tankPresentation(tank, tick, atlas, motion) });
  return {
    read,
    step(held = 0, jumpPressed = false, terrain = [floor], moving: SweepTarget[] = []) {
      const before = tank,
        stable = canonical(before),
        frame = { tick: ++tick, geometryRevision: 1 };
      const moved = moveTank(
        tank,
        { held, jumpPressed },
        TANK_PROFILE,
        COMBAT_SHAPES,
        new CollisionIndex(new CollisionGrid(terrain), moving, frame),
        frame,
      );
      expect(moved.fault).toBeNull();
      tank = moved.tank;
      const after = canonical(tank);
      motion = advanceTankMotion(before, tank, motion, tick);
      expect(canonical(before)).toBe(stable);
      expect(canonical(tank)).toBe(after);
      return { ...read(), jumpAccepted: moved.jumpAccepted };
    },
  };
}
describe("accepted Kestrel suspension and independent treads", () => {
  it.each([Held.Left, Held.Right])(
    "shows eight tread exposures, retains the phase when stopped, and holds it in flight: %s",
    (held) => {
      const run = physics(),
        seen = new Set<string>();
      for (let i = 0; i < 16; i++) seen.add(required(run.step(held).frames[0]).frame);
      expect(seen.size).toBe(8);
      const phase = run.step(held).motion.strideQ;
      const stopped = run.step();
      expect(stopped.motion.strideQ).toBe(phase);
      expect(stopped.frames[1]?.frame).toBe("p1/kestrel-hull-idle");
      for (let i = 0; i < 8; i++) expect(run.step(held, i === 0).motion.strideQ).toBe(phase);
    },
  );
  it("shows launch, rise, apex, fall and four heavy-impact drawings without moving any layer off the accepted root", () => {
    const run = physics(),
      phases: string[] = [],
      hulls = new Set<string>(),
      impact = [];
    for (let i = 0; i < 50; i++) {
      const value = run.step(0, i === 0),
        { motion, tank, frames } = value;
      if (motion.airPhase && phases.at(-1) !== motion.airPhase) phases.push(motion.airPhase);
      hulls.add(required(frames[1]).frame);
      if (motion.impact) impact.push(required(frames[1]).frame);
      expect(frames).toHaveLength(4);
      for (const frame of frames)
        expect([frame.x, frame.y]).toEqual([
          Math.round(tank.body.x / 256),
          Math.round(tank.body.y / 256),
        ]);
    }
    expect(phases).toEqual(["launch", "rise", "apex", "fall"]);
    expect(hulls.size).toBe(13);
    expect(impact).toEqual(
      ["touch", "absorb", "absorb", "rise", "settle"].map((s) => `p1/kestrel-hull-impact-${s}`),
    );
  });
  it("does not animate idle platform carry or grounded contact as driving or landing", () => {
    const tank = createTank(30, { x: 100 * 256, y: 160 * 256 }, 102, TANK_PROFILE),
      run = physics(tank);
    for (let i = 0; i < 6; i++) {
      const support = { ...footTerrain(102, 60 + i * 2, 160, 180, 12), delta: { x: 512, y: 0 } };
      const value = run.step(0, false, [], [support]);
      expect(value.tank.body.x).toBe((100 + (i + 1) * 2) * 256);
      expect(value.motion).toMatchObject({ strideQ: 0, landTick: null, impact: null });
      expect(value.frames[1]?.frame).toBe("p1/kestrel-hull-idle");
    }
  });
  it("stops tread motion on an accepted wall block", () => {
    const run = physics(),
      wall = footTerrain(101, 140, 0, 16, 200);
    for (let i = 0; i < 30; i++) run.step(Held.Right, false, [floor, wall]);
    const before = run.read(),
      after = run.step(Held.Right, false, [floor, wall]);
    expect(after.tank.body.vx).toBe(0);
    expect(after.tank.body.x).toBe(before.tank.body.x);
    expect(after.motion.strideQ).toBe(before.motion.strideQ);
  });
  it("uses a light landing for a short physical fall and does not invent a launch or apex", () => {
    const tank = createTank(30, { x: 100 * 256, y: 197 * 256 }, null, TANK_PROFILE),
      run = physics(tank),
      seen = [];
    for (let i = 0; i < 15; i++) {
      const value = run.step();
      expect(["launch", "apex"]).not.toContain(value.motion.airPhase);
      if (value.motion.impact) {
        expect(value.motion.impact).toBe("light");
        seen.push(value.frames[1]?.frame);
      }
    }
    expect(seen).toEqual(["touch", "rise", "settle"].map((s) => `p1/kestrel-hull-impact-${s}`));
  });
  it("enters descent immediately after real ceiling contact", () => {
    const run = physics(),
      ceiling = footTerrain(101, 50, 152, 120, 8);
    let contact = false;
    for (let i = 0; i < 20; i++) {
      const before = run.read(),
        after = run.step(0, i === 0, [floor, ceiling]);
      if (before.tank.body.vy < -96 && after.tank.body.vy === 0 && !after.tank.body.grounded) {
        contact = true;
        expect(after.motion.airPhase).toBe("fall");
        expect(after.frames[1]?.frame).toBe("p1/kestrel-hull-fall-reach");
      }
    }
    expect(contact).toBe(true);
  });
  it.each([Held.Left, Held.Right])(
    "continues drive on impact and accepts an immediate new jump: %s",
    (held) => {
      const run = physics();
      run.step(0, true);
      while (!run.read().tank.body.grounded) run.step();
      const landed = run.read(),
        moved = run.step(held);
      expect(moved.tank.body.x - landed.tank.body.x).toBe((held === Held.Left ? -3 : 3) * 256);
      expect(moved.motion.strideQ).not.toBe(landed.motion.strideQ);
      expect(moved.motion.impact).toBe("heavy");
      const jumped = run.step(held, true);
      expect(jumped.jumpAccepted).toBe(true);
      expect(jumped.motion).toMatchObject({ airPhase: "launch", landTick: null, impact: null });
    },
  );
  it("handles coyote and buffered jumps without inventing a grounded boundary", () => {
    const run = physics(),
      ledge = footTerrain(100, 0, 200, 110, 16);
    while (run.read().tank.body.grounded) run.step(Held.Right, false, [ledge]);
    expect(run.step(Held.Right, true, [ledge]).motion.airPhase).toBe("launch");
    const bounce = physics();
    bounce.step(0, true);
    let buffered = false;
    for (let i = 0; i < 50; i++) {
      const before = bounce.read(),
        after = bounce.step(0, before.tank.body.vy > 0 && before.tank.body.y >= 190 * 256);
      if (before.tank.body.vy > 0 && after.tank.body.vy < 0) {
        buffered = true;
        expect(after.motion).toMatchObject({ airPhase: "launch", impact: null });
        break;
      }
    }
    expect(buffered).toBe(true);
  });
  it("resets a replacement body and a wreck, while a seat epoch preserves the physical clock", () => {
    const run = physics();
    run.step(Held.Right);
    const { tank, motion, tick } = run.read(),
      next = structuredClone(tank);
    next.controlEpoch++;
    next.body.vx = 0;
    expect(advanceTankMotion(tank, next, motion, tick + 1).strideQ).toBe(motion.strideQ);
    next.body.id++;
    expect(advanceTankMotion(tank, next, motion, tick + 1).strideQ).toBe(0);
    next.body.id = tank.body.id;
    next.lifecycle = "wreck";
    const wreck = advanceTankMotion(tank, next, motion, tick + 1);
    expect(wreck).toMatchObject({ strideQ: 0, airPhase: null, impact: null });
    expect(tankPresentation(next, tick + 1, atlas, wreck)).toHaveLength(1);
  });
  it.each(
    Array.from({ length: 16 }, (_, i) => ({
      heading: i % 8,
      facing: i < 8 ? (1 as const) : (-1 as const),
    })),
  )(
    "keeps the drawn muzzle at actual releases through jump and impact: $heading / $facing",
    ({ heading, facing }) => {
      let world = createCombatLab("tank");
      for (let i = 0; i < 12; i++)
        world = stepCombatLab(world, [{ ...neutral, interactPressed: i === 0 }]);
      let tank = required(world.tanks[0]);
      tank.heading = heading;
      tank.facing = facing;
      let motion = initialTankMotion(tank, world.tick),
        releases = 0;
      const recoils = new Set<string>();
      for (let i = 0; i < 46; i++) {
        const before = tank;
        world = stepCombatLab(world, [
          { ...neutral, held: Held.Fire, firePressed: i === 0, jumpPressed: i === 0 },
        ]);
        tank = required(world.tanks[0]);
        motion = advanceTankMotion(before, tank, motion, world.tick);
        const frames = tankPresentation(tank, world.tick, atlas, motion),
          turret = required(frames[2]);
        expect(turret.flipX).toBe(false);
        expect(frames[0]?.flipX).toBe(facing === -1);
        recoils.add(turret.frame);
        for (const e of world.events.filter(
          (e) => e.kind === "shot" && e.source?.definitionId === 16,
        )) {
          expect(turret.frame).toBe(`p1/kestrel-turret-${heading}`);
          const muzzle = required(
            atlas.meta.edgefall.drawings[`kestrel-turret-${heading}`]?.sockets?.muzzle,
          );
          expect(e.position).toEqual({
            x: tank.body.x + muzzle[0] * 256,
            y: tank.body.y + muzzle[1] * 256,
          });
          releases++;
        }
      }
      expect(releases).toBeGreaterThan(0);
      expect(recoils.size).toBe(3);
    },
  );
});

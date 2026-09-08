import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { stepFootController } from "../src/game/controller/foot.js";
import { canonical } from "../src/game/core/canonical.js";
import { Held } from "../src/game/input/types.js";
import { type CombatCommand, createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import {
  FOOT_DEFINITION,
  FOOT_FLOOR,
  FOOT_SHAPES,
  footActor,
  footTerrain,
} from "../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import type { ControlledActor, WeaponId } from "../src/game/state.js";
import type { NativeAtlas } from "../src/shared/animation/native.js";
import { operativePresentation } from "../src/shared/animation/operative.js";
import {
  advanceOperativeMotion,
  initialOperativeMotion,
} from "../src/shared/animation/operative-motion.js";

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing air fixture value");
  return value;
}

const atlas = JSON.parse(
  await readFile("public/assets/art/hero/operative.atlas.json", "utf8"),
) as NativeAtlas;
const neutral: CombatCommand = {
  held: 0,
  jumpPressed: false,
  firePressed: false,
  grenadePressed: false,
  specialPressed: false,
  interactPressed: false,
};
function combat(weapon: WeaponId = "sidearm", facing: 1 | -1 = 1) {
  let world = createCombatLab("range"),
    actor = world.players[0];
  if (!actor) throw Error("Missing actor");
  actor.weapon = { ...actor.weapon, id: weapon, ammo: 200 };
  actor.facing = facing;
  let motion = initialOperativeMotion(actor, 0);
  const read = () => ({
    world,
    actor: required(world.players[0]),
    motion,
    frame: required(operativePresentation(required(world.players[0]), world.tick, atlas, motion)),
  });
  return {
    read,
    step: (command: Partial<CombatCommand> = {}) => {
      const before = required(world.players[0]);
      world = stepCombatLab(world, [{ ...neutral, ...command }]);
      const stable = canonical(world);
      motion = advanceOperativeMotion(
        before,
        required(world.players[0]),
        motion,
        world.tick,
        atlas,
      );
      const result = read();
      expect(canonical(world)).toBe(stable);
      return result;
    },
  };
}
function physics(initial = footActor(), terrain = [FOOT_FLOOR]) {
  let actor = initial,
    tick = 0,
    motion = initialOperativeMotion(actor, 0);
  const read = () => ({
    actor,
    tick,
    motion,
    frame: required(operativePresentation(actor, tick, atlas, motion)),
  });
  return {
    read,
    step: (held = 0, jumpPressed = false) => {
      const before = actor,
        stable = canonical(before),
        frame = { tick: ++tick, geometryRevision: 1 };
      const index = new CollisionIndex(new CollisionGrid(terrain), [], frame);
      const result = stepFootController(
        before,
        { held, jumpPressed },
        required(FOOT_DEFINITION),
        FOOT_SHAPES,
        index,
        frame,
      );
      if (result.status !== "complete") throw Error("Physical fixture failed");
      actor = result.actor;
      motion = advanceOperativeMotion(before, actor, motion, tick, atlas);
      expect(canonical(before)).toBe(stable);
      return { ...read(), events: result.events };
    },
  };
}
function land(run: ReturnType<typeof combat>) {
  run.step({ jumpPressed: true });
  let result = run.read();
  while (!result.actor.body.grounded && result.world.tick < 120) result = run.step();
  expect(result.actor.body.grounded).toBe(true);
  return result;
}

describe("accepted operative air and landing presentation", () => {
  it("shows all eight launch/rise/apex/fall drawings at a fixed accepted root", () => {
    const run = combat(),
      seen = new Set<string>(),
      phases: string[] = [],
      roots = [];
    for (let tick = 1; tick <= 60; tick++) {
      const value = run.step({ jumpPressed: tick === 1 });
      if (value.motion.airPhase) {
        if (phases.at(-1) !== value.motion.airPhase) phases.push(value.motion.airPhase);
        seen.add(required(value.frame.legsFrame));
        expect(value.frame.fullBodyFrame).toBeNull();
      }
      roots.push([value.frame.x, value.frame.y]);
      expect(value.frame.x).toBe(Math.round(value.actor.body.x / 256));
      expect(value.frame.y).toBe(Math.round(value.actor.body.y / 256));
    }
    expect(phases).toEqual(["launch", "rise", "apex", "fall"]);
    expect([...seen]).toEqual(
      [
        "launch-drive",
        "launch-fold",
        "rise-open",
        "rise-tuck",
        "apex-fold",
        "apex-open",
        "fall-reach",
        "fall-brace",
      ].map((id) => `p1/legs-${id}`),
    );
    expect(new Set(roots.map((p) => p[1])).size).toBeGreaterThan(20);
  });
  it.each(["sidearm", "heavy-machine-gun", "shotgun", "flamethrower"] as const)(
    "coordinates all %s neutral landing exposures with planted feet",
    (weapon) => {
      const run = combat(weapon),
        first = land(run);
      expect(first.motion.transition).toBe("land-heavy");
      const floor = first.actor.body.y,
        contact = first.frame.contact;
      for (const [age, phase] of ["touch", "absorb", "absorb", "rise", "settle"].entries()) {
        const value = age ? run.step() : first;
        expect(value.frame.legsFrame).toBe(`p1/legs-impact-${phase}`);
        expect(value.frame.upperFrame).toBe(`p1/upper-impact-${weapon}-${phase}`);
        expect(value.frame.contact).toEqual(contact);
        expect(value.actor.body.y).toBe(floor);
      }
      expect(run.step().motion.transition).toBeNull();
    },
  );
  it.each(["sidearm", "heavy-machine-gun", "shotgun", "flamethrower"] as const)(
    "keeps %s fire independent through the entire jump and impact",
    (weapon) => {
      for (const facing of [-1, 1] as const) {
        const run = combat(weapon, facing),
          phases = new Set(),
          shots = [];
        for (let tick = 1; tick <= 58; tick++) {
          const value = run.step({
            held: Held.Fire,
            jumpPressed: tick === 1,
            firePressed: tick === 1,
          });
          if (value.motion.airPhase) phases.add(value.motion.airPhase);
          if (value.actor.action.kind === "fire")
            expect(value.frame.upperFrame).not.toContain("upper-impact");
          for (const event of value.world.events.filter(
            (e) => e.kind === "shot" && e.ownerId === value.actor.playerId,
          )) {
            expect(value.frame.muzzle).toEqual({
              x: Math.round(event.position.x / 256),
              y: Math.round(event.position.y / 256),
            });
            shots.push(value.world.tick);
          }
        }
        expect([...phases]).toEqual(["launch", "rise", "apex", "fall"]);
        expect(shots.length).toBeGreaterThan(2);
      }
    },
  );
  it.each([
    ["run", { held: Held.Right }],
    ["reverse", { held: Held.Left }],
    ["crouch", { held: Held.Down }],
    ["jump", { jumpPressed: true }],
    ["fire", { held: Held.Fire, firePressed: true }],
    ["grenade", { grenadePressed: true }],
  ] as const)("yields to the next accepted %s input after impact", (kind, command) => {
    const run = combat(),
      first = land(run),
      value = run.step(command);
    expect(value.frame.upperFrame).not.toContain("upper-impact");
    if (kind === "run" || kind === "reverse") {
      expect(value.actor.body.x).not.toBe(first.actor.body.x);
      expect(value.frame.legsFrame).toBe("p1/legs-start-brace");
    }
    if (kind === "crouch") expect(value.frame.legsFrame).toBe("p1/legs-crouch-mid");
    if (kind === "jump") {
      expect(value.actor.body.y).toBeLessThan(first.actor.body.y);
      expect(value.frame.legsFrame).toBe("p1/legs-launch-drive");
    }
    if (kind === "fire") {
      expect(value.actor.weapon.shotOrdinal).toBe(first.actor.weapon.shotOrdinal + 1);
      expect(value.frame.upperFrame).toBe("p1/upper-horizontal");
    }
    if (kind === "grenade") expect(value.actor.action.kind).toBe("grenade");
  });
  it("lands directly into the running contact cycle when travel is already held", () => {
    const run = combat();
    let value = run.step({ held: Held.Right, jumpPressed: true });
    while (!value.actor.body.grounded && value.world.tick < 100)
      value = run.step({ held: Held.Right });
    expect(value.actor.body.grounded).toBe(true);
    expect(value.motion.transition).toBeNull();
    expect(value.motion.runStartTick).toBe(value.world.tick);
    expect(value.frame.legsFrame).toBe("p1/legs-run-0");
    const contact = value.frame.contact;
    expect(run.step({ held: Held.Right }).frame.legsFrame).toBe("p1/legs-run-0");
    expect(run.step({ held: Held.Right }).frame.contact).toEqual(contact);
  });
  it("uses a light impact after a short physical fall without inventing a launch or apex", () => {
    const initial = footActor(0, -4);
    initial.body.grounded = false;
    initial.body.supportId = null;
    initial.locomotion = "airborne";
    const run = physics(initial);
    let value = run.read();
    expect(value.motion.airPhase).toBe("fall");
    while (!value.actor.body.grounded && value.tick < 30) {
      value = run.step();
      if (!value.actor.body.grounded) expect(value.motion.airPhase).toBe("fall");
    }
    expect(value.motion.transition).toBe("land-light");
    expect(value.frame.legsFrame).toBe("p1/legs-impact-touch");
    expect(run.step().frame.legsFrame).toBe("p1/legs-impact-rise");
    expect(run.step().frame.legsFrame).toBe("p1/legs-impact-settle");
    expect(run.step().motion.transition).toBeNull();
  });
  it("enters descent immediately on a real ceiling contact", () => {
    const standing = required(FOOT_SHAPES.get(1));
    const ceiling = footTerrain(101, -100, standing.rect.y / 256 - 12, 200, 4);
    const run = physics(footActor(), [FOOT_FLOOR, ceiling]);
    expect(run.step(0, true).motion.airPhase).toBe("launch");
    const hit = run.step();
    expect(hit.actor.body.contacts.some((c) => c.normalY === 1)).toBe(true);
    expect(hit.actor.body.vy).toBe(0);
    expect(hit.motion.airPhase).toBe("fall");
    expect(run.step().motion.airPhase).toBe("fall");
  });
  it("recognizes coyote and buffered jumps from accepted velocity reversals", () => {
    const coyote = physics(footActor(194, 0));
    let departed = coyote.read();
    while (departed.actor.body.grounded && departed.tick < 10) departed = coyote.step(Held.Right);
    expect(departed.actor.body.grounded).toBe(false);
    expect(departed.motion.airPhase).toBe("fall");
    expect(coyote.step(0, true).motion.airPhase).toBe("launch");
    const normal = combat(),
      landing = land(normal).world.tick,
      buffered = combat();
    let prior = buffered.read(),
      value = prior;
    for (let tick = 1; tick <= landing; tick++) {
      prior = value;
      value = buffered.step({ jumpPressed: tick === 1 || tick === landing - 2 });
      if (tick > 1) expect(value.actor.body.grounded).toBe(false);
    }
    expect(prior.actor.body.vy).toBeGreaterThan(0);
    expect(value.actor.body.vy).toBeLessThan(0);
    expect(value.motion.airPhase).toBe("launch");
    expect(value.motion.airPhaseStartTick).toBe(landing);
    expect(value.motion.transition).toBeNull();
  });
  it("does not replay launch or landing after cold observation or identity replacement", () => {
    const run = combat(),
      air = run.step({ jumpPressed: true });
    const cold = initialOperativeMotion(air.actor, air.world.tick);
    expect(cold.airPhase).toBe("rise");
    expect(cold.transition).toBeNull();
    const replacement: ControlledActor = {
      ...air.actor,
      body: { ...air.actor.body, id: 99 },
      controlEpoch: air.actor.controlEpoch + 1,
    };
    const next = advanceOperativeMotion(
      air.actor,
      replacement,
      air.motion,
      air.world.tick + 1,
      atlas,
    );
    expect(next.airPhase).toBe("rise");
    expect(next.transition).toBeNull();
    const ground = land(combat());
    expect(initialOperativeMotion(ground.actor, ground.world.tick).transition).toBeNull();
  });
});

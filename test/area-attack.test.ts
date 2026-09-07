import { describe, expect, it } from "vitest";
import {
  type AreaAttack,
  type CardinalHeading,
  areaExposures,
  cancelArea,
  cardinalRect,
  emitArea,
  stepArea,
  validateArea,
  validateAreaProfile,
} from "../src/game/combat/area-attack.js";
import type { HurtTarget } from "../src/game/combat/projectile.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import { createCombatLab, stepCombatLab } from "../src/game/labs/combat.js";
import { AREA_PROFILES, COMBAT_ATTACKS } from "../src/game/labs/combat-content.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import type { Rect } from "../src/game/state.js";

const zero = { x: 0, y: 0 };
const anchor = { origin: zero, heading: 0 as const };
const rect = (x: number, y: number, w: number, h: number): Rect => ({
  x: pixels(x),
  y: pixels(y),
  w: pixels(w),
  h: pixels(h),
});
const body = (entityId: number, r: Rect, id = entityId): HurtTarget => ({
  id,
  entityId,
  team: 2,
  kind: "body",
  rect: r,
  delta: zero,
});
const wall = (id: number, r: Rect): SweepTarget => ({ id, rect: r, delta: zero, kind: "solid" });
function policy(id: number) {
  const profile = AREA_PROFILES.get(id),
    definition = COMBAT_ATTACKS.get(id);
  if (!profile || !definition) throw new Error("Missing area content");
  return { profile, definition };
}
function source(definitionId = 10): AreaAttack {
  return {
    id: 100,
    ownerId: 1,
    team: 1,
    actionInstanceId: 1,
    definitionId,
    startTick: 1,
    emitted: 0,
    cancelledTick: null,
    lobes: [],
    hits: [],
  };
}
function run(id: number, hurts: HurtTarget[], terrain: SweepTarget[] = [], ticks = 6) {
  const { profile, definition } = policy(id);
  let attack = source(id);
  const events = [],
    states = [];
  for (let tick = 1; tick <= ticks; tick++) {
    if (profile.emissionOffsets.includes(tick - 1)) emitArea(attack, tick, profile, anchor, false);
    const result = stepArea(attack, tick, definition, profile, anchor, terrain, hurts);
    if (!result.attack) break;
    attack = result.attack;
    states.push(attack);
    events.push(...result.impacts.map((hit) => ({ tick, ...hit })));
  }
  return { attack, events, states };
}

describe("authored shotgun and flame volumes", () => {
  it("grants the earliest moving contact across lobes, even when the older lobe is visited first", () => {
    const base = policy(11),
      attack = source(11);
    const profile = {
      ...base.profile,
      attachedTicks: 0,
      emissionOffsets: [0, 1],
      frames: Array.from({ length: 3 }, () => rect(0, -5, 10, 10)),
    };
    const definition = { ...base.definition, lifetimeTicks: 4, repeatDamageTicks: 2 };
    validateAreaProfile(profile, definition);
    emitArea(attack, 1, profile, anchor, false);
    emitArea(attack, 2, profile, { origin: { x: pixels(20), y: 0 }, heading: 0 }, false);
    const victim = { ...body(20, rect(40, -2, 2, 4)), delta: { x: pixels(-40), y: 0 } };
    const result = stepArea(attack, 3, definition, profile, anchor, [], [victim]);
    expect(result.impacts).toHaveLength(1);
    const hit = result.impacts[0];
    expect((hit?.time.numerator ?? 0) * 4).toBe(hit?.time.denominator);
    expect(hit?.position.x).toBe(pixels(30));
    expect(result.attack?.hits).toEqual([{ entityId: 20, nextTick: 5 }]);
  });

  it("advances blocked emission markers without spawning or restoring an old lobe", () => {
    const { profile, definition } = policy(11),
      attack = source(11);
    emitArea(attack, 1, profile, anchor, true);
    expect(() => emitArea(attack, 1, profile, anchor, false)).toThrow(/cursor/);
    emitArea(attack, 7, profile, anchor, false);
    expect(attack.lobes.map((lobe) => lobe.index)).toEqual([1]);
    expect(() => validateArea(attack, 7, definition, profile, [])).not.toThrow();
  });

  it("validates bounded authored reach, emission order and damage windows", () => {
    for (const id of [10, 11]) {
      const { profile, definition } = policy(id);
      expect(() => validateAreaProfile(profile, definition)).not.toThrow();
      for (const bad of [
        { ...profile, frames: [rect(90, -4, 30, 8)] },
        { ...profile, emissionOffsets: [0, 0] },
        { ...profile, attachedTicks: 121 },
        { ...profile, maximumReach: pixels(257) },
      ])
        expect(() => validateAreaProfile(bad, definition)).toThrow();
    }
  });

  it("expands to 110 pixels and grants one full hit per entity across overlapping large hurtboxes", () => {
    const result = run(10, [
      body(20, rect(50, -10, 100, 20)),
      body(20, rect(60, -10, 90, 20), 120),
      body(21, rect(98, -10, 10, 20)),
      body(22, rect(111, -10, 10, 20)),
    ]);
    expect(result.events.map((hit) => [hit.tick, hit.entityId, hit.damage])).toEqual([
      [3, 20, 4],
      [5, 21, 4],
    ]);
    expect(result.attack.hits).toEqual([
      { entityId: 20, nextTick: 7 },
      { entityId: 21, nextTick: 7 },
    ]);
    const { profile, definition } = policy(10);
    expect(areaExposures(result.attack, 6, profile, [])[0]?.rect).toEqual(rect(0, -13, 110, 26));
    expect(stepArea(result.attack, 7, definition, profile, null, [], []).attack).toBeNull();
  });

  it.each([0, 1, 2, 3] as CardinalHeading[])(
    "rotates and clips the exact exposure for heading %i without floor-induced range loss",
    (heading) => {
      const { profile, definition } = policy(10),
        attack = source();
      const origin = { x: pixels(200), y: pixels(200) },
        aimed = { origin, heading };
      emitArea(attack, 1, profile, aimed, false);
      const floor = wall(300, cardinalRect(origin, rect(-20, 8, 200, 20), heading));
      const front = wall(301, cardinalRect(origin, rect(50, -20, 1, 40), heading));
      const result = stepArea(attack, 6, definition, profile, aimed, [floor], []);
      if (!result.attack) throw new Error("Missing blast");
      expect(areaExposures(result.attack, 6, profile, [floor])[0]?.rect).toEqual(
        cardinalRect(origin, rect(0, -13, 110, 21), heading),
      );
      const a = stepArea(attack, 6, definition, profile, aimed, [floor, front], []);
      const b = stepArea(attack, 6, definition, profile, aimed, [front, floor], []);
      expect(a).toEqual(b);
      expect(a.attack?.lobes[0]?.reach).toBe(pixels(50));
    },
  );

  it("uses the birth-tick endpoint for a moving obstacle and moving victim", () => {
    const { profile, definition } = policy(10),
      attack = source();
    emitArea(attack, 1, profile, anchor, false);
    const terrain = { ...wall(300, rect(5, -5, 1, 10)), delta: { x: 0, y: pixels(30) } };
    const hurt = { ...body(20, rect(30, -3, 4, 6)), delta: { x: pixels(-20), y: 0 } };
    expect(
      stepArea(attack, 1, definition, profile, anchor, [terrain], [hurt]).impacts.map(
        (hit) => hit.entityId,
      ),
    ).toEqual([20]);
  });

  it("sweeps a moving victim through a lobe and retains the exact contact fraction", () => {
    const { profile, definition } = policy(10),
      attack = source();
    emitArea(attack, 1, profile, anchor, false);
    const hurt = { ...body(20, rect(20, -30, 5, 5)), delta: { x: 0, y: pixels(60) } };
    const hits = stepArea(attack, 2, definition, profile, anchor, [], [hurt]).impacts;
    expect(hits).toHaveLength(1);
    expect((hits[0]?.time.numerator ?? 0) * 3).toBe(hits[0]?.time.denominator);
    expect(hits[0]?.position.y).toBe(pixels(-5));
  });

  it("retains a contacted thin wall as a flame limit after that wall is removed", () => {
    const { profile, definition } = policy(11);
    const obstacle = wall(300, rect(45, -20, 1, 40));
    let attack = source(11);
    const victim = body(20, rect(48, -5, 4, 10));
    for (let tick = 1; tick <= 18; tick++) {
      if (tick === 1) emitArea(attack, tick, profile, anchor, false);
      const terrain = tick <= 9 ? [obstacle] : [];
      const result = stepArea(attack, tick, definition, profile, anchor, terrain, [victim]);
      if (!result.attack) throw new Error("Missing flame");
      attack = result.attack;
      expect(result.impacts).toEqual([]);
      for (const exposure of areaExposures(attack, tick, profile, terrain))
        expect(exposure.rect.x + exposure.rect.w).toBeLessThanOrEqual(pixels(45));
    }
  });

  it("shares a six-tick victim cooldown across every lobe in one charge", () => {
    const result = run(11, [body(20, rect(10, -10, 4, 20))], [], 30);
    expect(result.events.map((hit) => hit.tick)).toEqual([1, 7, 13, 19]);
    expect(new Set(result.events.map((hit) => hit.actionInstanceId))).toEqual(new Set([1]));
    expect(result.states[12]?.emitted).toBe(3);
  });

  it("can hit an exposed shield before the body, but cannot heat a shield outside a detached lobe", () => {
    const shield = { ...body(20, rect(10, -10, 2, 20), 120), kind: "shield" as const };
    const early = run(10, [body(20, rect(30, -10, 8, 20)), shield], [], 1);
    expect(early.events.map((hit) => [hit.kind, hit.damage])).toEqual([["shield", 0]]);
    const { profile, definition } = policy(11),
      attack = source(11);
    emitArea(attack, 1, profile, anchor, false);
    const late = stepArea(
      attack,
      14,
      definition,
      profile,
      anchor,
      [],
      [body(20, rect(60, -5, 8, 10)), shield],
    );
    expect(late.impacts).toEqual([]);
  });

  it("updates attached position/aim, freezes detached headings and cancels only unreleased flame", () => {
    const { profile, definition } = policy(11),
      attack = source(11);
    emitArea(attack, 1, profile, anchor, false);
    const up = { origin: { x: pixels(2), y: pixels(3) }, heading: 1 as const };
    const attached = stepArea(attack, 6, definition, profile, up, [], []).attack;
    if (!attached) throw new Error("Missing attached lobe");
    expect(attached.lobes[0]).toMatchObject(up);
    emitArea(attached, 7, profile, anchor, false);
    const detached = stepArea(attached, 7, definition, profile, anchor, [], []).attack;
    if (!detached) throw new Error("Missing detached lobe");
    expect(detached.lobes.map((lobe) => lobe.heading)).toEqual([1, 0]);
    cancelArea(detached, 7, profile);
    expect(detached.lobes.map((lobe) => lobe.index)).toEqual([0]);
    expect(() => emitArea(detached, 13, profile, anchor, false)).toThrow(/cursor/);
    expect(() => validateArea(detached, 7, definition, profile, [])).not.toThrow();
    const beforeRelease = source(11);
    emitArea(beforeRelease, 1, profile, anchor, false);
    expect(stepArea(beforeRelease, 6, definition, profile, null, [], []).attack?.lobes).toEqual([]);
  });

  it("rejects corrupted emission, cooldown, geometry and cancellation histories", () => {
    const { profile, definition } = policy(11);
    const attack = run(11, [body(20, rect(10, -10, 4, 20))], [], 7).attack;
    expect(() => validateArea(attack, 7, definition, profile, [20])).not.toThrow();
    const bad = [
      { ...attack, emitted: 1 },
      { ...attack, hits: [{ entityId: 20, nextTick: 14 }] },
      { ...attack, hits: [{ entityId: 21, nextTick: 13 }] },
      { ...attack, cancelledTick: 7 },
      { ...attack, lobes: attack.lobes.map((lobe) => ({ ...lobe, reach: pixels(91) })) },
    ];
    for (const altered of bad)
      expect(() => validateArea(altered, 7, definition, profile, [20])).toThrow();
  });

  it.each(["shotgun", "flame"] as const)(
    "debits %s once per action and preserves authored cadence during crouched fire",
    (scenario) => {
      let world = createCombatLab(scenario);
      const shots = [];
      for (let tick = 1; tick <= 61; tick++) {
        world = stepCombatLab(world, [
          {
            held: Held.Down | Held.Fire,
            firePressed: tick === 1,
            jumpPressed: false,
            grenadePressed: false,
          },
        ]);
        shots.push(
          ...world.events
            .filter((event) => event.kind === "shot" && event.ownerId === 1)
            .map((event) => ({ tick, action: event.actionInstanceId })),
        );
      }
      expect(shots.map((shot) => shot.tick)).toEqual(
        scenario === "shotgun" ? [1, 29, 57] : [1, 7, 13, 31, 37, 43, 61],
      );
      expect(new Set(shots.map((shot) => shot.action)).size).toBe(3);
      expect(world.players[0]?.weapon).toMatchObject({
        ammo: scenario === "shotgun" ? 21 : 27,
        shotOrdinal: 3,
      });
    },
  );
});

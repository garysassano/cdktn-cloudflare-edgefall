import { describe, expect, it } from "vitest";
import type { HurtTarget } from "../src/game/combat/projectile.js";
import {
  type Rocket,
  createRocket,
  stepRocket,
  validateRocket,
} from "../src/game/combat/rocket.js";
import {
  ROCKET_ATTACK,
  ROCKET_PROFILE,
  ROCKET_SHAPE,
} from "../src/game/content/weapons/rocket-launcher.js";
import { COUNTER_LIMIT, MAX_POSITION, pixels } from "../src/game/core/numeric.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import { rocketProof } from "./fixtures/rocket-proof.js";

const source = {
  id: 1000,
  ownerId: 1,
  team: 1,
  actionInstanceId: 7,
  definitionId: ROCKET_ATTACK.id,
};
const born = (heading = 0) => createRocket(source, { x: 0, y: 0 }, heading, 1, ROCKET_PROFILE);
const body = (entityId: number, x: number, y = 0): HurtTarget => ({
  id: entityId * 10,
  entityId,
  team: 2,
  kind: "body",
  rect: { x: pixels(x - 4), y: pixels(y - 6), w: pixels(8), h: pixels(12) },
  delta: { x: 0, y: 0 },
});
const wall = (x: number): SweepTarget => ({
  id: 900,
  kind: "solid",
  rect: { x: pixels(x), y: -pixels(80), w: pixels(1), h: pixels(160) },
  delta: { x: 0, y: 0 },
});
function advance(current: Rocket, targets: HurtTarget[] = [], terrain: SweepTarget[] = []) {
  const result = stepRocket(
    current,
    current.tick + 1,
    ROCKET_ATTACK,
    ROCKET_SHAPE,
    ROCKET_PROFILE,
    terrain,
    targets,
  );
  if (result.status !== "active") throw new Error(`Unexpected rocket terminal: ${result.status}`);
  return result.rocket;
}

describe("accelerating guided rocket authority", () => {
  it("replays every fixture with reordered candidates and serialized guidance checkpoints", () => {
    const proof = rocketProof();
    expect(proof.cases).toHaveLength(14);
    expect(
      proof.cases
        .filter((study) => study.name.startsWith("guided-"))
        .map((study) => study.terminal.status),
    ).toEqual(["detonated", "detonated", "detonated", "detonated"]);
    expect(proof.cases.find((study) => study.name === "lifetime")?.restoredTicks).toContain(89);
  });
  it.each([0, 8, 16, 24])(
    "starts at the muzzle, then accelerates along cardinal heading %i",
    (heading) => {
      let rocket = born(heading);
      expect(rocket.position).toEqual({ x: 0, y: 0 });
      const speeds = [];
      for (let i = 0; i < 12; i++) {
        const previous = structuredClone(rocket);
        const input = structuredClone(rocket);
        rocket = advance(input);
        expect(input).toEqual(previous);
        expect(Math.abs(rocket.velocity.x) + Math.abs(rocket.velocity.y)).toBe(rocket.speed);
        expect(rocket.position).toEqual({
          x: previous.position.x + rocket.velocity.x,
          y: previous.position.y + rocket.velocity.y,
        });
        speeds.push(rocket.speed);
      }
      expect(speeds).toEqual([640, 768, 896, 1024, 1152, 1280, 1408, 1536, 1536, 1536, 1536, 1536]);
      expect(Math.sign(rocket.position.x)).toBe(heading === 0 ? 1 : heading === 16 ? -1 : 0);
      expect(Math.sign(rocket.position.y)).toBe(heading === 8 ? 1 : heading === 24 ? -1 : 0);
    },
  );

  it("chooses the nearest visible eligible entity with stable ties and ignores unrelated teams", () => {
    const targets = [
      body(21, 160, 20),
      body(20, 160, -20),
      { ...body(2, 50), team: 1 },
      body(1, 30),
      { ...body(3, 70), team: 0 },
      body(4, -50),
      body(5, 300),
    ];
    expect(advance(born(), targets).targetId).toBe(20);
    expect(advance(born(), [...targets].reverse())).toEqual(advance(born(), targets));
    expect(advance(born(), [body(20, 160)], [wall(100)]).targetId).toBeNull();
    expect(
      advance(born(), [body(20, 160), { ...body(20, 150), id: 201, kind: "shield" }]).targetId,
    ).toBeNull();
  });

  it("retains a visible lock in the wider cone even when a nearer enemy appears", () => {
    const locked = advance(born(), [body(20, 200)]);
    expect(locked.targetId).toBe(20);
    const next = advance(locked, [body(21, 60), body(20, 200, 120)]);
    expect(next.targetId).toBe(20);
    expect(advance(born(), [body(20, 200, 120)]).targetId).toBeNull();
  });

  it.each(["dead", "covered"] as const)(
    "drops a %s lock immediately and reacquires only on its scheduled tick",
    (reason) => {
      let rocket = advance(born(), [body(20, 200)]);
      const targets = reason === "dead" ? [body(21, 60)] : [body(20, 200), body(21, 60)];
      const terrain = reason === "covered" ? [wall(100)] : [];
      for (let tick = 3; tick < 8; tick++) {
        rocket = advance(rocket, targets, terrain);
        expect(rocket.targetId).toBeNull();
      }
      expect(advance(rocket, targets, terrain).targetId).toBe(21);
    },
  );

  it("limits turning to one authored step per interval and never turns back beyond the launch leash", () => {
    let rocket = born();
    for (let tick = 2; tick <= 28; tick++) {
      const previous = rocket;
      rocket = advance(rocket, [body(20, 210, 90 + Math.max(0, tick - 10) * 5)]);
      const turn = ((rocket.heading - previous.heading + 48) % 32) - 16;
      expect(Math.abs(turn)).toBeLessThanOrEqual(1);
      if (turn !== 0) expect((tick - rocket.spawnTick) % ROCKET_PROFILE.turnIntervalTicks).toBe(0);
      expect(
        Math.abs(((rocket.heading - rocket.launchHeading + 48) % 32) - 16),
      ).toBeLessThanOrEqual(4);
      expect(rocket.velocity.x).toBeGreaterThan(0);
    }
    expect(rocket.heading).toBeGreaterThan(0);
  });

  it("rejects skipped/repeated steps and impossible restored guidance state", () => {
    const rocket = advance(born());
    const call = (value: Rocket, tick = value.tick + 1) =>
      stepRocket(value, tick, ROCKET_ATTACK, ROCKET_SHAPE, ROCKET_PROFILE, [], []);
    expect(() => call(rocket, rocket.tick)).toThrow("consecutive");
    expect(() => call(rocket, rocket.tick + 2)).toThrow("consecutive");
    expect(() => call({ ...rocket, speed: rocket.speed + 1 })).toThrow("speed");
    expect(() => call({ ...rocket, heading: 16 })).toThrow("leash");
    expect(() => call({ ...rocket, targetId: source.ownerId })).toThrow("owner");
    expect(() => call({ ...rocket, nextAcquireTick: COUNTER_LIMIT })).toThrow("clock");
    expect(() => call({ ...rocket, nextAcquireTick: rocket.tick })).toThrow("clock");
    expect(() => call({ ...rocket, nextAcquireTick: 7 })).toThrow("clock");
    expect(() => call({ ...rocket, nextTurnTick: rocket.tick })).toThrow("clock");
    expect(() =>
      createRocket(source, { x: 0, y: 0 }, 0, COUNTER_LIMIT - 2, ROCKET_PROFILE),
    ).toThrow("birth");
  });

  it("rejects invalid collision input before target ranking or squared-distance arithmetic", () => {
    const query = (targets: HurtTarget[]) => advance(born(), targets);
    expect(() => query([body(20, 100), body(20, 100)])).toThrow("Duplicate");
    expect(() => query([{ ...body(20, 100), rect: { x: 0, y: 0, w: -1, h: 1 } }])).toThrow();
    expect(() => query([{ ...body(20, 100), delta: { x: NaN, y: 0 } }])).toThrow();
    expect(() =>
      createRocket(source, { x: 0, y: 0 }, 0, 1, { ...ROCKET_PROFILE, retainRange: 65537 }),
    ).toThrow();
  });

  it("rejects a blast radius too small to reach the body that the missile contacts", () => {
    const profile = { ...ROCKET_PROFILE, blastRadius: 1 };
    const rocket = createRocket(source, { x: 0, y: 0 }, 0, 1, profile);
    expect(() =>
      stepRocket(rocket, 2, ROCKET_ATTACK, ROCKET_SHAPE, profile, [], [body(20, 4)]),
    ).toThrow("enclose");
  });

  it("bounds the entire flight body at both endpoints even in an empty collision query", () => {
    const rocket = createRocket(
      source,
      { x: MAX_POSITION - pixels(3), y: 0 },
      0,
      1,
      ROCKET_PROFILE,
    );
    expect(() => advance(rocket)).toThrow("position");
  });
});

describe("rocket collision and one explosion budget", () => {
  const fastProfile = {
    ...ROCKET_PROFILE,
    launchSpeed: pixels(32),
    maximumSpeed: pixels(32),
    blastRadius: pixels(16),
  };
  const fastAttack = { ...ROCKET_ATTACK, speed: fastProfile.launchSpeed };
  const fire = (terrain: SweepTarget[], targets: HurtTarget[]) =>
    stepRocket(
      createRocket(source, { x: 0, y: 0 }, 0, 1, fastProfile),
      2,
      fastAttack,
      ROCKET_SHAPE,
      fastProfile,
      terrain,
      targets,
    );

  it("hits thin cover before a target behind it, including initial overlap and moving cover", () => {
    for (const obstacle of [wall(10), { ...wall(10), delta: { x: -pixels(8), y: 0 } }, wall(0)]) {
      const result = fire([obstacle], [body(20, 20)]);
      expect(result.status).toBe("detonated");
      if (result.status !== "detonated") throw new Error("Missing blast");
      expect(result.contact).toMatchObject({ colliderId: 900, kind: "terrain", damage: 0 });
      expect(result.impacts).toEqual([]);
    }
  });

  it("grants one explosion hit per entity and no extra direct-hit damage", () => {
    const target = body(20, 14);
    const result = fire([], [target, { ...target, id: 201 }, body(21, 20)]);
    expect(result.status).toBe("detonated");
    if (result.status !== "detonated") throw new Error("Missing blast");
    expect(result.contact).toMatchObject({
      entityId: 20,
      damage: 0,
      position: { x: pixels(8), y: 0 },
    });
    expect(result.impacts.map((hit) => [hit.entityId, hit.damage])).toEqual([
      [20, 4],
      [21, 4],
    ]);
    expect(result.impacts.every((hit) => hit.time.numerator / hit.time.denominator === 0.25)).toBe(
      true,
    );
  });

  it("keeps the contacted target inside the same finite blast budget in a crowded group", () => {
    const result = fire(
      [],
      [body(500, 14), ...Array.from({ length: 16 }, (_, i) => body(20 + i, 8, 12))],
    );
    if (result.status !== "detonated") throw new Error("Missing crowded blast");
    expect(result.contact.entityId).toBe(500);
    expect(result.impacts).toHaveLength(16);
    expect(result.impacts.map((hit) => hit.entityId)).toEqual([
      500,
      ...Array.from({ length: 15 }, (_, i) => 20 + i),
    ]);
    expect(result.impacts.reduce((damage, hit) => damage + hit.damage, 0)).toBe(64);
  });

  it("samples moving victims and cover at impact time rather than the end of the tick", () => {
    const entersLate = { ...body(21, 10, 40), delta: { x: 0, y: -pixels(40) } };
    const leavesLater = { ...body(22, 10, 10), delta: { x: 0, y: pixels(40) } };
    const result = fire([], [body(20, 14), entersLate, leavesLater]);
    expect(result.status).toBe("detonated");
    if (result.status !== "detonated") throw new Error("Missing blast");
    expect(result.contact.entityId).toBe(20);
    expect(result.impacts.map((hit) => hit.entityId)).toEqual([20, 22]);
    const covered = fire(
      [{ ...wall(19), delta: { x: -pixels(32), y: 0 } }],
      [body(20, 14), body(21, 25)],
    );
    expect(covered.status).toBe("detonated");
    if (covered.status !== "detonated") throw new Error("Missing covered blast");
    expect(covered.impacts.map((hit) => hit.entityId)).toEqual([20]);
  });

  it("sweeps relative target motion even when both endpoint poses miss the missile path", () => {
    const result = fire([], [{ ...body(20, 16, -20), delta: { x: 0, y: pixels(40) } }]);
    expect(result.status).toBe("detonated");
    if (result.status !== "detonated") throw new Error("Missing crossing hit");
    expect(result.contact.entityId).toBe(20);
    expect(result.impacts).toHaveLength(1);
  });

  it("preserves shield occlusion without spilling the blast through to its body", () => {
    const target = body(20, 20),
      shield = { ...body(20, 16), id: 201, kind: "shield" as const };
    const result = fire([], [target, shield]);
    expect(result.status).toBe("detonated");
    if (result.status !== "detonated") throw new Error("Missing shield blast");
    expect(result.contact.kind).toBe("shield");
    expect(result.impacts).toHaveLength(1);
    expect(result.impacts[0]).toMatchObject({
      entityId: 20,
      kind: "shield",
      damage: 0,
      definitionId: ROCKET_ATTACK.id,
    });
  });

  it("expires without a phantom blast but still resolves contact on the final motion tick", () => {
    const profile = { ...ROCKET_PROFILE, lifetimeTicks: 2 },
      attack = { ...ROCKET_ATTACK, lifetimeTicks: 2 };
    const initial = createRocket(source, { x: 0, y: 0 }, 0, 1, profile);
    const first = stepRocket(initial, 2, attack, ROCKET_SHAPE, profile, [], []);
    if (first.status !== "active") throw new Error("Premature terminal");
    validateRocket(first.rocket, profile);
    expect(stepRocket(first.rocket, 3, attack, ROCKET_SHAPE, profile, [], [])).toEqual({
      status: "expired",
      position: { x: 1408, y: 0 },
    });
    expect(stepRocket(first.rocket, 3, attack, ROCKET_SHAPE, profile, [wall(6)], []).status).toBe(
      "detonated",
    );
  });
});

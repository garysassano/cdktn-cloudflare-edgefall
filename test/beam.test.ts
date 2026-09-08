import { describe, expect, it } from "vitest";
import type { AreaAnchor, CardinalHeading } from "../src/game/combat/area-attack.js";
import {
  type BeamPulse,
  beamSegments,
  castBeam,
  emitBeam,
  stepBeam,
  validateBeamPulse,
} from "../src/game/combat/beam.js";
import type { HurtTarget } from "../src/game/combat/projectile.js";
import { LASER_ATTACK, LASER_PROFILE } from "../src/game/content/weapons/laser.js";
import { COUNTER_LIMIT, MAX_POSITION, MAX_SHAPE, pixels } from "../src/game/core/numeric.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import { beamProof } from "./fixtures/beam-proof.js";

const source = {
  id: 1000,
  ownerId: 1,
  team: 1,
  actionInstanceId: 7,
  definitionId: LASER_ATTACK.id,
};
const origin = { x: 0, y: 0 };
const anchor: AreaAnchor = { origin, heading: 0 };
const rect = (x: number, y: number, w: number, h: number) => ({
  x: pixels(x),
  y: pixels(y),
  w: pixels(w),
  h: pixels(h),
});
const body = (entityId: number, x: number, y = -4): HurtTarget => ({
  id: entityId * 10,
  entityId,
  team: 2,
  kind: "body",
  rect: rect(x, y, 8, 8),
  delta: origin,
});
const wall = (x: number): SweepTarget => ({
  id: 900,
  kind: "solid",
  rect: rect(x, -80, 1, 160),
  delta: origin,
});
const cast = (targets: HurtTarget[] = [], terrain: SweepTarget[] = [], maxTargets = 8) =>
  castBeam(source, { ...LASER_ATTACK, maxTargets }, LASER_PROFILE, origin, 0, terrain, targets);
const emit = (targets: HurtTarget[] = []) =>
  emitBeam(source, 1, LASER_ATTACK, LASER_PROFILE, anchor, [], targets);
const step = (
  beam: BeamPulse,
  tick: number,
  muzzle: AreaAnchor | null = anchor,
  targets: HurtTarget[] = [],
) => stepBeam(beam, tick, LASER_ATTACK, LASER_PROFILE, muzzle, [], targets);

describe("instantaneous laser geometry and material", () => {
  it.each([
    [0, rect(10, 18, 256, 4), rect(266, 18, 256, 4), rect(522, 18, 88, 4)],
    [1, rect(8, -236, 4, 256), rect(8, -492, 4, 256), rect(8, -580, 4, 88)],
    [2, rect(8, 20, 4, 256), rect(8, 276, 4, 256), rect(8, 532, 4, 88)],
    [3, rect(-246, 18, 256, 4), rect(-502, 18, 256, 4), rect(-590, 18, 88, 4)],
  ] as const)(
    "splits heading %i into contiguous bounded display segments",
    (heading, ...segments) => {
      expect(
        beamSegments({ x: pixels(10), y: pixels(20) }, heading, pixels(600), pixels(4)),
      ).toEqual(segments);
      const maximum = beamSegments(origin, heading, MAX_SHAPE * 4, 1);
      expect(maximum).toHaveLength(4);
      expect(maximum.every((segment) => segment.w <= MAX_SHAPE && segment.h <= MAX_SHAPE)).toBe(
        true,
      );
      expect(beamSegments(origin, heading, 0, 1)).toEqual([]);
    },
  );

  it.each([
    [0, rect(40, -4, 8, 8), { x: pixels(40), y: 0 }],
    [1, rect(-4, -48, 8, 8), { x: 0, y: -pixels(40) }],
    [2, rect(-4, 40, 8, 8), { x: 0, y: pixels(40) }],
    [3, rect(-48, -4, 8, 8), { x: -pixels(40), y: 0 }],
  ] as const)(
    "hits in cardinal direction %i with the same range and damage",
    (heading, geometry, point) => {
      const result = castBeam(
        source,
        LASER_ATTACK,
        LASER_PROFILE,
        origin,
        heading,
        [],
        [{ ...body(20, 0), rect: geometry }],
      );
      expect(result.impacts).toMatchObject([
        { entityId: 20, damage: 2, position: point, time: { numerator: 1, denominator: 1 } },
      ]);
      expect(result.length).toBe(pixels(512));
    },
  );

  it("reaches far beyond the projectile displacement bound without tunneling through thin cover", () => {
    expect(cast([body(20, 400)]).impacts.map((impact) => impact.entityId)).toEqual([20]);
    const result = cast([body(20, 400)], [wall(300)]);
    expect(result).toMatchObject({
      length: pixels(300),
      stoppedBy: "terrain",
      impacts: [{ colliderId: 900, kind: "terrain", damage: 0 }],
    });
    expect(result.segments).toEqual([rect(0, -2, 256, 4), rect(256, -2, 44, 4)]);
  });

  it("samples moving bodies and cover at the end of the pulse tick", () => {
    const into = { ...body(20, 40, -24), delta: { x: 0, y: pixels(24) } };
    const out = { ...body(21, 50), delta: { x: 0, y: pixels(24) } };
    const crossing = { ...body(22, 60, -24), delta: { x: 0, y: pixels(48) } };
    expect(cast([into, out, crossing]).impacts.map((impact) => impact.entityId)).toEqual([20]);
    const incomingWall = {
      ...wall(45),
      rect: rect(45, -40, 1, 10),
      delta: { x: 0, y: pixels(36) },
    };
    expect(cast([body(20, 60)], [incomingWall]).length).toBe(pixels(45));
    expect(
      cast([body(20, 60)], [{ ...incomingWall, delta: origin }]).impacts.map(
        (impact) => impact.entityId,
      ),
    ).toEqual([20]);
  });

  it("excludes bodies behind the muzzle and outside the width, and includes exact forward endpoints", () => {
    const result = cast([
      body(20, -8),
      body(21, 30, 2),
      body(22, 30, -10),
      body(23, 512),
      body(24, 513),
    ]);
    expect(result.impacts.map((impact) => impact.entityId)).toEqual([23]);
    expect(cast([body(20, -4)]).impacts[0]?.position).toEqual(origin);
    expect(cast([], [wall(0)])).toMatchObject({ length: 0, segments: [], stoppedBy: "terrain" });
  });

  it("deduplicates entity components before consuming the penetration budget", () => {
    const targets = [body(20, 20), { ...body(20, 22), id: 201 }, body(21, 30), body(22, 40)];
    const result = cast(targets, [], 2);
    expect(result.impacts.map((impact) => impact.entityId)).toEqual([20, 21]);
    expect(result).toMatchObject({ length: pixels(30), stoppedBy: "penetration" });
    expect(cast(targets.reverse(), [], 2)).toEqual(result);
  });

  it("gives terrain then shields then solid props priority over coincident bodies", () => {
    const shield: HurtTarget = { ...body(20, 40), id: 201, kind: "shield" };
    const solid = { ...body(21, 40), solid: true, team: 0 };
    const targets = [body(22, 40), solid, body(20, 40), shield];
    expect(cast(targets, [wall(40)]).impacts.map((impact) => impact.kind)).toEqual(["terrain"]);
    expect(cast(targets)).toMatchObject({
      stoppedBy: "shield",
      impacts: [{ colliderId: 201, damage: 0 }],
    });
    expect(cast(targets.slice(0, 3))).toMatchObject({
      stoppedBy: "solid",
      impacts: [{ colliderId: 210, damage: 2 }],
    });
  });

  it("conservatively stops the whole beam at partial-width cover, including one-way material", () => {
    for (const kind of ["solid", "one-way"] as const) {
      const cover = { ...wall(40), kind, rect: rect(40, 1, 1, 10) };
      expect(cast([body(20, 50)], [cover])).toMatchObject({
        stoppedBy: "terrain",
        length: pixels(40),
      });
    }
    const shield: HurtTarget = { ...body(20, 40, 1), kind: "shield" };
    expect(cast([shield, body(21, 50)])).toMatchObject({ stoppedBy: "shield", length: pixels(40) });
  });

  it("stops at a shield after an exposed component without a second grant to that entity", () => {
    const shield: HurtTarget = { ...body(20, 40), id: 201, kind: "shield" };
    expect(cast([body(20, 30), shield, body(21, 50)])).toMatchObject({
      length: pixels(40),
      stoppedBy: "shield",
      impacts: [{ entityId: 20, kind: "body", damage: 2 }],
    });
  });

  it("ignores the owner and allies but respects an allied solid body", () => {
    expect(
      cast([body(1, 10), { ...body(20, 20), team: 1 }, body(21, 30)]).impacts.map(
        (impact) => impact.entityId,
      ),
    ).toEqual([21]);
    expect(cast([{ ...body(20, 20), team: 1, solid: true }, body(21, 30)])).toMatchObject({
      stoppedBy: "solid",
      impacts: [{ entityId: 20 }],
    });
  });

  it("orders coincident ordinary targets by stable collider identity", () => {
    const targets = [body(22, 40), body(21, 40), body(20, 40)];
    expect(cast(targets, [], 2).impacts.map((impact) => impact.entityId)).toEqual([20, 21]);
    expect(cast(targets.reverse(), [], 2).impacts.map((impact) => impact.entityId)).toEqual([
      20, 21,
    ]);
  });
});

describe("one accepted laser charge", () => {
  it("pulses only at birth, follows the muzzle without damage, and expires before the next charge", () => {
    const target = body(20, 100);
    const birth = emit([target]);
    expect(birth.cast.impacts).toMatchObject([{ entityId: 20, damage: 2 }]);
    let current = birth.beam;
    for (let tick = 2; tick <= 6; tick++) {
      const before = structuredClone(current);
      const result = step(current, tick, { origin: { x: pixels(tick), y: 0 }, heading: 0 }, [
        target,
      ]);
      expect(current).toEqual(before);
      expect(result.cast?.impacts).toEqual([]);
      expect(result.beam?.origin.x).toBe(pixels(tick));
      if (!result.beam) throw new Error("Charge expired early");
      current = result.beam;
    }
    expect(step(current, 7)).toEqual({ beam: null, cast: null });
    const next = emitBeam(
      { ...source, id: 1001, actionInstanceId: 8 },
      7,
      LASER_ATTACK,
      LASER_PROFILE,
      anchor,
      [],
      [target],
    );
    expect(next.cast.impacts).toMatchObject([{ entityId: 20, damage: 2, actionInstanceId: 8 }]);
  });

  it("does not damage a target first encountered between pulse ticks", () => {
    const result = step(emit().beam, 2, anchor, [body(20, 100)]);
    expect(result.cast?.impacts).toEqual([]);
    expect(result.cast?.segments).toHaveLength(2);
  });

  it("cancels immediately when input release or an invalid owner removes the accepted anchor", () => {
    expect(step(emit().beam, 2, null, [body(20, 100)])).toEqual({ beam: null, cast: null });
  });

  it("updates held geometry for a turned muzzle and newly arrived cover without another pulse", () => {
    const result = stepBeam(
      emit().beam,
      2,
      LASER_ATTACK,
      LASER_PROFILE,
      { origin, heading: 1 },
      [{ ...wall(0), rect: rect(-10, -101, 20, 1) }],
      [],
    );
    expect(result.beam).toMatchObject({ heading: 1, length: pixels(100) });
    expect(result.cast).toMatchObject({
      stoppedBy: "terrain",
      impacts: [],
      segments: [rect(-2, -100, 4, 100)],
    });
  });

  it("rejects duplicate/skipped ticks and malformed restored charge state", () => {
    const beam = emit().beam;
    expect(() => step(beam, 1)).toThrow("consecutive");
    expect(() => step(beam, 3)).toThrow("consecutive");
    for (const change of [
      { spawnTick: 0 },
      { tick: 7 },
      { length: pixels(513) },
      { heading: 4 },
      { team: 0 },
      { id: 0 },
      { origin: { x: NaN, y: 0 } },
    ])
      expect(() =>
        validateBeamPulse({ ...beam, ...change } as BeamPulse, LASER_ATTACK, LASER_PROFILE),
      ).toThrow();
    expect(() =>
      emitBeam(source, COUNTER_LIMIT - 2, LASER_ATTACK, LASER_PROFILE, anchor, [], []),
    ).toThrow("birth");
  });

  it("replays every serialized continuation and reordered candidate query in the portable proof", () => {
    const proof = beamProof();
    expect(proof.cases.length).toBeGreaterThanOrEqual(16);
    expect(
      proof.charges.every((charge) => charge.restoredTicks.length === charge.visibleTicks),
    ).toBe(true);
    expect(proof.charges.every((charge) => charge.followupDamage === 0)).toBe(true);
  });
});

describe("laser bounded arithmetic and fail-closed inputs", () => {
  it("rejects invalid geometry and duplicate IDs even when filtered out or beyond range", () => {
    expect(() => cast([body(20, 100), body(20, 100)])).toThrow("Duplicate");
    expect(() => cast([{ ...body(1, 100), delta: { x: NaN, y: 0 } }])).toThrow();
    expect(() => cast([{ ...body(20, 1000), rect: rect(1000, 0, 0, 2) }])).toThrow();
    expect(() => cast([{ ...body(20, 1000), solid: 1 } as unknown as HurtTarget])).toThrow();
    expect(() => cast([], [{ ...wall(10), kind: "lava" } as unknown as SweepTarget])).toThrow();
    expect(() => cast(Array.from({ length: 4097 }, (_, i) => body(20 + i, 600)))).toThrow("budget");
  });

  it("bounds the full beam extent in empty and fully occluded queries", () => {
    for (const terrain of [[], [wall(1)]])
      expect(() =>
        castBeam(
          source,
          LASER_ATTACK,
          LASER_PROFILE,
          { x: MAX_POSITION - 1, y: 0 },
          0,
          terrain,
          [],
        ),
      ).toThrow("position");
    expect(() => beamSegments({ x: MAX_POSITION + 1, y: 0 }, 3, 0, 1)).toThrow();
    expect(() => beamSegments(origin, 4 as CardinalHeading, 0, 1)).toThrow("heading");
    expect(() => beamSegments(origin, 0, MAX_SHAPE * 4 + 1, 1)).toThrow("length");
    expect(() => beamSegments(origin, 0, 1, 4097)).toThrow("width");
  });

  it("rejects inconsistent energy, cadence, damage and penetration policies", () => {
    for (const change of [
      { speed: 1 },
      { material: "heat" as const },
      { repeatDamageTicks: 0 },
      { lifetimeTicks: 5 },
      { maxTargets: 65 },
      { damage: 0 },
    ])
      expect(() =>
        castBeam(source, { ...LASER_ATTACK, ...change }, LASER_PROFILE, origin, 0, [], []),
      ).toThrow();
    expect(() =>
      castBeam(source, LASER_ATTACK, { ...LASER_PROFILE, pulseTicks: 0 }, origin, 0, [], []),
    ).toThrow("interval");
  });
});

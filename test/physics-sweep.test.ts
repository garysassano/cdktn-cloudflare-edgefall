import { describe, expect, it } from "vitest";
import { MAX_MOTION, MAX_POSITION, randomStep } from "../src/game/core/numeric.js";
import {
  type SweepTarget,
  displacementAtContact,
  earliestSweep,
  sweepAabb,
  sweepOneWay,
} from "../src/game/physics/sweep.js";
import type { Point, Rect } from "../src/game/state.js";

const body = { x: 0, y: 0, w: 10, h: 10 };
const zero = { x: 0, y: 0 };
function target(id: number, rect: Rect, kind: SweepTarget["kind"] = "solid"): SweepTarget {
  return { id, rect, delta: zero, kind };
}

describe("exact swept AABB", () => {
  it("hits a one-subpixel wall before a target behind it, including a zero-width projectile", () => {
    const wall = target(8, { x: 50, y: -5, w: 1, h: 20 });
    const enemy = target(1, { x: 60, y: 0, w: 10, h: 10 });
    expect(earliestSweep(body, { x: 100, y: 0 }, [enemy, wall])).toEqual({
      overlaps: [],
      contacts: [
        {
          otherId: 8,
          kind: "solid",
          time: { numerator: 40, denominator: 100 },
          normal: { x: -1, y: 0 },
        },
      ],
    });
    expect(sweepAabb({ x: 0, y: 5, w: 0, h: 0 }, { x: 100, y: 0 }, wall.rect)).toEqual({
      kind: "hit",
      time: { numerator: 50, denominator: 100 },
      normals: [{ x: -1, y: 0 }],
    });
  });
  it("retains both corner normals and every equally early entity in stable ID order", () => {
    const corner = target(9, { x: 20, y: 20, w: 10, h: 10 });
    const wall = target(2, { x: 20, y: -10, w: 10, h: 100 });
    const result = earliestSweep(body, { x: 20, y: 20 }, [corner, wall]);
    expect(result.contacts.map((hit) => [hit.otherId, hit.normal])).toEqual([
      [2, { x: -1, y: 0 }],
      [9, { x: -1, y: 0 }],
      [9, { x: 0, y: -1 }],
    ]);
    expect(result).toEqual(earliestSweep(body, { x: 20, y: 20 }, [wall, corner]));
  });
  it("distinguishes inward, outward, tangent, endpoint and corner-grazing contact", () => {
    const floor = { x: -100, y: 10, w: 200, h: 10 };
    expect(sweepAabb(body, { x: 0, y: 1 }, floor)).toMatchObject({
      kind: "hit",
      time: { numerator: 0, denominator: 1 },
    });
    for (const delta of [{ x: 0, y: -1 }, { x: 5, y: 0 }, zero])
      expect(sweepAabb(body, delta, floor)).toBeNull();
    expect(sweepAabb(body, { x: 10, y: 0 }, { x: 20, y: 0, w: 10, h: 10 })).toMatchObject({
      time: { numerator: 10, denominator: 10 },
    });
    expect(sweepAabb(body, { x: 20, y: -20 }, { x: 20, y: 0, w: 10, h: 10 })).toBeNull();
  });
  it("reports overlap rather than inventing an impact or arbitrary separation impulse", () => {
    const embedded = target(3, { x: 9, y: 9, w: 10, h: 10 });
    expect(earliestSweep(body, zero, [embedded])).toEqual({ overlaps: [3], contacts: [] });
    expect(sweepAabb(body, { x: -100, y: 0 }, embedded.rect)).toEqual({ kind: "overlap" });
  });
  it("uses relative movement for targets crossing the projectile path", () => {
    expect(
      sweepAabb(body, { x: 20, y: 0 }, { x: 30, y: 0, w: 10, h: 10 }, { x: -20, y: 0 }),
    ).toEqual({
      kind: "hit",
      time: { numerator: 20, denominator: 40 },
      normals: [{ x: -1, y: 0 }],
    });
    expect(
      sweepAabb(body, { x: 20, y: 0 }, { x: 30, y: 0, w: 10, h: 10 }, { x: 20, y: 0 }),
    ).toBeNull();
  });
  it("compares maximum-bound positions and opposing velocities without overflow", () => {
    expect(
      sweepAabb(
        { x: -MAX_POSITION, y: 0, w: 1, h: 1 },
        { x: MAX_MOTION, y: 0 },
        { x: MAX_POSITION - 1, y: 0, w: 1, h: 1 },
        { x: -MAX_MOTION, y: 0 },
      ),
    ).toBeNull();
    expect(
      sweepAabb(
        { x: -MAX_MOTION, y: 0, w: 1, h: 1 },
        { x: MAX_MOTION, y: 0 },
        { x: MAX_MOTION - 1, y: 0, w: 1, h: 1 },
        { x: -MAX_MOTION, y: 0 },
      ),
    ).toMatchObject({ time: { numerator: 2 * MAX_MOTION - 2, denominator: 2 * MAX_MOTION } });
  });
  it("rejects invalid shape/motion/IDs even when candidates are ignored or empty", () => {
    expect(() => sweepAabb(body, { x: MAX_MOTION + 1, y: 0 }, body)).toThrow();
    expect(() => earliestSweep({ ...body, w: 0.5 }, zero, [])).toThrow();
    expect(() => sweepAabb(body, zero, { ...body, w: 0 })).toThrow();
    expect(() => earliestSweep(body, zero, [target(1, body), target(1, body)])).toThrow(
      /Duplicate/,
    );
    expect(() =>
      earliestSweep(body, zero, [target(1, { ...body, w: -1 }, "one-way")], 1),
    ).toThrow();
  });
  it("rounds signed motion toward its starting point, retaining subpixel precision", () => {
    expect(displacementAtContact({ x: -10, y: 7 }, { numerator: 1, denominator: 3 })).toEqual({
      x: -3,
      y: 2,
    });
    expect(displacementAtContact({ x: -1, y: 1 }, { numerator: 0, denominator: 1 })).toEqual(zero);
    expect(() => displacementAtContact(zero, { numerator: 2, denominator: 1 })).toThrow();
  });
});

describe("one-way top surfaces", () => {
  const platform = { x: -10, y: 20, w: 40, h: 2 };
  it("lands from above, passes upward/from below and excludes edge-only grazes", () => {
    expect(sweepOneWay(body, { x: 0, y: 20 }, platform)).toEqual({
      kind: "hit",
      time: { numerator: 10, denominator: 20 },
      normals: [{ x: 0, y: -1 }],
    });
    expect(sweepOneWay({ ...body, y: 30 }, { x: 0, y: -40 }, platform)).toBeNull();
    expect(sweepOneWay({ ...body, y: 15 }, { x: 0, y: 20 }, platform)).toBeNull();
    expect(sweepOneWay(body, { x: 60, y: 20 }, platform)).toBeNull();
  });
  it("accepts an upward-moving support but ignores only the selected drop-through ID", () => {
    expect(sweepOneWay(body, zero, platform, { x: 0, y: -20 })).toMatchObject({
      time: { numerator: 10, denominator: 20 },
    });
    const upper = target(2, platform, "one-way");
    const lower = target(3, { ...platform, y: 30 }, "one-way");
    expect(
      earliestSweep(body, { x: 0, y: 40 }, [upper, lower], 2).contacts.map((hit) => hit.otherId),
    ).toEqual([3]);
  });
});

// Independent exact oracle: intersect open overlap intervals using BigInt fractions.
// Keeping this test-only avoids BigInt in the production numeric contract.
function oracle(a: Rect, da: Point, b: Rect, db: Point): string {
  type Fraction = [bigint, bigint];
  const cmp = (x: Fraction, y: Fraction) => x[0] * y[1] - y[0] * x[1];
  let low: Fraction = [-(2n ** 60n), 1n];
  let high: Fraction = [2n ** 60n, 1n];
  let inside = true;
  for (const [p, width, q, size, velocity] of [
    [a.x, a.w, b.x, b.w, da.x - db.x],
    [a.y, a.h, b.y, b.h, da.y - db.y],
  ]) {
    if (
      p === undefined ||
      width === undefined ||
      q === undefined ||
      size === undefined ||
      velocity === undefined
    )
      throw new Error("oracle fixture");
    inside &&= p < q + size && p + width > q;
    if (!velocity) {
      if (!(p < q + size && p + width > q)) return "miss";
      continue;
    }
    const divisor = BigInt(Math.abs(velocity));
    const boundaries: [Fraction, Fraction] = [
      [BigInt(velocity > 0 ? q - p - width : p - q - size), divisor],
      [BigInt(velocity > 0 ? q + size - p : p + width - q), divisor],
    ];
    const enter = boundaries[0];
    const leave = boundaries[1];
    if (cmp(enter, low) > 0n) low = enter;
    if (cmp(leave, high) < 0n) high = leave;
  }
  if (inside) return "overlap";
  if (cmp(low, high) >= 0n || cmp(low, [0n, 1n]) < 0n || cmp(low, [1n, 1n]) > 0n) return "miss";
  const divisor = gcd(low[0], low[1]);
  return `${low[0] / divisor}/${low[1] / divisor}`;
}
function gcd(a: bigint, b: bigint): bigint {
  return b === 0n ? a : gcd(b, a % b);
}

it("matches exact BigInt impact decisions over 256 reproducible seeds, translations and mirrors", () => {
  for (let seed = 1; seed <= 256; seed++) {
    let rng = seed;
    const next = (range: number) => {
      rng = randomStep(rng);
      return rng % range;
    };
    const a = { x: next(80) - 40, y: next(80) - 40, w: next(16) + 1, h: next(16) + 1 };
    const b = { x: next(80) - 40, y: next(80) - 40, w: next(16) + 1, h: next(16) + 1 };
    const da = { x: next(128) - 64, y: next(128) - 64 };
    const db = { x: next(128) - 64, y: next(128) - 64 };
    const hit = sweepAabb(a, da, b, db);
    let actual = hit?.kind ?? "miss";
    if (hit?.kind === "hit") {
      const divisor = gcd(BigInt(hit.time.numerator), BigInt(hit.time.denominator));
      actual = `${BigInt(hit.time.numerator) / divisor}/${BigInt(hit.time.denominator) / divisor}`;
    }
    expect(actual, JSON.stringify({ seed, a, da, b, db })).toBe(oracle(a, da, b, db));
    expect(sweepAabb({ ...a, x: a.x + 10000 }, da, { ...b, x: b.x + 10000 }, db)).toEqual(hit);
    const mirrored = sweepAabb(
      { ...a, x: -a.x - a.w },
      { ...da, x: -da.x },
      { ...b, x: -b.x - b.w },
      { ...db, x: -db.x },
    );
    expect(mirrored).toEqual(
      hit?.kind === "hit"
        ? { ...hit, normals: hit.normals.map((normal) => ({ x: -normal.x || 0, y: normal.y })) }
        : hit,
    );
  }
});

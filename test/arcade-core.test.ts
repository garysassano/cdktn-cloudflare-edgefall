import { describe, expect, it } from "vitest";
import { CONTRACT_FIXTURE } from "../src/game/content/contract-fixture.js";
import { validateContent } from "../src/game/content/validate.js";
import { canonical, stateHash } from "../src/game/core/canonical.js";
import {
  COUNTER_LIMIT,
  MAX_POSITION,
  compareContactTime,
  divide,
  motion,
  nextCounter,
  pixels,
  position,
  randomStep,
} from "../src/game/core/numeric.js";
import { Held, directionalIntent } from "../src/game/input/types.js";

describe("bounded deterministic arithmetic", () => {
  it("uses exact signed subpixels and stops counters before wrap", () => {
    expect(pixels(-37)).toBe(-9472);
    expect(position(MAX_POSITION)).toBe(2 ** 24);
    expect(() => position(MAX_POSITION + 1)).toThrow(RangeError);
    expect(() => motion(65537)).toThrow(RangeError);
    expect(() => pixels(0.5)).toThrow(RangeError);
    expect(nextCounter(COUNTER_LIMIT - 2)).toBe(COUNTER_LIMIT - 1);
    expect(() => nextCounter(COUNTER_LIMIT - 1)).toThrow(RangeError);
  });
  it("retains signed division remainders and compares rational contacts within proven bounds", () => {
    expect(divide(-10, 3)).toEqual({ quotient: -3, remainder: -1 });
    expect(divide(10, 3)).toEqual({ quotient: 3, remainder: 1 });
    expect(compareContactTime(1, 3, 2, 6)).toBe(0);
    expect(compareContactTime(2 ** 26, 2 ** 17, 2 ** 26 - 1, 2 ** 17)).toBe(1);
    expect(() => compareContactTime(2 ** 26 + 1, 1, 0, 1)).toThrow(RangeError);
    expect(() => divide(1, 0)).toThrow(RangeError);
  });
  it("has a fixed PRNG vector and rejects its absorbing zero state", () => {
    expect(randomStep(1)).toBe(270369);
    expect(randomStep(270369)).toBe(67634689);
    expect(() => randomStep(0)).toThrow(RangeError);
  });
});

describe("authoritative canonical state", () => {
  it("sorts record keys without changing ordered arrays or losing integer precision", () => {
    expect(canonical({ z: [3, 1], a: -0 })).toBe('{"a":0,"z":[3,1]}');
    expect(stateHash({ z: 2, a: 1 })).toBe(stateHash({ a: 1, z: 2 }));
    expect(stateHash({ a: [1, 2] })).not.toBe(stateHash({ a: [2, 1] }));
    expect(canonical(Number.MAX_SAFE_INTEGER)).toBe("9007199254740991");
  });
  it.each([NaN, Infinity, 1.5, undefined, new Date(0), { value: undefined }, new Array(3)])(
    "rejects nonportable value %#",
    (value) => {
      expect(() => canonical(value)).toThrow();
    },
  );
  it("rejects cycles instead of producing a misleading digest", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => canonical(cyclic)).toThrow(/Cyclic/);
  });
});

describe("arcade directional arbitration", () => {
  it("cancels opposing input and retains facing without manufacturing a turn", () => {
    expect(directionalIntent(Held.Left | Held.Right | Held.Up | Held.Down, -1, true)).toEqual({
      horizontal: 0,
      vertical: 0,
      facing: -1,
      crouch: false,
      aim: 0,
    });
  });
  it("crouches on the ground, aims down in the air, and aims up independently of moving", () => {
    expect(directionalIntent(Held.Down, 1, true)).toMatchObject({ crouch: true, aim: 0 });
    expect(directionalIntent(Held.Down, 1, false)).toMatchObject({ crouch: false, aim: 2 });
    expect(directionalIntent(Held.Left | Held.Up, 1, false)).toMatchObject({
      horizontal: -1,
      facing: -1,
      aim: 1,
    });
  });
});

describe("compiled actor/weapon/timeline/seat fixture", () => {
  it("links all definitions without a browser or engine", () => {
    expect(() => validateContent(CONTRACT_FIXTURE)).not.toThrow();
    expect(stateHash(CONTRACT_FIXTURE)).toMatch(/^[a-f0-9]{8}$/);
  });
  it("rejects reference, timeline, numeric, visibility and stable-ID failures", () => {
    const mutations = [
      (fixture: typeof CONTRACT_FIXTURE) => {
        fixture.shapes.push(first(fixture.shapes));
      },
      (fixture: typeof CONTRACT_FIXTURE) => {
        first(fixture.weapons).attackId = 999;
      },
      (fixture: typeof CONTRACT_FIXTURE) => {
        first(first(fixture.timelines).markers).tickOffset = 6;
      },
      (fixture: typeof CONTRACT_FIXTURE) => {
        first(fixture.poses).sockets = [];
      },
      (fixture: typeof CONTRACT_FIXTURE) => {
        first(fixture.terrain).visibleSurfaceId = "";
      },
      (fixture: typeof CONTRACT_FIXTURE) => {
        first(fixture.actors).runSpeed = 65537;
      },
      (fixture: typeof CONTRACT_FIXTURE) => {
        first(first(fixture.encounters).spawns).id = 100;
      },
      (fixture: typeof CONTRACT_FIXTURE) => {
        first(fixture.vehicles).seat.ejectionCandidates = [];
      },
    ];
    for (const mutate of mutations) {
      const fixture = structuredClone(CONTRACT_FIXTURE);
      mutate(fixture);
      expect(() => validateContent(fixture)).toThrow();
    }
  });
});

function first<T>(values: T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error("Missing test fixture item");
  return value;
}

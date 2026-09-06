import { describe, expect, it } from "vitest";
import { MAX_MOTION, pixels, randomStep } from "../src/game/core/numeric.js";
import { type KinematicState, moveKinematic } from "../src/game/physics/move.js";
import { type SweepTarget, sweepAabb } from "../src/game/physics/sweep.js";
import type { Point, Rect } from "../src/game/state.js";
import { movementProof, movingCase } from "./fixtures/movement-proof.js";

const zero = { x: 0, y: 0 };
function state(
  motion: Point = zero,
  rect: Rect = { x: 0, y: 0, w: 10, h: 10 },
  supportId: number | null = null,
): KinematicState {
  return { rect, motion, supportId };
}
function terrain(
  id: number,
  rect: Rect,
  kind: SweepTarget["kind"] = "solid",
  delta = zero,
): SweepTarget {
  return { id, rect, kind, delta };
}
const floor = terrain(1, { x: -100, y: 20, w: 200, h: 10 });

describe("bounded body resolution", () => {
  it("lands exactly, cancels only downward velocity and preserves horizontal movement", () => {
    expect(moveKinematic(state({ x: 15, y: 30 }), [floor])).toMatchObject({
      status: "complete",
      rect: { x: 15, y: 10 },
      motion: { x: 15, y: 0 },
      supportId: 1,
    });
  });
  it("slides to a second contact and does not lose the rounded tangential remainder", () => {
    const wall = terrain(2, { x: 20, y: -100, w: 1, h: 200 });
    const motion = { x: 30, y: 40 };
    expect(moveKinematic(state(motion), [wall])).toMatchObject({
      status: "complete",
      rect: { x: 10, y: 40 },
      motion: { x: 0, y: 40 },
    });
    const result = moveKinematic(state(motion), [
      wall,
      { ...floor, rect: { ...floor.rect, y: 30 } },
    ]);
    expect(result).toMatchObject({
      status: "complete",
      rect: { x: 10, y: 20 },
      motion: zero,
      supportId: 1,
      iterations: 2,
    });
    expect(result.contacts.map((contact) => contact.otherId)).toEqual([2, 1]);
  });
  it("handles ceilings and simultaneous corner contacts without arbitrary pushes", () => {
    const ceiling = terrain(4, { x: -100, y: -20, w: 200, h: 10 });
    expect(moveKinematic(state({ x: 5, y: -40 }), [ceiling])).toMatchObject({
      status: "complete",
      rect: { x: 5, y: -10 },
      motion: { x: 5, y: 0 },
      supportId: null,
    });
    const corner = terrain(5, { x: 20, y: 20, w: 10, h: 10 });
    const result = moveKinematic(state({ x: 20, y: 20 }), [corner]);
    expect(result).toMatchObject({
      status: "complete",
      rect: { x: 10, y: 10 },
      motion: zero,
      supportId: null,
    });
    expect(result.contacts.map((contact) => contact.normal)).toEqual([
      { x: -1, y: 0 },
      { x: 0, y: -1 },
    ]);
  });
  it("reports a partial pose at the configured bound, never a successful tick", () => {
    const wall = terrain(2, { x: 20, y: -100, w: 10, h: 200 });
    expect(moveKinematic(state({ x: 30, y: 40 }), [wall], { maxIterations: 1 })).toMatchObject({
      status: "contact-limit",
      rect: { x: 10, y: 13 },
      remaining: { x: 0, y: 27 },
      iterations: 1,
      diagnosticIds: [2],
    });
    expect(() => moveKinematic(state(), [], { maxIterations: 5 })).toThrow();
  });
  it("does not mutate input body or terrain", () => {
    const input = state({ x: 10, y: 30 });
    const before = structuredClone({ input, floor });
    moveKinematic(input, [floor]);
    expect({ input, floor }).toEqual(before);
  });
});

describe("persistent support and one-way platforms", () => {
  it("keeps the prior support at seams, drops it at a ledge and removes destroyed support", () => {
    const ledge = terrain(8, { x: 0, y: 20, w: 20, h: 10 });
    const seam = { ...ledge, id: 2 };
    const input = state({ x: 10, y: 0 }, { x: 5, y: 10, w: 10, h: 10 }, 8);
    const first = moveKinematic(input, [seam, ledge]);
    expect(first).toMatchObject({ rect: { x: 15, y: 10 }, supportId: 8 });
    const second = moveKinematic(first, [ledge, seam]);
    expect(second).toMatchObject({ rect: { x: 25, y: 10 }, supportId: null });
    expect(moveKinematic({ ...first, motion: { x: 0, y: 3 } }, [])).toMatchObject({
      rect: { y: 13 },
      supportId: null,
    });
  });
  it("cannot manufacture support from proximity, but retains a witnessed subpixel gap", () => {
    const above = state(zero, { x: 0, y: 9, w: 10, h: 10 });
    expect(moveKinematic(above, [floor]).supportId).toBeNull();
    expect(moveKinematic({ ...above, supportId: 1 }, [floor]).supportId).toBe(1);
    expect(
      moveKinematic({ ...above, rect: { ...above.rect, y: 8 }, supportId: 1 }, [floor]).supportId,
    ).toBeNull();
  });
  it("drops only through the selected one-way surface and lands on the next", () => {
    const upper = { ...floor, kind: "one-way" as const };
    const lower = { ...upper, id: 2, rect: { ...upper.rect, y: 40 } };
    const input = state({ x: 0, y: 50 }, { x: 0, y: 10, w: 10, h: 10 }, 1);
    expect(moveKinematic(input, [upper, lower], { ignoredOneWayId: 1 })).toMatchObject({
      status: "complete",
      rect: { y: 30 },
      supportId: 2,
    });
    expect(
      moveKinematic(state({ x: 0, y: -50 }, { x: 0, y: 50, w: 10, h: 10 }), [upper, lower]),
    ).toMatchObject({ status: "complete", rect: { y: 0 }, supportId: null });
  });
});

describe("moving geometry", () => {
  it("carries the rider sideways/upward once, retaining own motion separately", () => {
    const platform = { ...floor, delta: { x: 7, y: -3 } };
    const input = state({ x: 2, y: 0 }, { x: 10, y: 10, w: 10, h: 10 }, 1);
    expect(moveKinematic(input, [platform])).toMatchObject({
      status: "complete",
      rect: { x: 19, y: 7 },
      motion: { x: 2, y: 0 },
      supportId: 1,
    });
    expect(moveKinematic({ ...input, motion: { x: 0, y: -5 } }, [platform])).toMatchObject({
      status: "complete",
      rect: { x: 10, y: 5 },
      supportId: null,
    });
  });
  it("catches a new rider on a rising platform and resolves an approaching side wall", () => {
    const platform = { ...floor, delta: { x: 0, y: -20 } };
    expect(moveKinematic(state(), [platform])).toMatchObject({
      status: "complete",
      rect: { x: 0, y: -10 },
      motion: zero,
      supportId: 1,
    });
    const wall = terrain(2, { x: -20, y: -10, w: 10, h: 30 }, "solid", { x: 40, y: 0 });
    expect(moveKinematic(state(), [wall])).toMatchObject({
      status: "complete",
      rect: { x: 30, y: 0 },
      motion: zero,
      supportId: null,
    });
  });
  it("slides a horizontally carried rider against a wall without treating the floor as a crush", () => {
    const platform = { ...floor, delta: { x: 20, y: 0 } };
    const wall = terrain(2, { x: 25, y: -100, w: 10, h: 120 });
    expect(
      moveKinematic(state(zero, { x: 10, y: 10, w: 10, h: 10 }, 1), [platform, wall]),
    ).toMatchObject({ status: "complete", rect: { x: 15, y: 10 }, motion: zero, supportId: 1 });
  });
  it("reports incompatible upward-floor/ceiling and sideways-wall constraints as crush", () => {
    const ceiling = terrain(2, { x: -100, y: -10, w: 200, h: 10 });
    const platform = { ...floor, delta: { x: 0, y: -20 } };
    const crushed = moveKinematic(state(), [platform, ceiling]);
    expect(crushed).toMatchObject({ status: "crushed", rect: { y: 0 }, diagnosticIds: [1, 2] });
    expect(crushed.iterations).toBeLessThanOrEqual(4);
    const left = terrain(3, { x: -20, y: -20, w: 10, h: 40 }, "solid", { x: 30, y: 0 });
    const right = terrain(4, { x: 20, y: -20, w: 10, h: 40 }, "solid", { x: -10, y: 0 });
    expect(moveKinematic(state(), [right, left])).toMatchObject({
      status: "crushed",
      diagnosticIds: [3, 4],
    });
  });
  it("keeps total carry plus own motion inside the numeric contract", () => {
    const platform = { ...floor, delta: { x: MAX_MOTION, y: 0 } };
    expect(() =>
      moveKinematic(state({ x: 1, y: 0 }, { x: 0, y: 10, w: 10, h: 10 }, 1), [platform]),
    ).toThrow(/integer/);
  });

  it("never returns a penetrating completed pose across 512 seeded moving-obstacle cases", () => {
    for (let seed = 1; seed <= 512; seed++) {
      const { input, targets } = movingCase(seed);
      const result = moveKinematic(input, targets);
      expect(result).toEqual(moveKinematic(input, [...targets].reverse()));
      expect(["complete", "crushed"], JSON.stringify({ seed, input, targets, result })).toContain(
        result.status,
      );
      if (result.status === "crushed") {
        expect(result.diagnosticIds.length).toBeGreaterThanOrEqual(2);
        continue;
      }
      for (const target of targets) {
        const end = {
          ...target.rect,
          x: target.rect.x + target.delta.x,
          y: target.rect.y + target.delta.y,
        };
        expect(
          sweepAabb(result.rect, zero, end)?.kind,
          JSON.stringify({ seed, input, targets, result }),
        ).not.toBe("overlap");
      }
    }
  });

  it("proves diagonal closing traps without mistaking an early sideways escape for crush", () => {
    // Reduced reproduction of seeded case 66; the discarded obstacles are irrelevant.
    const ceiling = terrain(1, { x: -7, y: -24, w: 17, h: 12 }, "solid", { x: -36, y: 19 });
    const rising = terrain(4, { x: 0, y: 16, w: 19, h: 5 }, "solid", { x: -29, y: -38 });
    expect(moveKinematic(state({ x: -13, y: 36 }), [ceiling, rising])).toMatchObject({
      status: "crushed",
      diagnosticIds: [1, 4],
    });
    const lower = terrain(2, { x: 0, y: 20, w: 20, h: 10 }, "solid", { x: 0, y: -20 });
    const upper = terrain(3, { x: 0, y: -20, w: 20, h: 10 }, "solid", { x: 0, y: 20 });
    expect(moveKinematic(state({ x: 60, y: 0 }), [lower, upper])).toMatchObject({
      status: "complete",
      rect: { x: 60, y: 0 },
    });
  });
});

describe("bounded initial separation", () => {
  it("uses the smallest safe cardinal correction with deterministic ties", () => {
    const overlap = terrain(1, { x: 9, y: 9, w: 10, h: 10 });
    expect(moveKinematic(state(), [overlap])).toMatchObject({
      status: "complete",
      correction: { x: -1, y: 0 },
      rect: { x: -1, y: 0 },
    });
    const wall = terrain(2, { x: -2, y: -10, w: 2, h: 30 });
    expect(moveKinematic(state(), [overlap, wall])).toMatchObject({
      status: "complete",
      correction: { x: 0, y: -1 },
      rect: { x: 0, y: -1 },
    });
  });
  it("rejects deep overlap rather than teleporting or increasing the correction bound", () => {
    const large = terrain(1, { x: -1000, y: -1000, w: 2000, h: 2000 });
    expect(moveKinematic(state(), [large])).toMatchObject({
      status: "initial-overlap",
      correction: zero,
      diagnosticIds: [1],
      rect: { x: 0, y: 0 },
    });
  });
});

it.each([239, 601, 899])(
  "restores tick %i from serialized kinematics without hidden contact history",
  (tick) => {
    expect(movementProof(tick)).toEqual(movementProof());
  },
);

it("preserves nonpenetration and ordering over 100 seeded 120-tick gravity/jump routes", () => {
  const box = (
    id: number,
    x: number,
    y: number,
    w: number,
    h: number,
    kind: SweepTarget["kind"] = "solid",
  ) => terrain(id, { x: pixels(x), y: pixels(y), w: pixels(w), h: pixels(h) }, kind);
  const world = [
    box(1, -200, 120, 400, 20),
    box(2, -210, -100, 10, 240),
    box(3, 200, -100, 10, 240),
    box(4, -70, 60, 60, 4, "one-way"),
    box(5, 40, 80, 1, 40),
    box(6, -40, -40, 100, 10),
  ];
  for (let seed = 1; seed <= 100; seed++) {
    let rng = seed;
    let body = state(zero, { x: pixels(-150), y: 0, w: pixels(14), h: pixels(34) });
    for (let tick = 0; tick < 120; tick++) {
      rng = randomStep(rng);
      body.motion = {
        x: pixels((rng % 13) - 6),
        y:
          body.supportId !== null && rng % 7 === 0
            ? pixels(-10)
            : Math.min(pixels(8), body.motion.y + pixels(1)),
      };
      const result = moveKinematic(body, world);
      const diagnostic = JSON.stringify({ seed, tick, body, result });
      expect(result.status, diagnostic).toBe("complete");
      expect(result).toEqual(moveKinematic(body, [...world].reverse()));
      for (const target of world.filter((target) => target.kind === "solid"))
        expect(sweepAabb(result.rect, zero, target.rect)?.kind, diagnostic).not.toBe("overlap");
      body = result;
    }
  }
});

import { describe, expect, it } from "vitest";
import { MAX_POSITION, pixels, randomStep } from "../src/game/core/numeric.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import { moveKinematic } from "../src/game/physics/move.js";
import { type SweepBounds, type SweepTarget, sweepBounds } from "../src/game/physics/sweep.js";
import { movementProof, movingCase } from "./fixtures/movement-proof.js";
import { spatialProof } from "./fixtures/spatial-proof.js";

const zero = { x: 0, y: 0 };
const frame = { geometryRevision: 1, tick: 10 };
function target(id: number, x: number, y: number, w = 10, h = 10): SweepTarget {
  return { id, rect: { x, y, w, h }, delta: { ...zero }, kind: "solid" };
}
const ids = (values: readonly SweepTarget[]) => values.map((value) => value.id);

describe("bounded immutable spatial grid", () => {
  it("handles negative coordinates, exact cell boundaries and duplicate bucket membership", () => {
    const size = pixels(64);
    const grid = new CollisionGrid([
      target(8, -size, -size, size, size),
      target(2, 0, 0, size, size),
      target(3, size, size),
    ]);
    expect(ids(grid.query({ minX: 0, minY: 0, maxX: 0, maxY: 0 }))).toEqual([2, 8]);
    expect(ids(grid.query({ minX: size, minY: size, maxX: size, maxY: size }))).toEqual([2, 3]);
    expect(ids(grid.query({ minX: -1, minY: -1, maxX: -1, maxY: -1 }))).toEqual([8]);
    expect(ids(grid.query({ minX: -size, minY: -size, maxX: size * 2, maxY: size * 2 }))).toEqual([
      2, 3, 8,
    ]);
  });
  it("indexes a moving obstacle's whole path, including a crossing absent at both endpoints", () => {
    const moving = { ...target(4, -100, 0), delta: { x: 200, y: 0 } };
    const grid = new CollisionGrid([moving]);
    expect(ids(grid.query({ minX: 0, minY: 5, maxX: 0, maxY: 5 }))).toEqual([4]);
  });
  it("owns immutable copies of geometry and frame identity", () => {
    const original = target(1, 0, 0);
    const grid = new CollisionGrid([original]);
    original.rect.x = 1000;
    original.delta.x = 200;
    const result = grid.query({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
    expect(ids(result)).toEqual([1]);
    expect(() => {
      const first = result[0];
      if (first) first.rect.x = 20;
    }).toThrow();
    const identity = { ...frame };
    const index = new CollisionIndex(grid, [], identity);
    identity.tick++;
    expect(index.frame).toEqual(frame);
  });
  it("scans oversized entries and full-world queries without expanding millions of cells", () => {
    const grid = new CollisionGrid([target(1, -MAX_POSITION, 0, MAX_POSITION, 1), target(2, 0, 0)]);
    expect(grid.statistics.overflow).toBe(1);
    expect(ids(grid.query({ minX: -MAX_POSITION, minY: 0, maxX: -MAX_POSITION, maxY: 0 }))).toEqual(
      [1],
    );
    const full = grid.inspectQuery({
      minX: -MAX_POSITION,
      minY: -MAX_POSITION,
      maxX: MAX_POSITION,
      maxY: MAX_POSITION,
    });
    expect(full).toMatchObject({ mode: "scan", cellsVisited: 0, candidatesTested: 2 });
    expect(ids(full.targets)).toEqual([1, 2]);
  });
  it("caps aggregate bucket references without dropping overflow targets", () => {
    const size = pixels(64 * 15);
    const grid = new CollisionGrid(
      Array.from({ length: 300 }, (_, index) => target(index + 1, 0, 0, size, size)),
    );
    expect(grid.statistics).toEqual({ targets: 300, cells: 256, references: 65536, overflow: 44 });
    expect(grid.query({ minX: 0, minY: 0, maxX: 0, maxY: 0 })).toHaveLength(300);
  });
  it("rejects invalid or duplicate geometry even if no query would visit it", () => {
    expect(() => new CollisionGrid([target(1, 0, 0), target(1, 1000, 0)])).toThrow(/Duplicate/);
    expect(() => new CollisionGrid([target(1, 100000, 0, 0)])).toThrow();
    expect(() => new CollisionGrid([target(1, MAX_POSITION, 0)])).toThrow();
    expect(() => new CollisionGrid([]).query({ minX: 1, minY: 0, maxX: 0, maxY: 1 })).toThrow(
      /Inverted/,
    );
    expect(() => new CollisionGrid([]).query({ minX: NaN, minY: 0, maxX: 1, maxY: 1 })).toThrow();
  });
});

describe("collision frame integration", () => {
  it("preserves the long movement trace and engineering workload for either cell size", () => {
    const reference = movementProof();
    for (const cell of [32, 64] as const) expect(movementProof(601, cell)).toEqual(reference);
    const proof = spatialProof();
    expect(proof.cells.map((cell) => cell.traceHash)).toEqual([
      proof.referenceHash,
      proof.referenceHash,
    ]);
  });
  it("rejects stale/missing frame identity and overlapping static/dynamic IDs", () => {
    const fixed = new CollisionGrid([target(1, 0, 20)]);
    const index = new CollisionIndex(fixed, [], frame);
    const body = { rect: { x: 0, y: 0, w: 10, h: 10 }, motion: zero, supportId: null };
    expect(() => moveKinematic(body, index)).toThrow(/frame identity/);
    expect(() => moveKinematic(body, index, { frame: { ...frame, tick: 11 } })).toThrow(
      /frame identity/,
    );
    expect(() => moveKinematic(body, index, { frame: { ...frame, geometryRevision: 2 } })).toThrow(
      /frame identity/,
    );
    expect(() => new CollisionIndex(fixed, [target(1, 0, 30)], frame)).toThrow(/Duplicate/);
    expect(
      () =>
        new CollisionIndex(
          new CollisionGrid([{ ...target(2, 0, 0), delta: { x: 1, y: 0 } }]),
          [],
          frame,
        ),
    ).toThrow(/Static/);
  });
  it("requeries after a moving wall pushes the body toward a previously irrelevant obstacle", () => {
    const fixed = target(2, 25, -10, 10, 30);
    const moving = { ...target(1, -20, -10, 10, 30), delta: { x: 40, y: 0 } };
    const index = new CollisionIndex(new CollisionGrid([fixed]), [moving], frame);
    const body = { rect: { x: 0, y: 0, w: 10, h: 10 }, motion: zero, supportId: null };
    expect(ids(index.query(sweepBounds(body.rect)))).toEqual([1]);
    const result = moveKinematic(body, index, { frame });
    expect(result).toEqual(moveKinematic(body, [fixed, moving]));
    expect(result).toMatchObject({ status: "crushed", diagnosticIds: [1, 2] });
  });
  it("matches the full solver for 512 moving cases and both cell sizes, including distant geometry", () => {
    const distant = Array.from({ length: 32 }, (_, index) =>
      target(100 + index, pixels(1000 + index * 64), pixels(-400), pixels(32), pixels(16)),
    );
    const grids = [new CollisionGrid(distant, 32), new CollisionGrid([...distant].reverse(), 64)];
    for (let seed = 1; seed <= 512; seed++) {
      const { input, targets } = movingCase(seed);
      const expected = moveKinematic(input, [...distant, ...targets]);
      for (const fixed of grids) {
        const index = new CollisionIndex(fixed, [...targets].reverse(), frame);
        expect(
          moveKinematic(input, index, { frame }),
          `seed ${seed}, cell ${fixed.cellPixels}`,
        ).toEqual(expected);
      }
    }
  });
});

function oracle(target: SweepTarget, query: SweepBounds): boolean {
  const a = target.rect;
  const endX = a.x + target.delta.x;
  const endY = a.y + target.delta.y;
  return (
    Math.min(a.x, endX) <= query.maxX &&
    Math.max(a.x + a.w, endX + a.w) >= query.minX &&
    Math.min(a.y, endY) <= query.maxY &&
    Math.max(a.y + a.h, endY + a.h) >= query.minY
  );
}

it("matches exhaustive closed-bound queries across 128 seeds and both cell sizes", () => {
  for (let seed = 1; seed <= 128; seed++) {
    let rng = seed;
    const next = (range: number) => {
      rng = randomStep(rng);
      return rng % range;
    };
    const targets = Array.from({ length: 64 }, (_, index) => ({
      ...target(
        index + 1,
        pixels(next(2000) - 1000),
        pixels(next(2000) - 1000),
        pixels(next(64) + 1),
        pixels(next(64) + 1),
      ),
      delta: { x: pixels(next(64) - 32), y: pixels(next(64) - 32) },
    }));
    const grids = [new CollisionGrid(targets, 32), new CollisionGrid([...targets].reverse(), 64)];
    for (let sample = 0; sample < 16; sample++) {
      const minX = pixels(next(2000) - 1000);
      const minY = pixels(next(2000) - 1000);
      const query = { minX, minY, maxX: minX + pixels(next(256)), maxY: minY + pixels(next(256)) };
      const expected = ids(targets.filter((target) => oracle(target, query)));
      for (const grid of grids)
        expect(
          ids(grid.query(query)),
          JSON.stringify({ seed, sample, query, cell: grid.cellPixels }),
        ).toEqual(expected);
    }
  }
});

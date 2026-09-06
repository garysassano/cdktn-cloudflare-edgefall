import { describe, expect, it } from "vitest";
import { WalkSurface } from "../src/game/navigation/spans.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";

const shape = { id: 1, rect: { x: -2, y: -4, w: 4, h: 4 } };
function tile(
  id: number,
  x: number,
  y: number,
  w: number,
  h: number,
  kind: "solid" | "one-way" = "solid",
): SweepTarget {
  return { id, rect: { x, y, w, h }, kind, delta: { x: 0, y: 0 } };
}
describe("compiled walkable surfaces", () => {
  it("merges coplanar tile seams before applying full-foot clearance", () => {
    const graph = new WalkSurface([tile(2, 0, 0, 10, 4), tile(1, -10, 0, 10, 4)], shape, 1);
    expect(graph.spans).toHaveLength(2);
    expect(graph.locate(0, 0, 1, 1)).toMatchObject({ minX: -8, maxX: 8, supportIds: [1, 2] });
    expect(graph.locate(9, 0, 1, 1)).toBe(null);
  });
  it("splits clearance at solid walls but permits touching ceilings and one-way undersides", () => {
    const graph = new WalkSurface(
      [
        tile(1, -20, 0, 40, 4),
        tile(2, -1, -8, 2, 8),
        tile(3, -18, -6, 4, 2),
        tile(4, 8, -2, 5, 1, "one-way"),
      ],
      shape,
      1,
    );
    expect(graph.locate(-3, 0, 1, 1)).not.toBe(null);
    expect(graph.locate(-2, 0, 1, 1)).toBe(null);
    expect(graph.locate(3, 0, 1, 1)).not.toBe(null);
    expect(graph.locate(-16, 0, 1, 1)).not.toBe(null);
    expect(graph.locate(10, 0, 1, 1)).not.toBe(null);
  });
  it("compiles asymmetric facing clearance and invalidates removed-bridge revisions", () => {
    const asym = { id: 2, rect: { x: 0, y: -4, w: 4, h: 4 } };
    const graph = new WalkSurface([tile(1, 0, 0, 20, 4)], asym, 3);
    expect(graph.locate(0, 0, 1, 3)).not.toBe(null);
    expect(graph.locate(0, 0, -1, 3)).toBe(null);
    expect(() => graph.locate(10, 0, 1, 4)).toThrow("Stale");
    expect(new WalkSurface([], asym, 4).locate(10, 0, 1, 4)).toBe(null);
  });
  it("rejects moving or non-foot geometry rather than pretending to prove its navigation", () => {
    expect(
      () => new WalkSurface([{ ...tile(1, 0, 0, 20, 4), delta: { x: 1, y: 0 } }], shape, 1),
    ).toThrow("moving");
    expect(() => new WalkSurface([], { id: 1, rect: { ...shape.rect, y: -3 } }, 1)).toThrow("feet");
  });
  it("fails explicitly when authored clearance work exceeds the compiler budget", () => {
    const overlappingFloors = Array.from({ length: 1200 }, (_, id) =>
      tile(id + 1, 0, id, 100, 1200),
    );
    expect(() => new WalkSurface(overlappingFloors, shape, 1)).toThrow("work exceeds bound");
  });
  it("matches an independent per-column support and rectangle-overlap oracle", () => {
    for (let seed = 0; seed < 32; seed++) {
      const targets = [
        tile(1, -20, 0, 40, 4),
        tile(2, -10 + (seed % 8), -8, 3 + (seed % 3), 8),
        tile(3, 4 + (seed % 5), -3, 5, 1, seed % 2 ? "solid" : "one-way"),
      ];
      const graph = new WalkSurface(targets, shape, 1);
      expect(new WalkSurface([...targets].reverse(), shape, 1).spans).toEqual(graph.spans);
      for (const facing of [-1, 1] as const)
        for (const y of [0, -8, -3])
          for (let x = -25; x <= 25; x++) {
            const left = x + (facing === 1 ? shape.rect.x : -shape.rect.x - shape.rect.w);
            const supported = Array.from({ length: shape.rect.w }, (_, col) => left + col).every(
              (col) =>
                targets.some((t) => t.rect.y === y && col >= t.rect.x && col < t.rect.x + t.rect.w),
            );
            const blocked = targets.some(
              (t) =>
                t.kind === "solid" &&
                left < t.rect.x + t.rect.w &&
                left + shape.rect.w > t.rect.x &&
                y - shape.rect.h < t.rect.y + t.rect.h &&
                y > t.rect.y,
            );
            expect(graph.locate(x, y, facing, 1) !== null).toBe(supported && !blocked);
          }
    }
  });
});

import { randomStep } from "../../src/game/core/numeric.js";
import { earliestSweep, sweepAabb, sweepOneWay } from "../../src/game/physics/sweep.js";

/** Identical seeded narrow-phase inputs in Node, browser and Worker; no runtime clocks. */
export function collisionProof() {
  const samples = Array.from({ length: 256 }, (_, index) => {
    let rng = index + 1;
    const next = (range: number) => {
      rng = randomStep(rng);
      return rng % range;
    };
    const a = { x: next(80) - 40, y: next(80) - 40, w: next(16) + 1, h: next(16) + 1 };
    const b = { x: next(80) - 40, y: next(80) - 40, w: next(16) + 1, h: next(16) + 1 };
    const da = { x: next(128) - 64, y: next(128) - 64 };
    const db = { x: next(128) - 64, y: next(128) - 64 };
    return { seed: index + 1, solid: sweepAabb(a, da, b, db), oneWay: sweepOneWay(a, da, b, db) };
  });
  const body = { x: 0, y: 0, w: 10, h: 10 };
  const ties = earliestSweep(body, { x: 20, y: 20 }, [
    { id: 9, rect: { x: 20, y: 20, w: 10, h: 10 }, delta: { x: 0, y: 0 }, kind: "solid" },
    { id: 2, rect: { x: 20, y: -10, w: 10, h: 100 }, delta: { x: 0, y: 0 }, kind: "solid" },
  ]);
  return { samples, ties };
}

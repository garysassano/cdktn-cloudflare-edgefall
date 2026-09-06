import { stateHash } from "../../src/game/core/canonical.js";
import { WalkSurface } from "../../src/game/navigation/spans.js";
import type { SweepTarget } from "../../src/game/physics/sweep.js";

export function navigationProof() {
  const targets: SweepTarget[] = [
    { id: 1, kind: "solid", rect: { x: -100, y: 0, w: 100, h: 10 }, delta: { x: 0, y: 0 } },
    { id: 2, kind: "solid", rect: { x: 0, y: 0, w: 100, h: 10 }, delta: { x: 0, y: 0 } },
    { id: 3, kind: "solid", rect: { x: 20, y: -40, w: 10, h: 40 }, delta: { x: 0, y: 0 } },
    { id: 4, kind: "one-way", rect: { x: -80, y: -20, w: 40, h: 4 }, delta: { x: 0, y: 0 } },
  ];
  const shape = { id: 1, rect: { x: -3, y: -18, w: 10, h: 18 } };
  const spans = new WalkSurface(targets, shape, 1).spans;
  const reversed = new WalkSurface([...targets].reverse(), shape, 1).spans;
  const removed = new WalkSurface(
    targets.filter((target) => target.id !== 4),
    shape,
    2,
  ).spans;
  return { spans, reversed, removed, traceHash: stateHash({ spans, reversed, removed }) };
}

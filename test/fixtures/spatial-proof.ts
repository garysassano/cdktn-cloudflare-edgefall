import { stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import { CollisionGrid, CollisionIndex } from "../../src/game/physics/grid.js";
import { type KinematicState, moveKinematic } from "../../src/game/physics/move.js";
import { type SweepTarget, sweepBounds } from "../../src/game/physics/sweep.js";

export const SPATIAL_FRAME = { geometryRevision: 1, tick: 1 };

/** Broadphase engineering workload, not authored campaign geometry or combat. */
export function spatialScene() {
  const fixed: SweepTarget[] = Array.from({ length: 512 }, (_, index) => ({
    id: index + 1,
    rect: {
      x: pixels((index % 32) * 96),
      y: pixels(Math.floor(index / 32) * 96 + 64),
      w: pixels(64),
      h: pixels(16),
    },
    kind: index % 3 === 0 ? "one-way" : "solid",
    delta: { x: 0, y: 0 },
  }));
  const moving: SweepTarget[] = Array.from({ length: 32 }, (_, index) => {
    const base = fixed[index * 13];
    if (!base) throw new Error("Missing spatial moving fixture");
    return {
      id: 1000 + index,
      rect: {
        x: base.rect.x + pixels(80),
        y: base.rect.y - pixels(64),
        w: pixels(8),
        h: pixels(80),
      },
      kind: "solid",
      delta: { x: pixels(index % 2 === 0 ? -64 : 16), y: 0 },
    };
  });
  const bodies: KinematicState[] = Array.from({ length: 64 }, (_, index) => {
    const base = fixed[index * 7];
    if (!base) throw new Error("Missing spatial actor fixture");
    return {
      rect: {
        x: base.rect.x + pixels(8),
        y: base.rect.y - pixels(34),
        w: pixels(14),
        h: pixels(34),
      },
      motion: { x: pixels(index % 2 === 0 ? 3 : -3), y: 55 },
      supportId: base.id,
    };
  });
  return { fixed, moving, bodies };
}

export function spatialProof() {
  const scene = spatialScene();
  const reference = scene.bodies.map((body) =>
    moveKinematic(body, [...scene.fixed, ...scene.moving]),
  );
  if (reference.some((result) => result.status !== "complete"))
    throw new Error("Spatial fixture did not complete");
  const cells = ([32, 64] as const).map((cellPixels) => {
    const fixed = new CollisionGrid([...scene.fixed].reverse(), cellPixels);
    const index = new CollisionIndex(fixed, [...scene.moving].reverse(), SPATIAL_FRAME);
    const outcomes = scene.bodies.map((body) =>
      moveKinematic(body, index, { frame: SPATIAL_FRAME }),
    );
    if (JSON.stringify(outcomes) !== JSON.stringify(reference))
      throw new Error(`Spatial result mismatch: ${cellPixels}`);
    return {
      cellPixels,
      staticGrid: fixed.statistics,
      dynamicGrid: index.dynamic.statistics,
      initialCandidates: scene.bodies.map(
        (body) => index.query(sweepBounds(body.rect, body.motion)).length,
      ),
      outcomes,
      traceHash: stateHash(outcomes),
    };
  });
  return {
    fixed: scene.fixed.length,
    moving: scene.moving.length,
    bodies: scene.bodies.length,
    referenceHash: stateHash(reference),
    cells,
  };
}

import { describe, expect, it } from "vitest";
import { type GroundedEnemy, stepGroundedEnemy } from "../src/game/actors/grounded.js";
import { pixels } from "../src/game/core/numeric.js";
import {
  createControllerLab,
  labFingerprint,
  replayControllerLab,
  stepControllerLab,
} from "../src/game/labs/controller.js";
import { FOOT_SHAPES, footActor, footTerrain } from "../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import { moveKinematic } from "../src/game/physics/move.js";
import type { SweepTarget } from "../src/game/physics/sweep.js";
import { groundedProof, seamProof } from "./fixtures/grounded-proof.js";

const shape = FOOT_SHAPES.get(1);
if (!shape) throw new Error("Missing fixture shape");
const definition = {
  speed: pixels(1),
  gravity: 55,
  terminalVelocity: pixels(12),
  bounds: { x: pixels(-400), y: pixels(-300), w: pixels(800), h: pixels(500) },
};
function enemy(x = 0, y = 0): GroundedEnemy {
  return {
    body: footActor(x, y).body,
    facing: 1,
    geometryRevision: 1,
    life: "alive",
    removalReason: null,
    turns: 0,
  };
}
function advance(current: GroundedEnemy, targets: SweepTarget[], tick = 1, revision = 1) {
  if (!shape) throw new Error("Missing fixture shape");
  const frame = { tick, geometryRevision: revision };
  return stepGroundedEnemy(
    current,
    definition,
    shape,
    new CollisionIndex(
      new CollisionGrid(targets.filter((t) => t.delta.x === 0 && t.delta.y === 0)),
      targets.filter((t) => t.delta.x !== 0 || t.delta.y !== 0),
      frame,
    ),
    frame,
  );
}
function accepted(result: ReturnType<typeof advance>): GroundedEnemy {
  if (result.status !== "complete") throw new Error(result.physics.reason);
  return result.enemy;
}
describe("grounded enemy patrol", () => {
  it("crosses floor, ceiling and wall seams without losing tangential motion", () => {
    for (const result of seamProof().results) {
      expect(result.forward.status).toBe("complete");
      expect(result.forward.rect).toEqual(result.expected);
      expect(result.forward).toEqual(result.reverse);
    }
  });
  it("only releases a moving seam when the supporting planes have equal motion", () => {
    const body = { rect: { x: 0, y: 0, w: 10, h: 10 }, motion: { x: 5, y: 2 }, supportId: null };
    const targets: SweepTarget[] = [
      { id: 1, kind: "solid", rect: { x: -20, y: 10, w: 30, h: 10 }, delta: { x: 0, y: -1 } },
      { id: 2, kind: "solid", rect: { x: 10, y: 10, w: 30, h: 10 }, delta: { x: 0, y: -1 } },
    ];
    expect(moveKinematic(body, targets)).toMatchObject({
      status: "complete",
      rect: { x: 5, y: -1 },
    });
    const first = targets[0];
    if (!first) throw new Error("Missing floor");
    first.delta.y = 0;
    expect(moveKinematic(body, targets)).toMatchObject({
      status: "complete",
      rect: { x: 0, y: -1 },
    });
  });
  it("resolves crush as an explicit removal instead of accepting the partial body", () => {
    const state = enemy();
    const result = advance(state, [
      footTerrain(100, -100, 0, 200, 8),
      { ...footTerrain(101, -100, -40, 200, 4), delta: { x: 0, y: pixels(3) } },
    ]);
    expect(result.status).toBe("complete");
    const next = accepted(result);
    expect(next.life).toBe("removed");
    expect(next.removalReason).toBe("crushed");
    expect(next.body).toEqual(state.body);
  });
  it("restores the portable patrol trace without a player-target height shortcut", () => {
    expect(groundedProof(600)).toEqual(groundedProof());
  });
  it("never walks off either end across narrow and wide seeded platforms", () => {
    for (let seed = 1; seed <= 64; seed++) {
      const width = 16 + ((seed * 37) % 220);
      const floor = footTerrain(100, -width, 0, width * 2, 8);
      let state = enemy();
      for (let tick = 1; tick <= 480; tick++) {
        state = accepted(advance(state, [floor], tick));
        expect(state.body.supportId).toBe(100);
        expect(state.body.y).toBe(0);
        expect(state.body.x - pixels(7)).toBeGreaterThanOrEqual(floor.rect.x);
        expect(state.body.x + pixels(7)).toBeLessThanOrEqual(floor.rect.x + floor.rect.w);
      }
      expect(state.turns).toBeGreaterThan(0);
    }
  });
  it("cannot skip a narrow unsupported gap with a fast step", () => {
    if (!shape) throw new Error("Missing shape");
    const frame = { tick: 1, geometryRevision: 1 };
    const index = new CollisionIndex(
      new CollisionGrid([footTerrain(100, -100, 0, 100, 8), footTerrain(101, 10, 0, 100, 8)]),
      [],
      frame,
    );
    const result = stepGroundedEnemy(
      enemy(-10),
      { ...definition, speed: pixels(20) },
      shape,
      index,
      frame,
    );
    const next = accepted(result);
    expect(next.body.x).toBe(pixels(-10));
    expect(next.facing).toBe(-1);
  });
  it("crosses adjacent coplanar supports and is invariant to geometry order", () => {
    const targets = [footTerrain(100, -100, 0, 100, 8), footTerrain(101, 0, 0, 100, 8)];
    let a = enemy(-20),
      b = enemy(-20);
    for (let tick = 1; tick <= 100; tick++) {
      a = accepted(advance(a, targets, tick));
      b = accepted(advance(b, [...targets].reverse(), tick));
      expect(a).toEqual(b);
    }
    expect(a.body.x).toBe(pixels(80));
    expect(a.body.supportId).toBe(101);
  });
  it("carries once on moving support and falls when it is removed at a new revision", () => {
    let state = enemy();
    for (let tick = 0; tick < 20; tick++)
      state = accepted(
        advance(
          state,
          [{ ...footTerrain(100, -100 + tick * 2, 0, 200, 8), delta: { x: pixels(2), y: 0 } }],
          tick + 1,
        ),
      );
    expect(state.body.x).toBe(pixels(60));
    expect(() => advance(state, [], 21, 2)).toThrow("revision");
    state = accepted(advance({ ...state, geometryRevision: 2 }, [], 21, 2));
    expect(state.body.grounded).toBe(false);
    expect(state.body.y).toBe(55);
  });
  it("does not reacquire support while an external upward impulse leaves the plane", () => {
    const state = enemy();
    state.body.vy = -400;
    const next = accepted(advance(state, [footTerrain(100, -100, 0, 200, 8)]));
    expect(next.body.y).toBe(-345);
    expect(next.body.supportId).toBe(null);
  });
  it("turns away from a wall without accumulating penetration", () => {
    let state = enemy();
    const targets = [footTerrain(100, -100, 0, 200, 8), footTerrain(101, 20, -50, 10, 50)];
    for (let tick = 1; tick <= 40; tick++) {
      state = accepted(advance(state, targets, tick));
      expect(state.body.x).toBeLessThanOrEqual(pixels(13));
    }
    expect(state.facing).toBe(-1);
    expect(state.turns).toBe(1);
  });
  it("does not turn from a stale contact after a wall is removed", () => {
    let state = enemy();
    const floor = footTerrain(100, -100, 0, 200, 8);
    const wall = footTerrain(101, 20, -50, 10, 50);
    for (let tick = 1; tick <= 13; tick++) state = accepted(advance(state, [floor, wall], tick));
    expect(state.body.x).toBe(pixels(13));
    state = accepted(advance({ ...state, geometryRevision: 2 }, [floor], 14, 2));
    expect(state.body.x).toBe(pixels(14));
    expect(state.facing).toBe(1);
  });
  it("removes out-of-bounds enemies once and does not award a player kill", () => {
    let state = enemy();
    state.body.supportId = null;
    state.body.grounded = false;
    for (let tick = 1; tick <= 100; tick++) state = accepted(advance(state, [], tick));
    expect(state.life).toBe("removed");
    expect(state.removalReason).toBe("out-of-bounds");
    expect(accepted(advance(state, [], 101))).toBe(state);
  });
  it("returns no accepted enemy for an invalid authored spawn", () => {
    const result = advance(enemy(), [footTerrain(100, -100, -20, 200, 40)]);
    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("enemy");
  });
  it("keeps the rendered lab enemy grounded while the player jumps, then drops after removal and replays", () => {
    let state = createControllerLab("enemy-ledge");
    const commands = Array.from({ length: 400 }, (_, tick) => ({
      held: 0,
      jumpPressed: tick % 60 === 0,
      startTraversal: false,
      removePlatform: tick === 300,
    }));
    for (const [tick, command] of commands.entries()) {
      state = stepControllerLab(state, command);
      if (tick < 300) {
        expect(state.enemy?.body.y).toBe(pixels(230));
        expect(state.enemy?.body.supportId).toBe(110);
      }
    }
    expect(state.enemy?.turns).toBeGreaterThan(0);
    expect(state.enemy?.body.supportId).toBe(100);
    expect(state.enemy?.body.y).toBe(pixels(300));
    expect(
      labFingerprint(
        replayControllerLab({
          format: 6,
          scenario: "enemy-ledge",
          commands,
          finalState: labFingerprint(state),
        }),
      ),
    ).toBe(labFingerprint(state));
  });
});

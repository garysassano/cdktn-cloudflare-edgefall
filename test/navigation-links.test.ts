import { describe, expect, it } from "vitest";
import { pixels } from "../src/game/core/numeric.js";
import {
  createControllerLab,
  labFingerprint,
  replayControllerLab,
  stepControllerLab,
} from "../src/game/labs/controller.js";
import { FOOT_DEFINITION, FOOT_SHAPES, footTerrain } from "../src/game/labs/foot-fixture.js";
import { traversalFixture } from "../src/game/labs/traversal.js";
import {
  CompiledTraversal,
  type TraversalCursor,
  type TraversalStep,
} from "../src/game/navigation/links.js";
import { WalkSurface } from "../src/game/navigation/spans.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import type { ControlledActor } from "../src/game/state.js";

function fixture(kind: "jump" | "drop" = "jump") {
  return traversalFixture(kind);
}
describe("authored traversal links", () => {
  it.each(["jump", "drop"] as const)(
    "compiles and executes %s with exact tick/state restoration",
    (kind) => {
      const { actor: initial, targets, link } = fixture(kind);
      expect(link.commands.length).toBe(kind === "jump" ? 51 : 27);
      let actor: ControlledActor = initial;
      let cursor: TraversalCursor | null = link.begin(actor, 500);
      for (let elapsed = 0; elapsed < link.commands.length; elapsed++) {
        if (!cursor) throw new Error("Unexpected completion");
        const frame = { tick: 501 + elapsed, geometryRevision: 1 };
        const index = new CollisionIndex(new CollisionGrid(targets), [], frame);
        const result: TraversalStep = link.step(actor, cursor, index, frame);
        const restored = link.step(
          JSON.parse(JSON.stringify(actor)),
          JSON.parse(JSON.stringify(cursor)),
          index,
          frame,
        );
        expect(restored).toEqual(result);
        if (result.status === "failed" || result.status === "cancelled")
          throw new Error("Invalid fixture traversal");
        actor = result.actor;
        cursor = result.cursor;
        expect(actor.body.x).toBe(link.poses[elapsed + 1]?.x);
        expect(actor.body.y).toBe(link.poses[elapsed + 1]?.y);
        expect(result.status).toBe(elapsed + 1 === link.commands.length ? "landed" : "active");
      }
      expect(actor.body.supportId).toBe(101);
      expect(cursor).toBe(null);
      expect(link.commands.filter((command) => command.jumpPressed)).toHaveLength(1);
      expect(initial.body.y).toBe(pixels(kind === "jump" ? 300 : 220));
    },
  );
  it("compiles a mirrored authored route with the same vertical arc", () => {
    const original = fixture();
    const definition = FOOT_DEFINITION;
    const shape = FOOT_SHAPES.get(1);
    if (!definition || !shape) throw new Error("Missing definitions");
    const actor = {
      ...original.actor,
      facing: -1 as const,
      body: { ...original.actor.body, x: -original.actor.body.x },
    };
    const targets = original.targets.map((target) => ({
      ...target,
      rect: { ...target.rect, x: -target.rect.x - target.rect.w },
    }));
    const surface = new WalkSurface(targets, shape, 1);
    const from = surface.locate(actor.body.x, actor.body.y, -1, 1);
    const to = surface.locate(pixels(-253), pixels(300), -1, 1);
    if (!from || !to) throw new Error("Missing mirrored endpoints");
    const mirrored = new CompiledTraversal(
      {
        ...original.authored,
        sourceSpanId: from.id,
        sourceX: actor.body.x,
        destinationSpanId: to.id,
        destinationMinX: pixels(-400),
        destinationMaxX: pixels(-220),
        direction: -1,
      },
      actor,
      definition,
      FOOT_SHAPES,
      targets,
      surface,
    );
    expect(mirrored.poses).toEqual(
      original.link.poses.map((pose) => ({ ...pose, x: -pose.x, facing: -1 })),
    );
  });
  it("rejects unsafe source, destination, duration, surface and blocked trajectories", () => {
    const { actor, targets, authored, surface } = fixture();
    if (!FOOT_DEFINITION) throw new Error("Missing actor definition");
    const definition = FOOT_DEFINITION;
    const compile = (change: Partial<typeof authored> = {}, terrain = targets, source = actor) =>
      new CompiledTraversal(
        { ...authored, ...change },
        source,
        definition,
        FOOT_SHAPES,
        terrain,
        surface,
      );
    expect(() => compile({ sourceX: actor.body.x + 1 })).toThrow("endpoints");
    expect(() => compile({ destinationMinX: pixels(300) })).toThrow("landing");
    expect(() => compile({ maxTicks: 2 })).toThrow("duration");
    expect(() => compile({ maxTicks: 181 })).toThrow("duration");
    expect(() => compile({}, targets, { ...actor, body: { ...actor.body, vx: 1 } })).toThrow(
      "neutral",
    );
    expect(() => compile({ kind: "drop" })).toThrow("one-way");
    expect(() =>
      compile(
        {},
        targets.filter((t) => t.id !== 101),
      ),
    ).toThrow("surface/geometry");
    const roof = [...targets, footTerrain(102, 140, 215, 50, 8)];
    const shape = FOOT_SHAPES.get(1);
    if (!shape) throw new Error("Missing shape");
    const newSurface = new WalkSurface(roof, shape, 1);
    const from = newSurface.locate(actor.body.x, actor.body.y, 1, 1);
    const to = newSurface.locate(pixels(253), pixels(300), 1, 1);
    if (!from || !to) throw new Error("Missing endpoints");
    expect(
      () =>
        new CompiledTraversal(
          { ...authored, sourceSpanId: from.id, destinationSpanId: to.id },
          actor,
          definition,
          FOOT_SHAPES,
          roof,
          newSurface,
        ),
    ).toThrow("clearance");
  });
  it("cancels a removed destination but continues actual airborne gravity once", () => {
    const { actor: initial, targets, link } = fixture();
    let actor: ControlledActor = initial;
    let cursor = link.begin(actor, 0);
    for (let tick = 1; tick <= 10; tick++) {
      const frame = { tick, geometryRevision: 1 };
      const result: TraversalStep = link.step(
        actor,
        cursor,
        new CollisionIndex(new CollisionGrid(targets), [], frame),
        frame,
      );
      if (result.status !== "active" || !result.cursor) throw new Error("Unexpected result");
      actor = result.actor;
      cursor = result.cursor;
    }
    const frame = { tick: 11, geometryRevision: 2 };
    const result: TraversalStep = link.step(
      actor,
      cursor,
      new CollisionIndex(new CollisionGrid(targets.filter((t) => t.id !== 101)), [], frame),
      frame,
    );
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") throw new Error("Missing cancellation");
    expect(result.reason).toBe("geometry");
    expect(result.cursor).toBe(null);
    expect(result.actor.body.y).toBe(actor.body.y + actor.body.vy + 55);
    expect(result.actor.body.vx).toBe(0);
    expect(
      result.result.status === "complete" && result.result.events.some((e) => e.kind === "jump"),
    ).toBe(false);
  });
  it("cancels newly blocking geometry at the actual collision pose and exposes failures without an actor", () => {
    const { actor, targets, link } = fixture();
    const cursor = link.begin(actor, 0);
    const frame = { tick: 1, geometryRevision: 1 };
    const wall = [...targets, footTerrain(102, 107, 200, 10, 100)];
    const result: TraversalStep = link.step(
      actor,
      cursor,
      new CollisionIndex(new CollisionGrid(wall), [], frame),
      frame,
    );
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") throw new Error("Missing cancellation");
    expect(result.reason).toBe("trajectory");
    expect(result.actor.body.x).toBe(actor.body.x);
    const blocked = [...targets, footTerrain(102, 90, 260, 50, 40)];
    const failure = link.step(
      actor,
      cursor,
      new CollisionIndex(new CollisionGrid(blocked), [], frame),
      frame,
    );
    expect(failure.status).toBe("failed");
    expect(failure).not.toHaveProperty("actor");
  });
  it.each(["jump-link", "drop-link"] as const)(
    "records %s launch, duplicate request and exact replay",
    (scenario) => {
      let state = createControllerLab(scenario);
      const commands = Array.from({ length: 60 }, (_, tick) => ({
        held: 0,
        jumpPressed: false,
        removePlatform: false,
        startTraversal: tick === 0 || tick === 10,
      }));
      let launches = 0;
      for (const command of commands) {
        state = stepControllerLab(state, command);
        if (state.result?.status === "complete")
          launches += state.result.events.filter(
            (event) => event.kind === "jump" || event.kind === "drop",
          ).length;
      }
      expect(launches).toBe(1);
      expect(state.traversalStatus).toBe("landed");
      expect(state.actor.body.supportId).toBe(101);
      expect(
        labFingerprint(
          replayControllerLab({ format: 5, scenario, commands, finalState: labFingerprint(state) }),
        ),
      ).toBe(labFingerprint(state));
    },
  );
  it("rejects stale ticks and cancels unexpected state without snapping to a sample", () => {
    const { actor, targets, link } = fixture();
    const cursor = link.begin(actor, 0);
    const frame = { tick: 2, geometryRevision: 1 };
    expect(() =>
      link.step(actor, cursor, new CollisionIndex(new CollisionGrid(targets), [], frame), frame),
    ).toThrow("tick/cursor");
    const nextFrame = { tick: 1, geometryRevision: 1 };
    const changed = { ...actor, body: { ...actor.body, x: actor.body.x + 10 } };
    const result: TraversalStep = link.step(
      changed,
      cursor,
      new CollisionIndex(new CollisionGrid(targets), [], nextFrame),
      nextFrame,
    );
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") throw new Error("Missing cancellation");
    expect(result.reason).toBe("state");
    expect(result.actor.body.x).toBe(changed.body.x);
  });
});

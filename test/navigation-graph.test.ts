import { describe, expect, it } from "vitest";
import { stepFootController } from "../src/game/controller/foot.js";
import { pixels } from "../src/game/core/numeric.js";
import { Held } from "../src/game/input/types.js";
import {
  createControllerLab,
  labFingerprint,
  replayControllerLab,
  stepControllerLab,
} from "../src/game/labs/controller.js";
import { FOOT_SHAPES } from "../src/game/labs/foot-fixture.js";
import { routeFixture } from "../src/game/labs/route.js";
import type { RouteStep } from "../src/game/navigation/follower.js";
import { type RouteCursor, RouteFollower } from "../src/game/navigation/follower.js";
import { NavigationGraph } from "../src/game/navigation/graph.js";
import { CompiledTraversal } from "../src/game/navigation/links.js";
import { WalkSurface } from "../src/game/navigation/spans.js";
import { CollisionGrid, CollisionIndex } from "../src/game/physics/grid.js";
import type { ControlledActor } from "../src/game/state.js";

describe("navigation route selection", () => {
  it("executes the selected two-link route through real controller inputs and reaches the exact goal", () => {
    const { actor: initial, graph, destination, targets, definition, links } = routeFixture();
    const route = graph.route({ ...initial.body, facing: initial.facing }, destination, 1);
    expect(route.status).toBe("route");
    if (route.status !== "route") throw new Error("Missing route");
    expect(route.linkIds).toEqual([1, 2]);
    expect(route.costTicks).toBe(117);
    let actor: ControlledActor = initial,
      tick = 0;
    for (const leg of route.legs) {
      if (leg.kind === "traverse") {
        const link = links.find((value) => value.id === leg.linkId);
        if (!link) throw new Error("Missing link");
        let cursor = link.begin(actor, tick);
        for (let i = 0; i < leg.ticks; i++) {
          const frame = { tick: ++tick, geometryRevision: 1 };
          const result = link.step(
            actor,
            cursor,
            new CollisionIndex(new CollisionGrid(targets), [], frame),
            frame,
          );
          if (result.status !== "active" && result.status !== "landed")
            throw new Error("Route execution failed");
          actor = result.actor;
          if (result.cursor) cursor = result.cursor;
        }
      } else
        for (let i = 0; i < leg.ticks; i++) {
          const frame = { tick: ++tick, geometryRevision: 1 };
          const result = stepFootController(
            actor,
            {
              held: leg.kind === "walk" ? (leg.direction === 1 ? Held.Right : Held.Left) : 0,
              jumpPressed: false,
            },
            definition,
            FOOT_SHAPES,
            new CollisionIndex(new CollisionGrid(targets), [], frame),
            frame,
          );
          if (result.status !== "complete") throw new Error("Approach failed");
          actor = result.actor;
        }
    }
    expect(tick).toBe(route.costTicks);
    expect(actor.body.x).toBe(destination.x);
    expect(actor.body.y).toBe(destination.y);
    expect(actor.facing).toBe(destination.facing);
    expect(actor.body.vx).toBe(0);
    expect(actor.body.supportId).toBe(102);
  });
  it("restores the route and nested traversal cursor at every tick", () => {
    const { actor: initial, graph, destination, targets } = routeFixture();
    const route = graph.route({ ...initial.body, facing: initial.facing }, destination, 1);
    if (route.status !== "route") throw new Error("Missing route");
    const follower = new RouteFollower(graph, route, FOOT_SHAPES);
    let actor: ControlledActor = initial;
    let cursor: RouteCursor | null = follower.begin(actor, 200);
    for (let tick = 201; tick <= 200 + route.costTicks; tick++) {
      if (!cursor) throw new Error("Early arrival");
      const frame = { tick, geometryRevision: 1 };
      const index = new CollisionIndex(new CollisionGrid(targets), [], frame);
      const result: RouteStep = follower.step(actor, cursor, index, frame);
      const restored = follower.step(
        JSON.parse(JSON.stringify(actor)),
        JSON.parse(JSON.stringify(cursor)),
        index,
        frame,
      );
      expect(restored).toEqual(result);
      if (result.status !== "active" && result.status !== "arrived")
        throw new Error("Route stopped");
      actor = result.actor;
      cursor = result.cursor;
    }
    expect(cursor).toBe(null);
    expect(actor.body.x).toBe(destination.x);
    expect(actor.body.supportId).toBe(102);
  });
  it("cancels mid-flight geometry changes while advancing real gravity once", () => {
    const { actor: initial, graph, destination, targets } = routeFixture();
    const route = graph.route({ ...initial.body, facing: initial.facing }, destination, 1);
    if (route.status !== "route") throw new Error("Missing route");
    const follower = new RouteFollower(graph, route, FOOT_SHAPES);
    let actor: ControlledActor = initial;
    let cursor = follower.begin(actor, 0);
    for (let tick = 1; tick <= 10; tick++) {
      const frame = { tick, geometryRevision: 1 };
      const result: RouteStep = follower.step(
        actor,
        cursor,
        new CollisionIndex(new CollisionGrid(targets), [], frame),
        frame,
      );
      if (result.status !== "active" || !result.cursor) throw new Error("Route stopped");
      actor = result.actor;
      cursor = result.cursor;
    }
    const frame = { tick: 11, geometryRevision: 2 };
    const result: RouteStep = follower.step(
      actor,
      cursor,
      new CollisionIndex(
        new CollisionGrid(targets.filter((target) => target.id !== 102)),
        [],
        frame,
      ),
      frame,
    );
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") throw new Error("Missing cancellation");
    expect(result.reason).toBe("geometry");
    expect(result.actor.body.y).toBe(actor.body.y + actor.body.vy + 55);
    expect(result.actor.body.vx).toBe(0);
  });
  it("rejects malformed plans and cancels an unavailable launch without replaying its edge", () => {
    const { actor, graph, destination, targets } = routeFixture();
    const route = graph.route({ ...actor.body, facing: actor.facing }, destination, 1);
    if (route.status !== "route") throw new Error("Missing route");
    expect(() => new RouteFollower(graph, { ...route, costTicks: 1 }, FOOT_SHAPES)).toThrow(
      "duration",
    );
    const follower = new RouteFollower(graph, route, FOOT_SHAPES);
    const frame = { tick: 1, geometryRevision: 1 };
    const first = follower.step(
      actor,
      follower.begin(actor, 0),
      new CollisionIndex(new CollisionGrid(targets), [], frame),
      frame,
    );
    if (first.status !== "active" || !first.cursor) throw new Error("Route stopped");
    const nextFrame = { tick: 2, geometryRevision: 1 };
    const result: RouteStep = follower.step(
      { ...first.actor, jumpBufferTicks: 1 },
      first.cursor,
      new CollisionIndex(new CollisionGrid(targets), [], nextFrame),
      nextFrame,
    );
    expect(result.status).toBe("cancelled");
    if (result.status !== "cancelled") throw new Error("Missing cancellation");
    expect(result.reason).toBe("launch");
    expect(result.actor.body.y).toBe(actor.body.y);
    expect(result.actor.jumpBufferTicks).toBe(0);
  });
  it("records the chained lab route and replays its complete approach/link cursor", () => {
    let state = createControllerLab("route-chain");
    const commands = Array.from({ length: 117 }, (_, tick) => ({
      held: 0,
      jumpPressed: false,
      removePlatform: false,
      startTraversal: tick === 0 || tick === 40,
    }));
    for (const command of commands) state = stepControllerLab(state, command);
    expect(state.traversalStatus).toBe("landed");
    expect(state.route).toBe(null);
    expect(state.actor.body.x).toBe(pixels(380));
    expect(
      labFingerprint(
        replayControllerLab({
          format: 6,
          scenario: "route-chain",
          commands,
          finalState: labFingerprint(state),
        }),
      ),
    ).toBe(labFingerprint(state));
  });
  it("uses link-ID lexicographic tie breaking independent of insertion order", () => {
    const { actor, definition, targets, surface, links, destination } = routeFixture();
    const first = links[0];
    if (!first) throw new Error("Missing link");
    const alternate = new CompiledTraversal(
      { ...first.definition, id: 3 },
      actor,
      definition,
      FOOT_SHAPES,
      targets,
      surface,
    );
    const a = new NavigationGraph(surface, definition, [...links, alternate]);
    const b = new NavigationGraph(surface, definition, [alternate, ...links].reverse());
    const from = { ...actor.body, facing: actor.facing };
    expect(a.route(from, destination, 1)).toEqual(b.route(from, destination, 1));
    expect(a.route(from, destination, 1)).toMatchObject({ linkIds: [1, 2] });
  });
  it("rejects impossible stride alignment, missing connections, bounds and stale revisions", () => {
    const { actor, graph, destination, surface, definition } = routeFixture();
    const from = { ...actor.body, facing: actor.facing };
    expect(graph.route(from, { ...destination, x: destination.x + 1 }, 1)).toEqual({
      status: "unreachable",
      reason: "no-route",
    });
    expect(graph.route(from, destination, 1, 116).status).toBe("unreachable");
    expect(new NavigationGraph(surface, definition, []).route(from, destination, 1).status).toBe(
      "unreachable",
    );
    expect(graph.route({ ...from, y: from.y - 1 }, destination, 1).status).toBe("unreachable");
    expect(() => graph.route(from, destination, 2)).toThrow("Stale");
    expect(() => graph.route(from, destination, 1, 3601)).toThrow("budget");
  });
  it("plans a real out-and-back for facing changes and refuses one beyond clearance", () => {
    const { actor, graph } = routeFixture();
    const from = { ...actor.body, facing: actor.facing };
    expect(graph.route(from, { ...from, facing: -1 }, 1)).toMatchObject({
      costTicks: 3,
      legs: [
        { kind: "walk", direction: 1, ticks: 1 },
        { kind: "walk", direction: -1, ticks: 1 },
        { kind: "settle", ticks: 1 },
      ],
    });
    expect(
      graph.route(
        { x: pixels(93), y: pixels(300), facing: 1 },
        { x: pixels(93), y: pixels(300), facing: -1 },
        1,
      ).status,
    ).toBe("unreachable");
  });
  it("rejects duplicate links, different surface instances and changed motion policy", () => {
    const { graph, links, surface, definition, targets } = routeFixture();
    expect(() => new NavigationGraph(surface, definition, [...links, ...links])).toThrow(
      "Duplicate",
    );
    const shape = FOOT_SHAPES.get(1);
    if (!shape) throw new Error("Missing shape");
    expect(
      () => new NavigationGraph(new WalkSurface(targets, shape, 2), definition, links),
    ).toThrow("different compiled");
    expect(
      () =>
        new NavigationGraph(surface, { ...definition, runSpeed: definition.runSpeed + 1 }, links),
    ).toThrow("movement policy");
    expect(graph.surface).toBe(surface);
  });
});

import { stateHash } from "../../src/game/core/canonical.js";
import { routeFixture } from "../../src/game/labs/route.js";
import type { RouteCursor, RouteStep } from "../../src/game/navigation/follower.js";
import { NavigationGraph } from "../../src/game/navigation/graph.js";
import { CollisionGrid, CollisionIndex } from "../../src/game/physics/grid.js";

export function routeProof() {
  const {
    actor: initial,
    definition,
    targets,
    surface,
    links,
    destination,
    route,
    follower,
  } = routeFixture();
  const from = { x: initial.body.x, y: initial.body.y, facing: initial.facing };
  const reversed = new NavigationGraph(surface, definition, [...links].reverse()).route(
    from,
    destination,
    1,
  );
  let actor = initial;
  let cursor: RouteCursor | null = follower.begin(actor, 0);
  let traceHash = "00000000";
  const checkpoints = [];
  let cancellation: RouteStep | null = null;
  for (let tick = 1; tick <= route.costTicks; tick++) {
    if (!cursor) throw new Error("Early route arrival");
    const frame = { tick, geometryRevision: 1 };
    const index = new CollisionIndex(new CollisionGrid(targets), [], frame);
    const result = follower.step(actor, cursor, index, frame);
    const restored = follower.step(
      JSON.parse(JSON.stringify(actor)),
      JSON.parse(JSON.stringify(cursor)),
      index,
      frame,
    );
    if (stateHash(restored) !== stateHash(result)) throw new Error("Restored route diverged");
    if (result.status !== "active" && result.status !== "arrived")
      throw new Error("Route fixture failed");
    actor = result.actor;
    cursor = result.cursor;
    traceHash = stateHash({ traceHash, tick, actor, cursor, status: result.status });
    if ([1, 10, 52, 56, 107, 117].includes(tick)) checkpoints.push({ tick, actor, cursor });
    if (tick === 10 && cursor) {
      const changed = { tick: 11, geometryRevision: 2 };
      cancellation = follower.step(
        actor,
        cursor,
        new CollisionIndex(
          new CollisionGrid(targets.filter((target) => target.id !== 102)),
          [],
          changed,
        ),
        changed,
      );
    }
  }
  return { route, reversed, ticks: route.costTicks, traceHash, checkpoints, cancellation };
}

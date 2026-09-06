import { stateHash } from "../../src/game/core/canonical.js";
import { compiledLevelFixture } from "../../src/game/labs/compiled.js";
import type { RouteCursor, RouteStep } from "../../src/game/navigation/follower.js";
import { CollisionGrid, CollisionIndex } from "../../src/game/physics/grid.js";
import type { ControlledActor } from "../../src/game/state.js";

export function compiledLevelProof() {
  const fixture = compiledLevelFixture();
  let actor: ControlledActor = fixture.actor;
  let cursor: RouteCursor | null = fixture.follower.begin(actor, 0);
  let traceHash = "00000000";
  const grid = new CollisionGrid(fixture.targets);
  for (let tick = 1; tick <= fixture.route.costTicks; tick++) {
    if (!cursor) throw new Error("Early compiled arrival");
    const frame = { tick, geometryRevision: 1 };
    const result: RouteStep = fixture.follower.step(
      actor,
      cursor,
      new CollisionIndex(grid, [], frame),
      frame,
    );
    if (result.status !== "active" && result.status !== "arrived")
      throw new Error("Compiled route failed");
    actor = result.actor;
    cursor = result.cursor;
    traceHash = stateHash({ traceHash, tick, actor, cursor });
  }
  if (cursor || actor.body.x !== fixture.destination.x || actor.body.y !== fixture.destination.y)
    throw new Error("Wrong compiled destination");
  return {
    contentHash: fixture.contentHash,
    buildHash: fixture.buildHash,
    ticks: fixture.route.costTicks,
    traceHash,
    actor,
  };
}

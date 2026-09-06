import { stateHash } from "../../src/game/core/canonical.js";
import { traversalFixture } from "../../src/game/labs/traversal.js";
import type { TraversalCursor } from "../../src/game/navigation/links.js";
import { CollisionGrid, CollisionIndex } from "../../src/game/physics/grid.js";

export function traversalProof() {
  const routes = (["jump", "drop"] as const).map((kind) => {
    const { actor: source, targets, link } = traversalFixture(kind);
    let actor = source;
    let cursor: TraversalCursor | null = link.begin(actor, 100);
    const trace = [];
    for (let elapsed = 0; elapsed < link.commands.length; elapsed++) {
      if (!cursor) throw new Error("Premature traversal completion");
      const frame = { tick: 101 + elapsed, geometryRevision: 1 };
      const index = new CollisionIndex(new CollisionGrid(targets), [], frame);
      const result = link.step(actor, cursor, index, frame);
      const restored = link.step(
        JSON.parse(JSON.stringify(actor)),
        JSON.parse(JSON.stringify(cursor)),
        index,
        frame,
      );
      if (stateHash(result) !== stateHash(restored)) throw new Error("Restored traversal diverged");
      if (result.status !== "active" && result.status !== "landed")
        throw new Error("Traversal failed");
      actor = result.actor;
      cursor = result.cursor;
      trace.push({ status: result.status, actor, cursor, events: result.result.events });
    }
    return {
      kind,
      ticks: trace.length,
      poses: link.poses,
      traceHash: stateHash(trace),
      finalActor: actor,
    };
  });
  const { actor: source, targets, link } = traversalFixture("jump");
  let actor = source;
  let cursor = link.begin(actor, 0);
  for (let tick = 1; tick <= 10; tick++) {
    const frame = { tick, geometryRevision: 1 };
    const result = link.step(
      actor,
      cursor,
      new CollisionIndex(new CollisionGrid(targets), [], frame),
      frame,
    );
    if (result.status !== "active" || !result.cursor) throw new Error("Unexpected traversal state");
    actor = result.actor;
    cursor = result.cursor;
  }
  const frame = { tick: 11, geometryRevision: 2 };
  const cancellation = link.step(
    actor,
    cursor,
    new CollisionIndex(new CollisionGrid(targets.filter((target) => target.id !== 101)), [], frame),
    frame,
  );
  return { routes, cancellation, traceHash: stateHash({ routes, cancellation }) };
}

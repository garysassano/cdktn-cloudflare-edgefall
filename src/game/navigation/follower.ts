import type { ShapeDefinition } from "../content/schema.js";
import { type FootStep, stepFootController } from "../controller/foot.js";
import { COUNTER_LIMIT, integer, position } from "../core/numeric.js";
import { Held } from "../input/types.js";
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import type { ControlledActor, FootActor } from "../state.js";
import type { NavigationGraph, NavigationPoint, RouteLeg, RouteResult } from "./graph.js";
import type { TraversalCursor } from "./links.js";

export interface RouteCursor {
  startTick: number;
  elapsed: number;
  legIndex: number;
  legElapsed: number;
  traversal: TraversalCursor | null;
}
export type RouteStep<T extends FootActor = ControlledActor> =
  | {
      status: "active" | "arrived";
      actor: T;
      cursor: RouteCursor | null;
      result: Extract<FootStep<T>, { status: "complete" }>;
    }
  | {
      status: "cancelled";
      reason: "geometry" | "state" | "launch" | "trajectory";
      actor: T;
      cursor: null;
      result: Exclude<FootStep<T>, { status: "failed" }>;
    }
  | { status: "failed"; result: Extract<FootStep<T>, { status: "failed" }> };
function point(actor: FootActor): NavigationPoint {
  return { x: actor.body.x, y: actor.body.y, facing: actor.facing };
}
function same(a: NavigationPoint, b: NavigationPoint): boolean {
  return a.x === b.x && a.y === b.y && a.facing === b.facing;
}
function ready(actor: FootActor): boolean {
  return actor.life === "alive" && actor.vehicleId === null && actor.action.kind === "ready";
}

/** One-tick route execution. Geometry is verified by the controller; planned roots are assertions, never assignments. */
export class RouteFollower {
  readonly geometryRevision: number;
  readonly poses: readonly Readonly<NavigationPoint>[];
  readonly #graph: NavigationGraph;
  readonly #legs: readonly Readonly<RouteLeg>[];
  readonly #offsets: readonly number[];
  readonly #shapes: ReadonlyMap<number, ShapeDefinition>;
  constructor(
    graph: NavigationGraph,
    route: Extract<RouteResult, { status: "route" }>,
    shapes: ReadonlyMap<number, ShapeDefinition>,
  ) {
    graph.surface.assertRevision(route.geometryRevision);
    if (route.shapeId !== graph.surface.shapeId || !shapes.has(route.shapeId))
      throw new Error("Route shape mismatch");
    integer(route.legs.length, 1, 3600, "route leg count");
    integer(shapes.size, 1, 4096, "route shape count");
    integer(route.costTicks, 1, 3600, "route duration");
    this.geometryRevision = route.geometryRevision;
    this.#graph = graph;
    this.#legs = Object.freeze(route.legs.map((leg) => Object.freeze({ ...leg })));
    this.#shapes = new Map(
      [...shapes].map(([id, shape]) => [
        id,
        Object.freeze({ ...shape, rect: Object.freeze({ ...shape.rect }) }),
      ]),
    );
    const poses = [Object.freeze({ x: route.from.x, y: route.from.y, facing: route.from.facing })];
    const offsets = [];
    for (const leg of this.#legs) {
      integer(leg.ticks, 1, 3600, "route leg duration");
      offsets.push(poses.length - 1);
      const from = poses.at(-1);
      if (!from) throw new Error("Missing route source");
      if (leg.kind === "traverse") {
        const link = graph.link(leg.linkId);
        const launch = link?.poses[0];
        if (!link || !launch || !same(from, launch) || leg.ticks !== link.commands.length)
          throw new Error("Route link mismatch");
        for (const pose of link.poses.slice(1))
          poses.push(Object.freeze({ x: pose.x, y: pose.y, facing: pose.facing }));
      } else {
        if (leg.kind !== "walk" && leg.kind !== "settle") throw new Error("Invalid route leg");
        if (leg.kind === "settle" && leg.ticks !== 1) throw new Error("Invalid settle duration");
        const facing = leg.kind === "walk" ? leg.direction : from.facing;
        if (facing !== -1 && facing !== 1) throw new Error("Invalid route direction");
        const x = position(
          from.x +
            (leg.kind === "walk" ? leg.direction * graph.actorDefinition.runSpeed * leg.ticks : 0),
        );
        const span = graph.surface.locate(from.x, from.y, facing, this.geometryRevision);
        if (!span || x < span.minX || x > span.maxX)
          throw new Error("Route walk lacks continuous clearance");
        for (let i = 1; i <= leg.ticks; i++)
          poses.push(
            Object.freeze({
              x: position(
                from.x +
                  (leg.kind === "walk" ? i * leg.direction * graph.actorDefinition.runSpeed : 0),
              ),
              y: from.y,
              facing,
            }),
          );
      }
      if (poses.length > 3601) throw new Error("Route proof exceeds duration bound");
    }
    const last = poses.at(-1);
    if (!last || !same(last, route.destination) || poses.length !== route.costTicks + 1)
      throw new Error("Route destination/duration mismatch");
    this.#offsets = Object.freeze(offsets);
    this.poses = Object.freeze(poses);
    Object.freeze(this);
  }
  begin(actor: FootActor, startTick: number): RouteCursor {
    integer(startTick, 0, COUNTER_LIMIT - 3602, "route start tick");
    const source = this.poses[0];
    if (
      !source ||
      !ready(actor) ||
      !actor.body.grounded ||
      actor.body.vx !== 0 ||
      actor.body.vy !== 0 ||
      actor.body.shapeId !== this.#graph.surface.shapeId ||
      actor.geometryRevision !== this.geometryRevision ||
      !same(point(actor), source)
    )
      throw new Error("Route source mismatch");
    return { startTick, elapsed: 0, legIndex: 0, legElapsed: 0, traversal: null };
  }
  step<T extends FootActor>(
    actor: T,
    cursor: RouteCursor,
    index: CollisionIndex,
    frame: CollisionFrame,
  ): RouteStep<T> {
    index.assertFrame(frame);
    integer(cursor.startTick, 0, COUNTER_LIMIT - 3602, "route start tick");
    integer(cursor.elapsed, 0, this.poses.length - 2, "route elapsed");
    integer(cursor.legIndex, 0, this.#legs.length - 1, "route leg index");
    const leg = this.#legs[cursor.legIndex];
    if (!leg) throw new Error("Missing route leg");
    integer(cursor.legElapsed, 0, leg.ticks - 1, "route leg elapsed");
    if (
      frame.tick !== cursor.startTick + cursor.elapsed + 1 ||
      cursor.elapsed !== (this.#offsets[cursor.legIndex] ?? -1) + cursor.legElapsed ||
      (leg.kind !== "traverse" && cursor.traversal !== null)
    )
      throw new Error("Route tick/cursor mismatch");
    const expected = this.poses[cursor.elapsed];
    let reason: "geometry" | "state" | "launch" | "trajectory" | null =
      frame.geometryRevision !== this.geometryRevision ||
      actor.geometryRevision !== frame.geometryRevision
        ? "geometry"
        : !expected || !same(point(actor), expected) || !ready(actor)
          ? "state"
          : null;
    let result: FootStep<T>;
    let traversal = cursor.traversal;
    if (!reason && leg.kind === "traverse") {
      const link = this.#graph.link(leg.linkId);
      if (!link) throw new Error("Missing route link");
      if (!traversal) {
        if (cursor.legElapsed !== 0) throw new Error("Missing active link cursor");
        try {
          traversal = link.begin(actor, frame.tick - 1);
        } catch {
          reason = "launch";
        }
      } else if (
        traversal.elapsed !== cursor.legElapsed ||
        traversal.startTick !== cursor.startTick + (this.#offsets[cursor.legIndex] ?? -1)
      )
        throw new Error("Route/link cursor mismatch");
      if (traversal && !reason) {
        const progress = link.step(actor, traversal, index, frame);
        result = progress.result;
        traversal = progress.status === "failed" ? null : progress.cursor;
        if (progress.status === "cancelled") reason = progress.reason;
      } else result = this.#neutral(actor, index, frame);
    } else {
      result = reason
        ? this.#neutral(actor, index, frame)
        : stepFootController(
            actor,
            {
              held: leg.kind === "walk" ? (leg.direction === 1 ? Held.Right : Held.Left) : 0,
              jumpPressed: false,
            },
            this.#graph.actorDefinition,
            this.#shapes,
            index,
            frame,
          );
    }
    if (result.status === "failed") return { status: "failed", result };
    const after = this.poses[cursor.elapsed + 1];
    if (!reason && (!after || !same(point(result.actor), after))) reason = "trajectory";
    if (reason || result.status !== "complete")
      return {
        status: "cancelled",
        reason: reason ?? "state",
        actor: result.actor,
        cursor: null,
        result,
      };
    const elapsed = cursor.elapsed + 1;
    const nextLeg = cursor.legElapsed + 1 === leg.ticks;
    const done = elapsed === this.poses.length - 1;
    return {
      status: done ? "arrived" : "active",
      actor: result.actor,
      cursor: done
        ? null
        : {
            ...cursor,
            elapsed,
            legIndex: cursor.legIndex + Number(nextLeg),
            legElapsed: nextLeg ? 0 : cursor.legElapsed + 1,
            traversal,
          },
      result,
    };
  }
  #neutral<T extends FootActor>(
    actor: T,
    index: CollisionIndex,
    frame: CollisionFrame,
  ): FootStep<T> {
    return stepFootController(
      { ...actor, geometryRevision: frame.geometryRevision, jumpBufferTicks: 0 },
      { held: 0, jumpPressed: false },
      this.#graph.actorDefinition,
      this.#shapes,
      index,
      frame,
    );
  }
}

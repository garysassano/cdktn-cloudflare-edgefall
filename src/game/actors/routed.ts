import type { ShapeDefinition } from "../content/schema.js";
import { type FootStep, stepFootController } from "../controller/foot.js";
import { canonical } from "../core/canonical.js";
import { COUNTER_LIMIT, integer, position } from "../core/numeric.js";
import { type RouteCursor, RouteFollower, type RouteStep } from "../navigation/follower.js";
import type { NavigationGraph, NavigationPoint, RouteResult } from "../navigation/graph.js";
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import type { FootActor, Rect } from "../state.js";

type Plan = Extract<RouteResult, { status: "route" }>;
export interface RoutedEnemy {
  actor: FootActor;
  goal: NavigationPoint;
  plan: Plan | null;
  cursor: RouteCursor | null;
  status: "idle" | "routing" | "arrived" | "waiting" | "unreachable" | "removed";
  reason: "goal" | "geometry" | "state" | "launch" | "trajectory" | "no-route" | "airborne" | null;
  removalReason: "crushed" | "out-of-bounds" | null;
  nextPlanTick: number;
  plans: number;
}
export type EnemyNavigationEvent =
  | { kind: "route-started"; id: number; tick: number; links: number[] }
  | {
      kind: "route-cancelled";
      id: number;
      tick: number;
      reason: NonNullable<RoutedEnemy["reason"]>;
    }
  | { kind: "removed"; id: number; tick: number; reason: "crushed" | "out-of-bounds" };
export type RoutedEnemyStep =
  | {
      status: "complete";
      enemy: RoutedEnemy;
      events: EnemyNavigationEvent[];
      result: FootStep<FootActor> | null;
    }
  | { status: "failed"; result: Extract<FootStep<FootActor>, { status: "failed" }> };
const RETRY_TICKS = 30;
function same(a: NavigationPoint, b: NavigationPoint): boolean {
  return a.x === b.x && a.y === b.y && a.facing === b.facing;
}
export function createRoutedEnemy(actor: FootActor, goal: NavigationPoint): RoutedEnemy {
  position(goal.x);
  position(goal.y);
  if (goal.facing !== -1 && goal.facing !== 1) throw new Error("Invalid enemy goal facing");
  return {
    actor,
    goal: { ...goal },
    plan: null,
    cursor: null,
    status: "idle",
    reason: null,
    removalReason: null,
    nextPlanTick: 0,
    plans: 0,
  };
}

/** Static navigation owner. Cached followers are disposable; all continuation is in RoutedEnemy. */
export class RoutedEnemyDriver {
  readonly #followers = new Map<string, RouteFollower>();
  readonly #shapes: ReadonlyMap<number, ShapeDefinition>;
  readonly #bounds: Readonly<Rect>;
  constructor(
    readonly graph: NavigationGraph,
    shapes: ReadonlyMap<number, ShapeDefinition>,
    bounds: Rect,
  ) {
    integer(shapes.size, 1, 4096, "enemy shape count");
    for (const value of [bounds.x, bounds.y, bounds.x + bounds.w, bounds.y + bounds.h])
      position(value);
    if (bounds.w <= 0 || bounds.h <= 0) throw new Error("Invalid enemy kill bounds");
    this.#bounds = Object.freeze({ ...bounds });
    this.#shapes = new Map(
      [...shapes].map(([id, shape]) => [
        id,
        Object.freeze({ ...shape, rect: Object.freeze({ ...shape.rect }) }),
      ]),
    );
    Object.freeze(this);
  }
  #follower(plan: Plan): RouteFollower {
    const key = canonical(plan);
    let follower = this.#followers.get(key);
    if (!follower) {
      follower = new RouteFollower(this.graph, plan, this.#shapes);
      if (this.#followers.size >= 32) {
        const first = this.#followers.keys().next().value;
        if (first !== undefined) this.#followers.delete(first);
      }
      this.#followers.set(key, follower);
    }
    return follower;
  }
  step(
    current: RoutedEnemy,
    goal: NavigationPoint,
    index: CollisionIndex,
    frame: CollisionFrame,
  ): RoutedEnemyStep {
    index.assertFrame(frame);
    integer(frame.tick, 1, COUNTER_LIMIT - 3604, "enemy navigation tick");
    integer(current.plans, 0, COUNTER_LIMIT - 2, "enemy plan count");
    integer(current.nextPlanTick, 0, COUNTER_LIMIT - 1, "enemy retry tick");
    position(goal.x);
    position(goal.y);
    if (goal.facing !== -1 && goal.facing !== 1) throw new Error("Invalid enemy goal facing");
    if (current.status === "removed")
      return { status: "complete", enemy: current, events: [], result: null };
    if ((current.plan === null) !== (current.cursor === null))
      throw new Error("Enemy plan/cursor mismatch");
    let enemy: RoutedEnemy = { ...current, goal: { ...goal } };
    const events: EnemyNavigationEvent[] = [];
    const id = current.actor.body.id;
    const neutral = () =>
      stepFootController(
        { ...current.actor, geometryRevision: frame.geometryRevision, jumpBufferTicks: 0 },
        { held: 0, jumpPressed: false },
        this.graph.actorDefinition,
        this.#shapes,
        index,
        frame,
      );
    let result: FootStep<FootActor>;
    const changedGoal = !same(current.goal, goal);
    const changedGeometry =
      this.graph.surface.geometryRevision !== frame.geometryRevision ||
      current.actor.geometryRevision !== frame.geometryRevision ||
      (current.plan !== null && current.plan.geometryRevision !== frame.geometryRevision);
    if (changedGoal || changedGeometry) {
      const reason = changedGeometry ? "geometry" : "goal";
      if (current.plan) events.push({ kind: "route-cancelled", id, tick: frame.tick, reason });
      enemy = {
        ...enemy,
        plan: null,
        cursor: null,
        status: "waiting",
        reason,
        nextPlanTick: frame.tick + 1,
      };
      result = neutral();
    } else if (current.plan && current.cursor) {
      const progress: RouteStep<FootActor> = this.#follower(current.plan).step(
        current.actor,
        current.cursor,
        index,
        frame,
      );
      result = progress.result;
      if (progress.status === "active")
        enemy = {
          ...enemy,
          actor: progress.actor,
          cursor: progress.cursor,
          status: "routing",
          reason: null,
        };
      else if (progress.status === "arrived")
        enemy = {
          ...enemy,
          actor: progress.actor,
          plan: null,
          cursor: null,
          status: "arrived",
          reason: null,
        };
      else if (progress.status === "cancelled") {
        events.push({ kind: "route-cancelled", id, tick: frame.tick, reason: progress.reason });
        enemy = {
          ...enemy,
          actor: progress.actor,
          plan: null,
          cursor: null,
          status: "waiting",
          reason: progress.reason,
          nextPlanTick: frame.tick + RETRY_TICKS,
        };
      }
    } else {
      const actor = current.actor;
      const settled =
        actor.life === "alive" &&
        actor.action.kind === "ready" &&
        actor.vehicleId === null &&
        actor.locomotion === "grounded" &&
        actor.body.grounded &&
        actor.body.vx === 0 &&
        actor.body.vy === 0 &&
        actor.body.shapeId === this.graph.surface.shapeId &&
        actor.ignoredSupportTicks === 0 &&
        actor.jumpBufferTicks === 0;
      if (!settled) {
        enemy = { ...enemy, status: "waiting", reason: actor.body.grounded ? "state" : "airborne" };
        result = neutral();
      } else if (same({ x: actor.body.x, y: actor.body.y, facing: actor.facing }, goal)) {
        enemy = { ...enemy, status: "arrived", reason: null };
        result = neutral();
      } else if (frame.tick < current.nextPlanTick) result = neutral();
      else {
        const route = this.graph.route(
          { x: actor.body.x, y: actor.body.y, facing: actor.facing },
          goal,
          frame.geometryRevision,
        );
        enemy.plans++;
        if (route.status === "unreachable") {
          enemy = {
            ...enemy,
            status: "unreachable",
            reason: "no-route",
            nextPlanTick: frame.tick + RETRY_TICKS,
          };
          result = neutral();
        } else {
          const follower = this.#follower(route);
          const cursor = follower.begin(actor, frame.tick - 1);
          const progress: RouteStep<FootActor> = follower.step(actor, cursor, index, frame);
          result = progress.result;
          events.push({ kind: "route-started", id, tick: frame.tick, links: [...route.linkIds] });
          if (progress.status === "active")
            enemy = {
              ...enemy,
              plan: route,
              cursor: progress.cursor,
              status: "routing",
              reason: null,
            };
          else if (progress.status === "arrived")
            enemy = { ...enemy, status: "arrived", reason: null };
          else if (progress.status === "cancelled") {
            events.push({ kind: "route-cancelled", id, tick: frame.tick, reason: progress.reason });
            enemy = {
              ...enemy,
              status: "waiting",
              reason: progress.reason,
              nextPlanTick: frame.tick + RETRY_TICKS,
            };
          }
        }
      }
    }
    if (result.status === "failed") {
      if (result.physics.reason !== "crushed") return { status: "failed", result };
      enemy = {
        ...enemy,
        actor: { ...current.actor, geometryRevision: frame.geometryRevision, life: "death" },
        plan: null,
        cursor: null,
        status: "removed",
        removalReason: "crushed",
      };
      events.push({ kind: "removed", id, tick: frame.tick, reason: "crushed" });
    } else {
      enemy.actor = result.actor;
      const body = result.actor.body,
        bounds = this.#bounds;
      if (
        body.x < bounds.x ||
        body.x > bounds.x + bounds.w ||
        body.y < bounds.y ||
        body.y > bounds.y + bounds.h
      ) {
        enemy = {
          ...enemy,
          actor: { ...result.actor, life: "death" },
          plan: null,
          cursor: null,
          status: "removed",
          removalReason: "out-of-bounds",
        };
        events.push({ kind: "removed", id, tick: frame.tick, reason: "out-of-bounds" });
      } else if (enemy.status === "arrived" && !body.grounded)
        enemy = { ...enemy, status: "waiting", reason: "airborne" };
    }
    return { status: "complete", enemy, events, result };
  }
}

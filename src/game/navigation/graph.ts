import type { ActorDefinition } from "../content/schema.js";
import { canonical } from "../core/canonical.js";
import { integer, position } from "../core/numeric.js";
import type { CompiledTraversal } from "./links.js";
import type { WalkSpan, WalkSurface } from "./spans.js";

export interface NavigationPoint {
  x: number;
  y: number;
  facing: -1 | 1;
}
export type RouteLeg =
  | { kind: "walk"; direction: -1 | 1; ticks: number }
  | { kind: "settle"; ticks: 1 }
  | { kind: "traverse"; linkId: number; ticks: number };
export type RouteResult =
  | {
      status: "route";
      geometryRevision: number;
      from: NavigationPoint;
      destination: NavigationPoint;
      shapeId: number;
      costTicks: number;
      linkIds: number[];
      legs: RouteLeg[];
    }
  | { status: "unreachable"; reason: "outside-surface" | "no-route" };
interface Label {
  node: number;
  point: NavigationPoint;
  cost: number;
  ids: number[];
  legs: RouteLeg[];
}
function compare(a: Pick<Label, "cost" | "ids">, b: Pick<Label, "cost" | "ids">): number {
  if (a.cost !== b.cost) return a.cost - b.cost;
  for (let i = 0; i < Math.min(a.ids.length, b.ids.length); i++) {
    const ai = a.ids[i],
      bi = b.ids[i];
    if (ai !== undefined && bi !== undefined && ai !== bi) return ai - bi;
  }
  return a.ids.length - b.ids.length;
}
function validate(point: NavigationPoint): void {
  position(point.x);
  position(point.y);
  if (point.facing !== -1 && point.facing !== 1) throw new Error("Invalid route facing");
}

/** Bounded static route selection. Approach legs respect the controller's discrete run speed. */
export class NavigationGraph {
  readonly #planes = new Map<string, readonly WalkSpan[]>();
  readonly #links: readonly CompiledTraversal[];
  readonly #speed: number;
  readonly actorDefinition: Readonly<ActorDefinition>;
  constructor(
    readonly surface: WalkSurface,
    definition: ActorDefinition,
    links: readonly CompiledTraversal[],
  ) {
    if (definition.locomotion !== "grounded")
      throw new Error("Navigation requires grounded locomotion");
    this.actorDefinition = Object.freeze({ ...definition });
    integer(links.length, 0, 256, "navigation link count");
    this.#speed = integer(definition.runSpeed, 1, 2 ** 16, "navigation run speed");
    if (surface.shapeId !== definition.standingShapeId)
      throw new Error("Graph actor shape mismatch");
    if (new Set(links.map((link) => link.id)).size !== links.length)
      throw new Error("Duplicate navigation link ID");
    const policy = canonical(definition);
    for (const link of links) {
      if (
        link.surface !== surface ||
        link.geometryRevision !== surface.geometryRevision ||
        canonical(link.actorDefinition) !== policy
      )
        throw new Error("Link belongs to a different compiled surface or movement policy");
    }
    this.#links = Object.freeze([...links].sort((a, b) => a.id - b.id));
    const buckets = new Map<string, WalkSpan[]>();
    for (const span of surface.spans) {
      const key = `${span.y}:${span.facing}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(span);
      buckets.set(key, bucket);
    }
    for (const [key, bucket] of buckets)
      this.#planes.set(key, Object.freeze(bucket.sort((a, b) => a.minX - b.minX)));
    Object.freeze(this);
  }
  link(id: number): CompiledTraversal | undefined {
    return this.#links.find((link) => link.id === id);
  }
  #span(point: NavigationPoint): WalkSpan | null {
    const spans = this.#planes.get(`${point.y}:${point.facing}`) ?? [];
    let low = 0,
      high = spans.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      const span = spans[mid];
      if (span && span.minX <= point.x) low = mid + 1;
      else high = mid;
    }
    const span = spans[low - 1];
    return span && point.x <= span.maxX ? span : null;
  }
  #walk(from: NavigationPoint, x: number, direction: -1 | 1): RouteLeg | null {
    const span = this.#span({ ...from, facing: direction });
    if (!span || x < span.minX || x > span.maxX) return null;
    const distance = Math.abs(x - from.x);
    if (distance % this.#speed !== 0) return null;
    return { kind: "walk", direction, ticks: distance / this.#speed };
  }
  #approach(from: NavigationPoint, to: NavigationPoint): RouteLeg[] | null {
    if (from.y !== to.y || !this.#span(to)) return null;
    const legs: RouteLeg[] = [];
    let point = { ...from };
    if (point.x !== to.x) {
      const direction = point.x < to.x ? 1 : -1;
      const walk = this.#walk(point, to.x, direction);
      if (!walk) return null;
      legs.push(walk);
      point = { ...to, facing: direction };
    }
    if (point.facing !== to.facing) {
      // The controller turns through directional input. A safe out-and-back changes
      // facing without inventing an in-place turn command or assigning the root.
      const away = -to.facing as -1 | 1;
      const x = to.x + away * this.#speed;
      const outward = this.#walk(point, x, away);
      const inward = this.#walk({ ...point, x, facing: away }, to.x, to.facing);
      if (!outward || !inward) return null;
      legs.push(outward, inward);
    }
    legs.push({ kind: "settle", ticks: 1 });
    return legs;
  }
  route(
    from: NavigationPoint,
    destination: NavigationPoint,
    revision: number,
    maxTicks = 3600,
  ): RouteResult {
    this.surface.assertRevision(revision);
    validate(from);
    validate(destination);
    integer(maxTicks, 1, 3600, "route tick budget");
    if (!this.#span(from) || !this.#span(destination))
      return { status: "unreachable", reason: "outside-surface" };
    const initial: Label = { node: 0, point: from, cost: 0, ids: [], legs: [] };
    const best = new Map<number, Label>([[0, initial]]);
    const queue = new Map<number, Label>([[0, initial]]);
    const settled = new Set<number>();
    let finish: Label | null = null;
    const spans = new Map(this.surface.spans.map((span) => [span.id, span]));
    while (queue.size) {
      const current = [...queue.values()].sort((a, b) => compare(a, b) || a.node - b.node)[0];
      if (!current) break;
      queue.delete(current.node);
      settled.add(current.node);
      if (!current || best.get(current.node) !== current || (finish && current.cost > finish.cost))
        continue;
      const end = this.#approach(current.point, destination);
      if (end) {
        const candidate = {
          ...current,
          point: destination,
          cost: current.cost + end.reduce((sum, leg) => sum + leg.ticks, 0),
          legs: [...current.legs, ...end],
        };
        if (candidate.cost <= maxTicks && (!finish || compare(candidate, finish) < 0))
          finish = candidate;
      }
      for (const link of this.#links) {
        if (settled.has(link.id)) continue;
        const source = spans.get(link.definition.sourceSpanId);
        const landing = link.poses.at(-1);
        if (!source || !landing) throw new Error("Missing compiled route endpoint");
        const approach = this.#approach(current.point, {
          x: link.definition.sourceX,
          y: source.y,
          facing: source.facing,
        });
        if (!approach) continue;
        const cost =
          current.cost + approach.reduce((sum, leg) => sum + leg.ticks, 0) + link.commands.length;
        if (cost > maxTicks) continue;
        const candidate: Label = {
          node: link.id,
          point: landing,
          cost,
          ids: [...current.ids, link.id],
          legs: [
            ...current.legs,
            ...approach,
            { kind: "traverse", linkId: link.id, ticks: link.commands.length },
          ],
        };
        const previous = best.get(link.id);
        if (!previous || compare(candidate, previous) < 0) {
          best.set(link.id, candidate);
          queue.set(link.id, candidate);
        }
      }
    }
    return finish
      ? {
          status: "route",
          geometryRevision: revision,
          from: { ...from },
          destination: { ...destination },
          shapeId: this.surface.shapeId,
          costTicks: finish.cost,
          linkIds: finish.ids,
          legs: finish.legs,
        }
      : { status: "unreachable", reason: "no-route" };
  }
}

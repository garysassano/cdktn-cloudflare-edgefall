import type { ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, MAX_POSITION, integer, position } from "../core/numeric.js";
import { validateLocalRect } from "../physics/body.js";
import { CollisionGrid } from "../physics/grid.js";
import type { SweepTarget } from "../physics/sweep.js";

export interface WalkSpan {
  readonly id: number;
  readonly facing: -1 | 1;
  readonly y: number;
  /** Inclusive root coordinates, with the entire foot supported and collider clear. */
  readonly minX: number;
  readonly maxX: number;
  readonly supportIds: readonly number[];
}
const MAX_SPANS = 8192;
const MAX_CLEARANCE_CHECKS = 1_000_000;

/** Static collision compilation. Moving-platform traversal requires a trajectory-aware graph. */
export class WalkSurface {
  readonly spans: readonly WalkSpan[];
  readonly shapeId: number;
  readonly geometryRevision: number;
  constructor(targets: readonly SweepTarget[], shape: ShapeDefinition, geometryRevision: number) {
    integer(geometryRevision, 1, COUNTER_LIMIT - 1, "navigation revision");
    integer(shape.id, 1, COUNTER_LIMIT - 1, "navigation shape");
    validateLocalRect(shape.rect);
    if (shape.rect.y + shape.rect.h !== 0)
      throw new Error("Navigation requires a feet-anchored collider");
    const grid = new CollisionGrid(targets);
    if (grid.hasMotion) throw new Error("Static navigation cannot compile moving terrain");
    this.shapeId = shape.id;
    this.geometryRevision = geometryRevision;
    const planes = new Map<number, SweepTarget[]>();
    for (const target of grid.targets) {
      const plane = planes.get(target.rect.y) ?? [];
      plane.push(target);
      planes.set(target.rect.y, plane);
    }
    const spans: WalkSpan[] = [];
    let checks = 0;
    for (const [y, plane] of [...planes].sort(([a], [b]) => a - b)) {
      // Merge physical top surfaces before shrinking for the actor; tile seams remain walkable.
      const unions: Array<{ start: number; end: number; targets: SweepTarget[] }> = [];
      for (const target of plane.sort((a, b) => a.rect.x - b.rect.x || a.id - b.id)) {
        const last = unions.at(-1);
        if (last && target.rect.x <= last.end) {
          last.end = Math.max(last.end, target.rect.x + target.rect.w);
          last.targets.push(target);
        } else
          unions.push({
            start: target.rect.x,
            end: target.rect.x + target.rect.w,
            targets: [target],
          });
      }
      for (const facing of [-1, 1] as const) {
        const localX = facing === 1 ? shape.rect.x : -shape.rect.x - shape.rect.w;
        if (y + shape.rect.y < -MAX_POSITION) continue;
        for (const union of unions) {
          let intervals = [
            {
              start: Math.max(union.start - localX, -MAX_POSITION),
              end: Math.min(union.end - localX - shape.rect.w, MAX_POSITION),
            },
          ];
          const range = intervals[0];
          if (!range || range.start > range.end) continue;
          const obstacles = grid.query({
            minX: union.start,
            maxX: union.end,
            minY: y + shape.rect.y,
            maxY: y,
          });
          for (const obstacle of obstacles) {
            checks += Math.max(1, intervals.length);
            if (checks > MAX_CLEARANCE_CHECKS)
              throw new Error("Navigation clearance work exceeds bound");
            if (
              obstacle.kind !== "solid" ||
              obstacle.rect.y >= y ||
              obstacle.rect.y + obstacle.rect.h <= y + shape.rect.y
            )
              continue;
            // Strict overlap excludes tangent contact; root intervals are integer and inclusive.
            const firstBlocked = obstacle.rect.x - localX - shape.rect.w + 1;
            const lastBlocked = obstacle.rect.x + obstacle.rect.w - localX - 1;
            intervals = intervals.flatMap((interval) => {
              if (lastBlocked < interval.start || firstBlocked > interval.end) return [interval];
              const kept = [];
              if (interval.start < firstBlocked)
                kept.push({ start: interval.start, end: firstBlocked - 1 });
              if (interval.end > lastBlocked)
                kept.push({ start: lastBlocked + 1, end: interval.end });
              return kept;
            });
          }
          for (const interval of intervals) {
            if (spans.length >= MAX_SPANS) throw new Error("Navigation span count exceeds bound");
            checks += union.targets.length;
            if (checks > MAX_CLEARANCE_CHECKS)
              throw new Error("Navigation provenance work exceeds bound");
            const supportIds = union.targets
              .filter(
                (target) =>
                  target.rect.x < interval.end + localX + shape.rect.w &&
                  target.rect.x + target.rect.w > interval.start + localX,
              )
              .map((target) => target.id)
              .sort((a, b) => a - b);
            spans.push(
              Object.freeze({
                id: spans.length + 1,
                facing,
                y,
                minX: interval.start,
                maxX: interval.end,
                supportIds: Object.freeze(supportIds),
              }),
            );
          }
        }
      }
    }
    this.spans = Object.freeze(spans);
    Object.freeze(this);
  }
  assertRevision(revision: number): void {
    if (revision !== this.geometryRevision) throw new Error("Stale navigation geometry revision");
  }
  locate(x: number, y: number, facing: -1 | 1, revision: number): WalkSpan | null {
    this.assertRevision(revision);
    position(x);
    position(y);
    if (facing !== -1 && facing !== 1) throw new Error("Invalid navigation facing");
    return (
      this.spans.find(
        (span) => span.facing === facing && span.y === y && x >= span.minX && x <= span.maxX,
      ) ?? null
    );
  }
}

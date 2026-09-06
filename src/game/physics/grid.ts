import { COUNTER_LIMIT, SUBPIXELS, integer, position } from "../core/numeric.js";
import { type SweepBounds, type SweepTarget, sweepBounds, validateSweepTarget } from "./sweep.js";

const MAX_TARGETS = 4096;
const MAX_ENTRY_CELLS = 256;
const MAX_GRID_REFERENCES = 65536;
const MAX_QUERY_CELLS = 4096;

export interface CollisionFrame {
  geometryRevision: number;
  tick: number;
}
export interface GridQuery {
  targets: readonly SweepTarget[];
  mode: "cells" | "scan";
  cellsVisited: number;
  candidatesTested: number;
}

function validateBounds(bounds: SweepBounds): void {
  for (const value of [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]) position(value);
  if (bounds.minX > bounds.maxX || bounds.minY > bounds.maxY)
    throw new Error("Inverted spatial bounds");
}
function intersects(a: SweepBounds, b: SweepBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
function sorted(values: Iterable<SweepTarget>): readonly SweepTarget[] {
  return Object.freeze([...values].sort((a, b) => a.id - b.id));
}

/** Immutable whole-tick bounds. Large entries/queries fall back to bounded scans, never drop IDs. */
export class CollisionGrid {
  readonly targets: readonly SweepTarget[];
  readonly hasMotion: boolean;
  readonly statistics: Readonly<{
    targets: number;
    cells: number;
    references: number;
    overflow: number;
  }>;
  readonly #buckets = new Map<string, number[]>();
  readonly #entries = new Map<number, { target: SweepTarget; bounds: SweepBounds }>();
  readonly #overflow: number[] = [];

  constructor(
    targets: readonly SweepTarget[],
    readonly cellPixels: 32 | 64 = 64,
  ) {
    if (cellPixels !== 32 && cellPixels !== 64)
      throw new Error("Spatial cell size must be 32 or 64 pixels");
    integer(targets.length, 0, MAX_TARGETS, "spatial target count");
    let references = 0;
    for (const value of [...targets].sort((a, b) => a.id - b.id)) {
      validateSweepTarget(value);
      if (this.#entries.has(value.id)) throw new Error("Duplicate collision entity ID");
      const target = Object.freeze({
        ...value,
        rect: Object.freeze({ ...value.rect }),
        delta: Object.freeze({ ...value.delta }),
      });
      const bounds = sweepBounds(target.rect, target.delta);
      this.#entries.set(target.id, { target, bounds });
      const range = this.#range(bounds);
      if (range.count > MAX_ENTRY_CELLS || references + range.count > MAX_GRID_REFERENCES) {
        this.#overflow.push(target.id);
        continue;
      }
      references += range.count;
      for (let x = range.minX; x <= range.maxX; x++) {
        for (let y = range.minY; y <= range.maxY; y++) {
          const key = `${x},${y}`;
          const bucket = this.#buckets.get(key) ?? [];
          bucket.push(target.id);
          this.#buckets.set(key, bucket);
        }
      }
    }
    this.targets = sorted([...this.#entries.values()].map((entry) => entry.target));
    this.hasMotion = this.targets.some((target) => target.delta.x !== 0 || target.delta.y !== 0);
    this.statistics = Object.freeze({
      targets: targets.length,
      cells: this.#buckets.size,
      references,
      overflow: this.#overflow.length,
    });
    Object.freeze(this);
  }

  #range(bounds: SweepBounds) {
    const size = this.cellPixels * SUBPIXELS;
    const minX = Math.floor(bounds.minX / size);
    const minY = Math.floor(bounds.minY / size);
    const maxX = Math.floor(bounds.maxX / size);
    const maxY = Math.floor(bounds.maxY / size);
    // At most 4097 cells per axis for the full coordinate range at 32 pixels.
    return { minX, minY, maxX, maxY, count: (maxX - minX + 1) * (maxY - minY + 1) };
  }

  query(bounds: SweepBounds): readonly SweepTarget[] {
    return this.inspectQuery(bounds).targets;
  }

  inspectQuery(bounds: SweepBounds): GridQuery {
    validateBounds(bounds);
    const range = this.#range(bounds);
    const ids = new Set<number>();
    const scan = range.count > MAX_QUERY_CELLS;
    if (scan) {
      for (const id of this.#entries.keys()) ids.add(id);
    } else {
      for (const id of this.#overflow) ids.add(id);
      for (let x = range.minX; x <= range.maxX; x++) {
        for (let y = range.minY; y <= range.maxY; y++) {
          for (const id of this.#buckets.get(`${x},${y}`) ?? []) ids.add(id);
        }
      }
    }
    const targets: SweepTarget[] = [];
    for (const id of ids) {
      const entry = this.#entries.get(id);
      if (!entry) throw new Error("Missing spatial entry");
      if (intersects(entry.bounds, bounds)) targets.push(entry.target);
    }
    return {
      targets: sorted(targets),
      mode: scan ? "scan" : "cells",
      cellsVisited: scan ? 0 : range.count,
      candidatesTested: ids.size,
    };
  }
}

/** Reuse the static grid until geometry changes; rebuild moving bounds for each tick. */
export class CollisionIndex {
  readonly dynamic: CollisionGrid;
  readonly targets: readonly SweepTarget[];
  readonly frame: Readonly<CollisionFrame>;

  constructor(
    readonly fixed: CollisionGrid,
    moving: readonly SweepTarget[],
    frame: CollisionFrame,
  ) {
    if (fixed.hasMotion) throw new Error("Static collision grid contains moving geometry");
    integer(fixed.targets.length + moving.length, 0, MAX_TARGETS, "collision frame target count");
    integer(frame.geometryRevision, 1, COUNTER_LIMIT - 1, "geometry revision");
    integer(frame.tick, 0, COUNTER_LIMIT - 1, "collision tick");
    this.dynamic = new CollisionGrid(moving, fixed.cellPixels);
    this.targets = sorted([...fixed.targets, ...this.dynamic.targets]);
    if (new Set(this.targets.map((target) => target.id)).size !== this.targets.length)
      throw new Error("Duplicate collision entity ID across static/dynamic grids");
    this.frame = Object.freeze({ ...frame });
    Object.freeze(this);
  }

  assertFrame(frame?: CollisionFrame): void {
    if (
      !frame ||
      frame.geometryRevision !== this.frame.geometryRevision ||
      frame.tick !== this.frame.tick
    )
      throw new Error("Stale or missing collision frame identity");
  }

  query(bounds: SweepBounds): readonly SweepTarget[] {
    return sorted([...this.fixed.query(bounds), ...this.dynamic.query(bounds)]);
  }
}

import type { ActorDefinition, ShapeDefinition } from "../content/schema.js";
import { type FootIntent, type FootStep, stepFootController } from "../controller/foot.js";
import { canonical } from "../core/canonical.js";
import { COUNTER_LIMIT, integer, position } from "../core/numeric.js";
import { Held } from "../input/types.js";
import { startSupport } from "../physics/body.js";
import { type CollisionFrame, CollisionGrid, CollisionIndex } from "../physics/grid.js";
import type { SweepTarget } from "../physics/sweep.js";
import type { ControlledActor, FootActor } from "../state.js";
import { WalkSurface } from "./spans.js";

export interface TraversalDefinition {
  id: number;
  kind: "jump" | "drop";
  sourceSpanId: number;
  sourceX: number;
  destinationSpanId: number;
  destinationMinX: number;
  destinationMaxX: number;
  direction: -1 | 0 | 1;
  maxTicks: number;
}
export interface TraversalCursor {
  linkId: number;
  startTick: number;
  elapsed: number;
}
export type TraversalStep<T extends FootActor = ControlledActor> =
  | {
      status: "active" | "landed";
      actor: T;
      cursor: TraversalCursor | null;
      result: Extract<FootStep<T>, { status: "complete" }>;
    }
  | {
      status: "cancelled";
      reason: "geometry" | "state" | "trajectory";
      actor: T;
      cursor: null;
      result: Exclude<FootStep<T>, { status: "failed" }>;
    }
  | { status: "failed"; result: Extract<FootStep<T>, { status: "failed" }> };

/** Only locomotion continuation fields; identities, combat state and diagnostic contacts remain world-owned. */
function continuation(actor: FootActor): string {
  const { id: _id, contacts: _contacts, ...body } = actor.body;
  return canonical({
    body,
    facing: actor.facing,
    aim: actor.aim,
    locomotion: actor.locomotion,
    jumpBufferTicks: actor.jumpBufferTicks,
    coyoteTicks: actor.coyoteTicks,
    ignoredSupportId: actor.ignoredSupportId,
    ignoredSupportTicks: actor.ignoredSupportTicks,
  });
}
function ready(actor: FootActor): boolean {
  return actor.life === "alive" && actor.vehicleId === null && actor.action.kind === "ready";
}

/** Compile one bounded, static authored trajectory through the actual on-foot controller.
 * Samples prove a trajectory; runtime always simulates inputs and never assigns sample positions.
 */
export class CompiledTraversal {
  readonly id: number;
  readonly geometryRevision: number;
  readonly definition: Readonly<TraversalDefinition>;
  readonly commands: readonly Readonly<FootIntent>[];
  readonly poses: readonly Readonly<{ x: number; y: number; shapeId: number; facing: -1 | 1 }>[];
  readonly #samples: readonly string[];
  readonly actorDefinition: Readonly<ActorDefinition>;
  readonly surface: WalkSurface;
  readonly #shapes: ReadonlyMap<number, ShapeDefinition>;

  constructor(
    authored: TraversalDefinition,
    sourceActor: FootActor,
    actorDefinition: ActorDefinition,
    shapes: ReadonlyMap<number, ShapeDefinition>,
    targets: readonly SweepTarget[],
    surface: WalkSurface,
  ) {
    for (const id of [authored.id, authored.sourceSpanId, authored.destinationSpanId])
      integer(id, 1, COUNTER_LIMIT - 1, "traversal ID");
    integer(shapes.size, 1, 4096, "traversal shape count");
    integer(authored.maxTicks, 1, 180, "traversal duration");
    integer(authored.direction, -1, 1, "traversal direction");
    if (authored.kind !== "jump" && authored.kind !== "drop")
      throw new Error("Unknown traversal kind");
    for (const x of [authored.sourceX, authored.destinationMinX, authored.destinationMaxX])
      position(x);
    surface.assertRevision(sourceActor.geometryRevision);
    const standing = shapes.get(actorDefinition.standingShapeId);
    if (!standing || surface.shapeId !== standing.id) throw new Error("Traversal shape mismatch");
    const grid = new CollisionGrid(targets);
    if (grid.hasMotion) throw new Error("Static traversal cannot compile moving terrain");
    // Recompile to reject a graph paired with different geometry/shape under the same revision.
    if (
      canonical(new WalkSurface(targets, standing, surface.geometryRevision).spans) !==
      canonical(surface.spans)
    )
      throw new Error("Traversal surface/geometry mismatch");
    const from = surface.locate(
      sourceActor.body.x,
      sourceActor.body.y,
      sourceActor.facing,
      surface.geometryRevision,
    );
    const destination = surface.spans.find((span) => span.id === authored.destinationSpanId);
    const facing = authored.direction === 0 ? sourceActor.facing : authored.direction;
    if (
      !from ||
      from.id !== authored.sourceSpanId ||
      sourceActor.body.x !== authored.sourceX ||
      !destination ||
      destination.facing !== facing ||
      authored.destinationMinX < destination.minX ||
      authored.destinationMaxX > destination.maxX ||
      authored.destinationMinX > authored.destinationMaxX
    )
      throw new Error("Invalid traversal endpoints");
    const initialFrame = { tick: 0, geometryRevision: surface.geometryRevision };
    const initialIndex = new CollisionIndex(grid, [], initialFrame);
    if (
      !ready(sourceActor) ||
      sourceActor.locomotion !== "grounded" ||
      sourceActor.body.shapeId !== standing.id ||
      !sourceActor.body.grounded ||
      sourceActor.body.vx !== 0 ||
      sourceActor.body.vy !== 0 ||
      sourceActor.body.remainderX !== 0 ||
      sourceActor.body.remainderY !== 0 ||
      sourceActor.jumpBufferTicks !== 0 ||
      sourceActor.ignoredSupportId !== null ||
      sourceActor.ignoredSupportTicks !== 0 ||
      sourceActor.body.supportId === null ||
      startSupport(
        sourceActor.body,
        standing,
        sourceActor.facing,
        initialIndex,
        initialFrame,
        null,
      ) !== sourceActor.body.supportId
    )
      throw new Error("Traversal source is not a neutral supported actor");
    if (
      authored.kind === "drop" &&
      (initialIndex.get(sourceActor.body.supportId)?.kind !== "one-way" || destination.y <= from.y)
    )
      throw new Error("Drop requires a one-way source and lower destination");
    this.surface = surface;
    this.id = authored.id;
    this.geometryRevision = surface.geometryRevision;
    this.definition = Object.freeze({ ...authored });
    this.actorDefinition = Object.freeze({ ...actorDefinition });
    this.#shapes = new Map(
      [...shapes].map(([id, shape]) => [
        id,
        Object.freeze({ ...shape, rect: Object.freeze({ ...shape.rect }) }),
      ]),
    );
    let actor = sourceActor;
    const samples = [continuation(actor)];
    const poses = [
      Object.freeze({
        x: actor.body.x,
        y: actor.body.y,
        shapeId: actor.body.shapeId,
        facing: actor.facing,
      }),
    ];
    const commands: Readonly<FootIntent>[] = [];
    let landed = false;
    for (let tick = 1; tick <= authored.maxTicks; tick++) {
      const command = Object.freeze({
        held:
          (authored.direction < 0 ? Held.Left : authored.direction > 0 ? Held.Right : 0) |
          (authored.kind === "drop" && tick === 1 ? Held.Down : 0),
        jumpPressed: tick === 1,
      });
      const frame = { tick, geometryRevision: this.geometryRevision };
      const result = stepFootController(
        actor,
        command,
        this.actorDefinition,
        this.#shapes,
        new CollisionIndex(grid, [], frame),
        frame,
      );
      if (result.status !== "complete") throw new Error("Traversal controller failed");
      if (tick === 1 && !result.events.some((event) => event.kind === authored.kind))
        throw new Error("Traversal launch was not consumed");
      if (
        result.physics.movement.contacts.some(
          (contact) => contact.normal.x !== 0 || contact.normal.y === 1,
        )
      )
        throw new Error("Traversal trajectory lacks clearance");
      actor = result.actor;
      commands.push(command);
      samples.push(continuation(actor));
      poses.push(
        Object.freeze({
          x: actor.body.x,
          y: actor.body.y,
          shapeId: actor.body.shapeId,
          facing: actor.facing,
        }),
      );
      if (actor.body.grounded) {
        const arrival = surface.locate(
          actor.body.x,
          actor.body.y,
          actor.facing,
          this.geometryRevision,
        );
        if (
          arrival?.id !== destination.id ||
          actor.body.x < authored.destinationMinX ||
          actor.body.x > authored.destinationMaxX
        )
          throw new Error("Traversal first landing misses destination");
        landed = true;
        break;
      }
    }
    if (!landed) throw new Error("Traversal does not land within its duration");
    this.commands = Object.freeze(commands);
    this.poses = Object.freeze(poses);
    this.#samples = Object.freeze(samples);
    Object.freeze(this);
  }
  begin(actor: FootActor, startTick: number): TraversalCursor {
    integer(startTick, 0, COUNTER_LIMIT - 182, "traversal start tick");
    if (
      !ready(actor) ||
      actor.geometryRevision !== this.geometryRevision ||
      continuation(actor) !== this.#samples[0]
    )
      throw new Error("Traversal source state mismatch");
    return { linkId: this.id, startTick, elapsed: 0 };
  }
  step<T extends FootActor>(
    actor: T,
    cursor: TraversalCursor,
    index: CollisionIndex,
    frame: CollisionFrame,
  ): TraversalStep<T> {
    index.assertFrame(frame);
    integer(cursor.startTick, 0, COUNTER_LIMIT - 182, "traversal start tick");
    integer(cursor.elapsed, 0, this.commands.length - 1, "traversal cursor");
    if (cursor.linkId !== this.id || frame.tick !== cursor.startTick + cursor.elapsed + 1)
      throw new Error("Traversal tick/cursor mismatch");
    const reason =
      frame.geometryRevision !== this.geometryRevision ||
      actor.geometryRevision !== frame.geometryRevision
        ? "geometry"
        : !ready(actor) || continuation(actor) !== this.#samples[cursor.elapsed]
          ? "state"
          : null;
    const command = reason ? { held: 0, jumpPressed: false } : this.commands[cursor.elapsed];
    if (!command) throw new Error("Missing traversal command");
    // Cancellation still advances this tick's actual physics. Never replay the launch edge or freeze an airborne actor.
    const result = stepFootController(
      {
        ...actor,
        geometryRevision: frame.geometryRevision,
        ...(reason ? { jumpBufferTicks: 0 } : {}),
      },
      command,
      this.actorDefinition,
      this.#shapes,
      index,
      frame,
    );
    if (result.status === "failed") return { status: "failed", result };
    if (reason || result.status !== "complete")
      return {
        status: "cancelled",
        reason: reason ?? "state",
        actor: result.actor,
        cursor: null,
        result,
      };
    if (continuation(result.actor) !== this.#samples[cursor.elapsed + 1])
      return {
        status: "cancelled",
        reason: "trajectory",
        actor: result.actor,
        cursor: null,
        result,
      };
    const elapsed = cursor.elapsed + 1;
    return {
      status: elapsed === this.commands.length ? "landed" : "active",
      actor: result.actor,
      cursor: elapsed === this.commands.length ? null : { ...cursor, elapsed },
      result,
    };
  }
}

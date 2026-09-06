import artifact from "../content/compiled/navigation.json" with { type: "json" };
import type { ActorDefinition, ShapeDefinition } from "../content/schema.js";
import { canonical } from "../core/canonical.js";
import { RouteFollower } from "../navigation/follower.js";
import { NavigationGraph } from "../navigation/graph.js";
import { CompiledTraversal, type TraversalDefinition } from "../navigation/links.js";
import { WalkSurface } from "../navigation/spans.js";
import type { SweepTarget } from "../physics/sweep.js";
import type { FootActor } from "../state.js";
import { footActor } from "./foot-fixture.js";

export const compiledPresentation = artifact.presentation;

/** Bundled compiler output only; raw LDtk and its schema validator never enter a runtime bundle. */
export function compiledLevelFixture() {
  const level = artifact.gameplay;
  const definitions = level.definitions.actors as ActorDefinition[];
  const definition = definitions.find((d) => d.id === level.entry.actorId);
  const shapes = new Map<number, ShapeDefinition>(level.definitions.shapes.map((s) => [s.id, s]));
  const shape = definition && shapes.get(definition.standingShapeId);
  if (!definition || !shape) throw new Error("Compiled actor missing");
  const targets = level.terrain as SweepTarget[];
  const surface = new WalkSurface(targets, shape, 1);
  const links = level.links
    .filter((l) => l.actorId === definition.id)
    .map(
      (l) =>
        new CompiledTraversal(
          l.definition as TraversalDefinition,
          l.actor as FootActor,
          definition,
          shapes,
          targets,
          surface,
        ),
    );
  const graph = new NavigationGraph(surface, definition, links);
  const actor = { ...footActor(), ...structuredClone(level.entry.actor) } as ReturnType<
    typeof footActor
  >;
  const destination = level.checkpoint as { x: number; y: number; facing: 1 };
  const route = graph.route(
    { x: actor.body.x, y: actor.body.y, facing: actor.facing },
    destination,
    1,
  );
  if (route.status !== "route" || canonical(route) !== canonical(level.route))
    throw new Error("Compiled checkpoint route mismatch");
  const follower = new RouteFollower(graph, route, shapes);
  return {
    actor,
    definition,
    shapes,
    targets,
    surface,
    links,
    graph,
    destination,
    route,
    follower,
    contentHash: artifact.contentHash,
    buildHash: artifact.buildHash,
  };
}

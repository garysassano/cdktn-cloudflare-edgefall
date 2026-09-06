import { pixels } from "../core/numeric.js";
import { RouteFollower } from "../navigation/follower.js";
import { NavigationGraph } from "../navigation/graph.js";
import { CompiledTraversal } from "../navigation/links.js";
import { WalkSurface } from "../navigation/spans.js";
import { FOOT_DEFINITION, FOOT_SHAPES, footActor, footTerrain } from "./foot-fixture.js";

export function routeFixture() {
  const definition = FOOT_DEFINITION,
    shape = FOOT_SHAPES.get(1);
  if (!definition || !shape) throw new Error("Missing route fixture definitions");
  const targets = [
    footTerrain(100, 0, 300, 100, 40),
    footTerrain(101, 130, 300, 120, 40),
    footTerrain(102, 280, 300, 220, 40),
  ];
  const surface = new WalkSurface(targets, shape, 1);
  const sources = [footActor(50, 300), footActor(200, 300)];
  const links = sources.map((actor, i) => {
    actor.body.supportId = 100 + i;
    const destinationX = actor.body.x + pixels(153);
    const source = surface.locate(actor.body.x, actor.body.y, 1, 1);
    const destination = surface.locate(destinationX, actor.body.y, 1, 1);
    if (!source || !destination) throw new Error("Missing route endpoint");
    return new CompiledTraversal(
      {
        id: i + 1,
        kind: "jump",
        sourceSpanId: source.id,
        sourceX: actor.body.x,
        destinationSpanId: destination.id,
        destinationMinX: destinationX,
        destinationMaxX: destinationX,
        direction: 1,
        maxTicks: 90,
      },
      actor,
      definition,
      FOOT_SHAPES,
      targets,
      surface,
    );
  });
  const actor = sources[0];
  if (!actor) throw new Error("Missing route actor");
  const graph = new NavigationGraph(surface, definition, links);
  const destination = { x: pixels(380), y: pixels(300), facing: 1 as const };
  const route = graph.route(
    { x: actor.body.x, y: actor.body.y, facing: actor.facing },
    destination,
    1,
  );
  if (route.status !== "route") throw new Error("Missing engineering route");
  const follower = new RouteFollower(graph, route, FOOT_SHAPES);
  return { actor, definition, targets, surface, links, graph, destination, route, follower };
}

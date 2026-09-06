import { RoutedEnemyDriver, createRoutedEnemy } from "../actors/routed.js";
import { pixels } from "../core/numeric.js";
import { NavigationGraph } from "../navigation/graph.js";
import { CompiledTraversal } from "../navigation/links.js";
import { WalkSurface } from "../navigation/spans.js";
import { FOOT_SHAPES, footState } from "./foot-fixture.js";
import { routeFixture } from "./route.js";

export function routedEnemyFixture(removed = false) {
  const base = routeFixture();
  const shape = FOOT_SHAPES.get(1);
  if (!shape) throw new Error("Missing enemy shape");
  const revision = removed ? 2 : 1;
  const targets = base.targets.filter((target) => !(removed && target.id === 102));
  const surface = new WalkSurface(targets, shape, revision);
  const links = [];
  for (const old of base.links) {
    const first = old.poses[0],
      last = old.poses.at(-1);
    if (!first || !last) throw new Error("Missing route poses");
    const source = surface.locate(first.x, first.y, first.facing, revision);
    const destination = surface.locate(last.x, last.y, last.facing, revision);
    if (!source || !destination) continue;
    const actor = footState();
    actor.body.id = 2;
    actor.body.x = first.x;
    actor.body.y = first.y;
    actor.facing = first.facing;
    actor.geometryRevision = revision;
    actor.body.supportId = source.supportIds[0] ?? null;
    links.push(
      new CompiledTraversal(
        { ...old.definition, sourceSpanId: source.id, destinationSpanId: destination.id },
        actor,
        base.definition,
        FOOT_SHAPES,
        targets,
        surface,
      ),
    );
  }
  const graph = new NavigationGraph(surface, base.definition, links);
  const bounds = { x: pixels(-30), y: pixels(-80), w: pixels(700), h: pixels(470) };
  const driver = new RoutedEnemyDriver(graph, FOOT_SHAPES, bounds);
  const actor = footState(50, 300);
  actor.body.id = 2;
  actor.geometryRevision = revision;
  return {
    graph,
    targets,
    driver,
    bounds,
    links,
    goal: base.destination,
    enemy: createRoutedEnemy(actor, base.destination),
    preview: removed ? null : base.follower,
  };
}

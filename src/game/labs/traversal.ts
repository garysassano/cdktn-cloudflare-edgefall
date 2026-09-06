import { pixels } from "../core/numeric.js";
import { CompiledTraversal } from "../navigation/links.js";
import { WalkSurface } from "../navigation/spans.js";
import { FOOT_DEFINITION, FOOT_SHAPES, footActor, footTerrain } from "./foot-fixture.js";

/** Explicit engineering endpoints, not inferred navigation or campaign content. */
export function traversalFixture(kind: "jump" | "drop") {
  if (!FOOT_DEFINITION) throw new Error("Missing lab actor definition");
  const shape = FOOT_SHAPES.get(1);
  if (!shape) throw new Error("Missing lab shape");
  const actor = kind === "jump" ? footActor(100, 300) : footActor(220, 220);
  const targets =
    kind === "jump"
      ? [footTerrain(100, 0, 300, 140, 40), footTerrain(101, 210, 300, 220, 40)]
      : [footTerrain(100, 160, 220, 140, 8, "one-way"), footTerrain(101, 0, 300, 640, 40)];
  const surface = new WalkSurface(targets, shape, 1);
  const source = surface.locate(actor.body.x, actor.body.y, 1, 1);
  const destination = surface.locate(pixels(kind === "jump" ? 253 : 220), pixels(300), 1, 1);
  if (!source || !destination) throw new Error("Missing traversal endpoint span");
  const authored = {
    id: kind === "jump" ? 1 : 2,
    kind,
    sourceSpanId: source.id,
    sourceX: actor.body.x,
    destinationSpanId: destination.id,
    destinationMinX: pixels(kind === "jump" ? 220 : 210),
    destinationMaxX: pixels(kind === "jump" ? 400 : 230),
    direction: kind === "jump" ? (1 as const) : (0 as const),
    maxTicks: 90,
  };
  const link = new CompiledTraversal(
    authored,
    actor,
    FOOT_DEFINITION,
    FOOT_SHAPES,
    targets,
    surface,
  );
  return { actor, targets, surface, authored, link };
}

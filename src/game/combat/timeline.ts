import type { PoseDefinition, TimelineDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer } from "../core/numeric.js";
import type { ActionClock } from "../state.js";

export interface ActionCatalog {
  timelines: ReadonlyMap<number, TimelineDefinition>;
  poses: ReadonlyMap<number, PoseDefinition>;
}
export function actionPose(catalog: ActionCatalog, definitionId: number, age: number) {
  const timeline = catalog.timelines.get(definitionId);
  if (!timeline) throw new Error("Missing action timeline");
  integer(age, 0, COUNTER_LIMIT - 1, "action age");
  if (age >= timeline.durationTicks) return null;
  let remaining = age;
  for (const id of timeline.poses) {
    const pose = catalog.poses.get(id);
    if (!pose) throw new Error("Missing action pose");
    if (remaining < pose.durationTicks) return pose;
    remaining -= pose.durationTicks;
  }
  throw new Error("Action pose exposures do not cover timeline");
}

/** A checkpoint owns the marker cursor. Skipping an unevaluated tick is a replay error. */
export function stepAction<T extends ActionClock>(
  current: T,
  tick: number,
  catalog: ActionCatalog,
) {
  integer(tick, current.stateStartTick, COUNTER_LIMIT - 1, "action tick");
  const definition = catalog.timelines.get(current.definitionId);
  if (!definition) throw new Error("Missing action definition");
  const age = tick - current.stateStartTick;
  integer(current.nextMarkerIndex, 0, definition.markers.length, "action marker cursor");
  if (
    definition.markers.slice(0, current.nextMarkerIndex).some((marker) => marker.tickOffset > age)
  )
    throw new Error("Action cursor acknowledges a future marker");
  if ((definition.markers[current.nextMarkerIndex]?.tickOffset ?? age) < age)
    throw new Error("Action timeline skipped an unprocessed marker");
  const action = { ...current };
  const markers: Array<{
    actionInstanceId: number;
    markerIndex: number;
    marker: TimelineDefinition["markers"][number];
    pose: PoseDefinition;
  }> = [];
  const pose = actionPose(catalog, current.definitionId, age);
  while (definition.markers[action.nextMarkerIndex]?.tickOffset === age) {
    const marker = definition.markers[action.nextMarkerIndex];
    if (!marker || !pose) throw new Error("Marker outside active pose");
    markers.push({
      actionInstanceId: action.actionInstanceId,
      markerIndex: action.nextMarkerIndex++,
      marker,
      pose,
    });
  }
  return { action, markers, pose, finished: age >= definition.durationTicks };
}

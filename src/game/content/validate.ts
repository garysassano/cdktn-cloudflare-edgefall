import { canonical } from "../core/canonical.js";
import { COUNTER_LIMIT, MAX_SHAPE, integer, motion, position } from "../core/numeric.js";
import type { Point, Rect } from "../state.js";
import type { ContentDefinition } from "./schema.js";

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid content: ${message}`);
}
function unique<T extends { id: string | number }>(values: T[], label: string): Map<T["id"], T> {
  check(values.length <= 4096, `${label} count`);
  const table = new Map<T["id"], T>();
  for (const value of values) {
    if (typeof value.id === "number") integer(value.id, 1, COUNTER_LIMIT - 1, label);
    check(!table.has(value.id), `duplicate ${label} ID ${value.id}`);
    table.set(value.id, value);
  }
  return table;
}
function point(value: Point, local = false): void {
  const maximum = local ? MAX_SHAPE : 2 ** 24;
  integer(value.x, -maximum, maximum, "point x");
  integer(value.y, -maximum, maximum, "point y");
}
function rectangle(rect: Rect, local = false): void {
  point(rect, local);
  integer(rect.w, 1, local ? MAX_SHAPE : 2 ** 24, "rectangle width");
  integer(rect.h, 1, local ? MAX_SHAPE : 2 ** 24, "rectangle height");
  position(rect.x + rect.w);
  position(rect.y + rect.h);
}

/** Validate typed compiled content before bundling. Raw editor JSON schema is W02's compiler boundary. */
export function validateContent(content: ContentDefinition): void {
  canonical(content); // Reject fractional/nonfinite numbers and nonportable metadata.
  check(content.format === 1 && content.simulationHz === 60, "format/tick rate");
  const shapes = unique(content.shapes, "shape");
  const poses = unique(content.poses, "pose");
  const timelines = unique(content.timelines, "timeline");
  const attacks = unique(content.attacks, "attack");
  const weapons = unique(content.weapons, "weapon");
  const actors = unique(content.actors, "actor");
  const vehicles = unique(content.vehicles, "vehicle");
  const entities = new Set(unique(content.terrain, "terrain").keys());
  unique(content.encounters, "encounter");
  for (const shape of content.shapes) rectangle(shape.rect, true);
  for (const pose of content.poses) {
    integer(pose.durationTicks, 1, 3600, "pose duration");
    check(pose.frame.length > 0, "missing frame identity");
    check(
      pose.sockets.length <= 8 &&
        new Set(pose.sockets.map((socket) => socket.name)).size === pose.sockets.length,
      "duplicate/excess sockets",
    );
    for (const socket of pose.sockets) point(socket.point, true);
    check(
      pose.hurtShapeIds.length <= 16 && pose.hurtShapeIds.every((id) => shapes.has(id)),
      "unknown/excess hurt shapes",
    );
  }
  for (const timeline of content.timelines) {
    integer(timeline.durationTicks, 1, 3600, "timeline duration");
    check(
      timeline.poses.length > 0 &&
        timeline.poses.length <= 256 &&
        timeline.poses.every((id) => poses.has(id)),
      "missing/excess timeline poses",
    );
    const duration = timeline.poses.reduce(
      (sum, id) => sum + (poses.get(id)?.durationTicks ?? 0),
      0,
    );
    check(duration === timeline.durationTicks, "timeline exposure duration mismatch");
    check(timeline.markers.length <= 128, "excess markers");
    let previous = -1;
    for (const marker of timeline.markers) {
      integer(marker.tickOffset, 0, timeline.durationTicks - 1, "marker tick");
      check(marker.tickOffset >= previous, "unordered markers");
      previous = marker.tickOffset;
      let age = marker.tickOffset;
      const pose = timeline.poses
        .map((id) => poses.get(id))
        .find((candidate) => {
          if (!candidate) return false;
          if (age < candidate.durationTicks) return true;
          age -= candidate.durationTicks;
          return false;
        });
      check(
        Boolean(pose?.sockets.some((socket) => socket.name === marker.socket)),
        "missing active pose socket",
      );
      if (marker.kind === "spawn-attack" || marker.kind === "activate-hitbox")
        check(attacks.has(marker.payloadId), "unknown marker attack");
      if (marker.kind === "seat-transfer")
        check(vehicles.has(marker.payloadId), "unknown marker vehicle");
    }
  }
  for (const attack of content.attacks) {
    check(shapes.has(attack.shapeId), "unknown attack shape");
    motion(attack.speed);
    integer(attack.damage, 1, 65535, "damage");
    integer(attack.lifetimeTicks, 1, 3600, "attack lifetime");
    integer(attack.maxTargets, 1, 256, "attack target limit");
    integer(attack.repeatDamageTicks, 0, 3600, "damage interval");
  }
  for (const weapon of content.weapons) {
    check(
      attacks.has(weapon.attackId) && timelines.has(weapon.timelineId),
      "unknown weapon action",
    );
    integer(weapon.cadenceTicks, 1, 3600, "weapon cadence");
    integer(weapon.ammoPerAction, 0, 65535, "ammo cost");
    if (weapon.pickupAmmo !== "unlimited")
      integer(weapon.pickupAmmo, 1, 65535, "pickup ammunition");
    check(
      weapon.pickupAmmo === "unlimited" ? weapon.ammoPerAction === 0 : weapon.ammoPerAction > 0,
      "inconsistent ammo policy",
    );
    check(
      weapon.visualFamily.length > 0 && weapon.audioFamily.length > 0,
      "missing weapon media family",
    );
  }
  for (const actor of content.actors) {
    check(
      shapes.has(actor.standingShapeId) &&
        shapes.has(actor.crouchedShapeId) &&
        poses.has(actor.idlePoseId),
      "unknown actor shape/pose",
    );
    for (const value of [actor.runSpeed, actor.jumpVelocity, actor.gravity, actor.terminalVelocity])
      motion(value);
    check(
      actor.runSpeed >= 0 &&
        actor.gravity >= 0 &&
        actor.terminalVelocity > 0 &&
        actor.jumpVelocity <= 0,
      "actor movement signs",
    );
  }
  for (const vehicle of content.vehicles) {
    check(
      actors.has(vehicle.actorId) &&
        weapons.has(vehicle.weaponId) &&
        shapes.has(vehicle.seat.boardingSensorShapeId) &&
        timelines.has(vehicle.seat.boardingTimelineId),
      "unknown vehicle reference",
    );
    integer(vehicle.armor, 1, 65535, "vehicle armor");
    point(vehicle.seat.socket, true);
    check(
      vehicle.seat.ejectionCandidates.length > 0 && vehicle.seat.ejectionCandidates.length <= 8,
      "ejection candidates",
    );
    for (const candidate of vehicle.seat.ejectionCandidates) point(candidate, true);
  }
  for (const terrain of content.terrain) {
    rectangle(terrain.rect);
    check(terrain.visibleSurfaceId.length > 0, "invisible terrain");
  }
  for (const encounter of content.encounters) {
    rectangle(encounter.camera);
    rectangle(encounter.killBounds);
    point(encounter.checkpoint);
    check(
      encounter.spawns.length <= 256 && encounter.vehicleSpawns.length <= 16,
      "encounter entity budget",
    );
    for (const spawn of [...encounter.spawns, ...encounter.vehicleSpawns]) {
      integer(spawn.id, 1, COUNTER_LIMIT - 1, "spawn ID");
      check(!entities.has(spawn.id), "reused world entity ID");
      entities.add(spawn.id);
      point(spawn.point);
      if ("actorId" in spawn) check(actors.has(spawn.actorId), "unknown spawn actor");
      else check(vehicles.has(spawn.definitionId), "unknown spawn vehicle");
    }
  }
}

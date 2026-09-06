import type { FirearmCatalog, FirearmProfile } from "../combat/firearm.js";
import { CONTRACT_FIXTURE } from "../content/contract-fixture.js";
import type { ContentDefinition } from "../content/schema.js";
import { validateContent } from "../content/validate.js";
import { pixels } from "../core/numeric.js";

/** Authored engineering exposures and sockets. No final art or HMG turn-sweep acceptance. */
export const COMBAT_CONTENT: ContentDefinition = structuredClone(CONTRACT_FIXTURE);
COMBAT_CONTENT.shapes.push(
  { id: 7, rect: { x: pixels(-5), y: pixels(-18), w: pixels(10), h: pixels(16) } },
  { id: 8, rect: { x: pixels(5), y: pixels(-30), w: pixels(4), h: pixels(28) } },
);
const sidearm = COMBAT_CONTENT.weapons[0];
const attack = COMBAT_CONTENT.attacks[0];
if (!sidearm || !attack) throw new Error("Missing baseline firearm content");
sidearm.cadenceTicks = 8;
const hmg = {
  ...sidearm,
  id: "heavy-machine-gun" as const,
  attackId: 2,
  cadenceTicks: 5,
  ammoPerAction: 1,
  pickupAmmo: 150,
  timelineId: 14,
  visualFamily: "fixture-hmg",
  audioFamily: "fixture-hmg",
};
COMBAT_CONTENT.weapons.push(hmg);
COMBAT_CONTENT.attacks.push({ ...attack, id: 2, speed: pixels(18) });
const profiles: FirearmProfile[] = [];
for (const [index, weapon] of [sidearm, hmg].entries()) {
  const base = 10 + index * 4;
  const timelineIds: [number, number, number, number] = [base, base + 1, base + 2, base + 3];
  weapon.timelineId = base;
  for (const [poseIndex, id] of timelineIds.entries()) {
    const muzzle = [
      { x: pixels(15), y: pixels(-23) },
      { x: pixels(2), y: pixels(-36) },
      { x: pixels(2), y: 0 },
      { x: pixels(15), y: pixels(-12) },
    ][poseIndex];
    if (!muzzle) throw new Error("Missing firearm socket");
    COMBAT_CONTENT.poses.push({
      id,
      frame: `engineering-${weapon.id}-${poseIndex}`,
      durationTicks: 4,
      sockets: [
        { name: "muzzle", point: muzzle },
        { name: "hand", point: { x: 0, y: poseIndex === 3 ? pixels(-12) : pixels(-23) } },
      ],
      hurtShapeIds: [poseIndex === 3 ? 7 : 3],
    });
    COMBAT_CONTENT.timelines.push({
      id,
      durationTicks: 4,
      poses: [id],
      markers: [
        { tickOffset: 0, kind: "spawn-attack", payloadId: weapon.attackId, socket: "muzzle" },
        { tickOffset: 0, kind: "sound", payloadId: weapon.attackId, socket: "muzzle" },
        { tickOffset: 2, kind: "sound", payloadId: weapon.attackId, socket: "hand" },
      ],
    });
  }
  profiles.push({ weapon, timelineIds });
}
validateContent(COMBAT_CONTENT);
export const COMBAT_CATALOG: FirearmCatalog = {
  firearms: new Map(profiles.map((profile) => [profile.weapon.id, profile])),
  timelines: new Map(COMBAT_CONTENT.timelines.map((timeline) => [timeline.id, timeline])),
  poses: new Map(COMBAT_CONTENT.poses.map((pose) => [pose.id, pose])),
};
export const COMBAT_SHAPES = new Map(COMBAT_CONTENT.shapes.map((shape) => [shape.id, shape]));
export const COMBAT_ATTACKS = new Map(
  COMBAT_CONTENT.attacks.map((definition) => [definition.id, definition]),
);

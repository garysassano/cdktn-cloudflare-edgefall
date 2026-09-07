import type { RifleProfile } from "../actors/rifle.js";
import type { ShieldProfile } from "../actors/shield.js";
import { type AreaProfile, validateAreaProfile } from "../combat/area-attack.js";
import type { FirearmCatalog, FirearmProfile } from "../combat/firearm.js";
import type { FootActionProfiles } from "../combat/foot-actions.js";
import type { GrenadeProfile } from "../combat/grenade.js";
import { CONTRACT_FIXTURE } from "../content/contract-fixture.js";
import type { ContentDefinition } from "../content/schema.js";
import { validateContent } from "../content/validate.js";
import { pixels } from "../core/numeric.js";
import { type TankProfile, validateTankProfile } from "../vehicles/tank.js";

/** Authored engineering exposures and sockets. No final art or HMG turn-sweep acceptance. */
export const COMBAT_CONTENT: ContentDefinition = structuredClone(CONTRACT_FIXTURE);
COMBAT_CONTENT.shapes.push(
  { id: 7, rect: { x: pixels(-5), y: pixels(-18), w: pixels(10), h: pixels(16) } },
  { id: 8, rect: { x: pixels(5), y: pixels(-30), w: pixels(4), h: pixels(28) } },
  { id: 9, rect: { x: pixels(-10), y: pixels(-8), w: pixels(34), h: pixels(16) } },
  { id: 10, rect: { x: pixels(-3), y: pixels(-3), w: pixels(6), h: pixels(6) } },
  { id: 11, rect: { x: pixels(-48), y: pixels(-48), w: pixels(96), h: pixels(96) } },
  { id: 12, rect: { x: 0, y: pixels(-10), w: pixels(30), h: pixels(24) } },
  { id: 13, rect: { x: 0, y: pixels(-3), w: pixels(20), h: pixels(6) } },
  { id: 14, rect: { x: 0, y: pixels(-8), w: pixels(14), h: pixels(8) } },
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
const shotgun = {
  ...sidearm,
  id: "shotgun" as const,
  attackId: 10,
  cadenceTicks: 28,
  ammoPerAction: 1,
  pickupAmmo: 24,
  visualFamily: "fixture-shotgun",
  audioFamily: "fixture-shotgun",
};
const flame = {
  ...sidearm,
  id: "flamethrower" as const,
  attackId: 11,
  cadenceTicks: 30,
  ammoPerAction: 1,
  pickupAmmo: 30,
  visualFamily: "fixture-flame",
  audioFamily: "fixture-flame",
};
COMBAT_CONTENT.weapons.push(shotgun, flame);
COMBAT_CONTENT.attacks.push(
  {
    id: 10,
    kind: "shot-volume",
    shapeId: 13,
    damage: 4,
    lifetimeTicks: 6,
    speed: 0,
    maxTargets: 16,
    repeatDamageTicks: 0,
    material: "bullet",
  },
  {
    id: 11,
    kind: "flame-volumes",
    shapeId: 14,
    damage: 1,
    lifetimeTicks: 30,
    speed: 0,
    maxTargets: 16,
    repeatDamageTicks: 6,
    material: "heat",
  },
);
export const AREA_PROFILES: ReadonlyMap<number, AreaProfile> = new Map([
  [
    10,
    {
      kind: "shot-volume",
      emissionOffsets: [0],
      attachedTicks: 0,
      maximumReach: pixels(110),
      frames: [20, 40, 60, 80, 100, 110].map((length, age) => ({
        x: 0,
        y: -pixels(3 + age * 2),
        w: pixels(length),
        h: pixels(6 + age * 4),
      })),
    },
  ],
  [
    11,
    {
      kind: "flame-volumes",
      emissionOffsets: [0, 6, 12],
      attachedTicks: 6,
      maximumReach: pixels(90),
      frames: Array.from({ length: 18 }, (_, age) => {
        const width = age < 6 ? ([14, 18, 24, 28, 32, 36][age] ?? 0) : 36;
        const height = age < 6 ? 8 + Math.min(age, 3) * 2 : age < 14 ? 14 : 10;
        return {
          x: age < 6 ? 0 : (age - 5) * (pixels(4) + 128),
          y: pixels((age < 6 ? ([-4, -2, 0, 2, 4, 2][age] ?? 0) : 2) - height / 2),
          w: pixels(width),
          h: pixels(height),
        };
      }),
    },
  ],
]);
export const FOOT_ACTION_PROFILES: FootActionProfiles = {
  melee: { timelineIds: [40, 41], cooldownTicks: 18 },
  grenade: { timelineIds: [50, 51], cooldownTicks: 20 },
};
export const GRENADE_PROFILE: GrenadeProfile = {
  bodyShapeId: 10,
  fuseTicks: 90,
  gravity: 55,
  terminalVelocity: 2048,
  maximumBounces: 3,
  radius: pixels(48),
  standingVelocity: { x: pixels(2) + 128, y: -pixels(4) - 128 },
  crouchedVelocity: { x: pixels(4), y: -pixels(1) - 128 },
};
COMBAT_CONTENT.attacks.push(
  {
    id: 4,
    kind: "melee",
    shapeId: 9,
    damage: 1,
    lifetimeTicks: 4,
    speed: 0,
    maxTargets: 4,
    repeatDamageTicks: 0,
    material: "blade",
  },
  {
    id: 5,
    kind: "explosion",
    shapeId: 11,
    damage: 1,
    lifetimeTicks: GRENADE_PROFILE.fuseTicks,
    speed: GRENADE_PROFILE.standingVelocity.x,
    maxTargets: 16,
    repeatDamageTicks: 0,
    material: "explosive",
  },
);
for (const kind of ["melee", "grenade"] as const) {
  const profile = FOOT_ACTION_PROFILES[kind];
  for (const [stance, id] of profile.timelineIds.entries()) {
    const durations = kind === "melee" ? [5, 4, 9] : [4, 1, 15];
    const poseIds = [id, id + 2, id + 4];
    for (const [phase, poseId] of poseIds.entries())
      COMBAT_CONTENT.poses.push({
        id: poseId,
        frame: `engineering-${kind}-${stance}-${phase}`,
        durationTicks: durations[phase] ?? 0,
        sockets: [
          {
            name: "hand",
            point: { x: pixels(10), y: pixels(stance === 1 ? -12 : kind === "melee" ? -20 : -24) },
          },
        ],
        hurtShapeIds: [stance === 1 ? 7 : 3],
      });
    COMBAT_CONTENT.timelines.push({
      id,
      durationTicks: profile.cooldownTicks,
      poses: poseIds,
      markers: [
        {
          tickOffset: durations[0] ?? 0,
          kind: kind === "melee" ? "activate-hitbox" : "spawn-attack",
          payloadId: kind === "melee" ? 4 : 5,
          socket: "hand",
        },
        {
          tickOffset: durations[0] ?? 0,
          kind: "sound",
          payloadId: kind === "melee" ? 4 : 5,
          socket: "hand",
        },
      ],
    });
  }
}
export const RIFLE_PROFILE: RifleProfile = {
  timelineIds: [30, 31],
  raiseTicks: 24,
  lastReleaseTick: 36,
  range: pixels(240),
  upAlignment: pixels(24),
  upHeight: pixels(48),
  aimHeight: pixels(16),
};
COMBAT_CONTENT.attacks.push({ ...attack, id: 3, speed: pixels(3), lifetimeTicks: 150 });
for (const [aim, id] of RIFLE_PROFILE.timelineIds.entries()) {
  const muzzle = aim === 0 ? { x: pixels(15), y: pixels(-23) } : { x: pixels(2), y: pixels(-36) };
  const poseIds = [id, id + 2, id + 4];
  for (const [phase, poseId] of poseIds.entries())
    COMBAT_CONTENT.poses.push({
      id: poseId,
      frame: `engineering-rifle-${aim}-${phase}`,
      durationTicks: [24, 13, 35][phase] ?? 0,
      sockets: [
        { name: "muzzle", point: muzzle },
        { name: "hand", point: { x: 0, y: pixels(-23) } },
      ],
      hurtShapeIds: [3],
    });
  COMBAT_CONTENT.timelines.push({
    id,
    durationTicks: 72,
    poses: poseIds,
    markers: [24, 30, 36].flatMap((tickOffset) => [
      { tickOffset, kind: "spawn-attack" as const, payloadId: 3, socket: "muzzle" as const },
      { tickOffset, kind: "sound" as const, payloadId: 3, socket: "muzzle" as const },
    ]),
  });
}
export const SHIELD_PROFILE: ShieldProfile = {
  timelineIds: { brace: 100, advance: 101, turn: 102, bash: 103, stunned: 104 },
  integrity: 2,
  speed: pixels(1),
  sightRange: pixels(384),
  bashRange: pixels(29),
  bashHeight: pixels(24),
  bashActiveTick: 12,
  bashActiveTicks: 4,
  damageByMaterial: { bullet: 0, explosive: 2, heat: 1, blade: 0, blunt: 1 },
};
COMBAT_CONTENT.attacks.push({
  id: 6,
  kind: "melee",
  shapeId: 12,
  damage: 1,
  lifetimeTicks: 4,
  speed: 0,
  maxTargets: 4,
  repeatDamageTicks: 0,
  material: "blunt",
});
for (const [index, durationTicks] of [24, 36, 9, 9, 12, 4, 14, 36].entries())
  COMBAT_CONTENT.poses.push({
    id: 100 + index,
    frame: `engineering-shield-${index}`,
    durationTicks,
    sockets: [{ name: "hand", point: { x: 0, y: pixels(-18) } }],
    hurtShapeIds: [3],
  });
COMBAT_CONTENT.timelines.push(
  { id: 100, durationTicks: 24, poses: [100], markers: [] },
  { id: 101, durationTicks: 36, poses: [101], markers: [] },
  {
    id: 102,
    durationTicks: 18,
    poses: [102, 103],
    markers: [
      { tickOffset: 9, kind: "face", payloadId: 1, socket: "hand" },
      { tickOffset: 9, kind: "sound", payloadId: 8, socket: "hand" },
    ],
  },
  {
    id: 103,
    durationTicks: 30,
    poses: [104, 105, 106],
    markers: [
      { tickOffset: 12, kind: "activate-hitbox", payloadId: 6, socket: "hand" },
      { tickOffset: 12, kind: "sound", payloadId: 6, socket: "hand" },
    ],
  },
  {
    id: 104,
    durationTicks: 36,
    poses: [107],
    markers: [{ tickOffset: 0, kind: "sound", payloadId: 7, socket: "hand" }],
  },
);
const profiles: FirearmProfile[] = [];
for (const [index, weapon] of [sidearm, hmg, shotgun, flame].entries()) {
  const base = 10 + index * 4;
  const timelineIds: [number, number, number, number] = [base, base + 1, base + 2, base + 3];
  weapon.timelineId = base;
  const duration = weapon.id === "flamethrower" ? 30 : weapon.id === "shotgun" ? 12 : 4;
  const emissions = AREA_PROFILES.get(weapon.attackId)?.emissionOffsets ?? [0];
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
      durationTicks: duration,
      sockets: [
        { name: "muzzle", point: muzzle },
        { name: "hand", point: { x: 0, y: poseIndex === 3 ? pixels(-12) : pixels(-23) } },
      ],
      hurtShapeIds: [poseIndex === 3 ? 7 : 3],
    });
    COMBAT_CONTENT.timelines.push({
      id,
      durationTicks: duration,
      poses: [id],
      markers: [
        ...emissions.flatMap((tickOffset) => [
          {
            tickOffset,
            kind: "spawn-attack" as const,
            payloadId: weapon.attackId,
            socket: "muzzle" as const,
          },
          {
            tickOffset,
            kind: "sound" as const,
            payloadId: weapon.attackId,
            socket: "muzzle" as const,
          },
        ]),
        ...(weapon.id === "flamethrower"
          ? []
          : [
              {
                tickOffset: 2,
                kind: "sound" as const,
                payloadId: weapon.attackId,
                socket: "hand" as const,
              },
            ]),
      ],
    });
  }
  profiles.push({ weapon, timelineIds });
}
const tankActor = {
  id: 2,
  locomotion: "grounded" as const,
  standingShapeId: 15,
  crouchedShapeId: 15,
  idlePoseId: 130,
  runSpeed: pixels(3),
  jumpVelocity: -pixels(5),
  gravity: 64,
  terminalVelocity: pixels(8),
};
const tankDefinition = {
  id: 1,
  kind: "tank" as const,
  actorId: 2,
  armor: 3,
  weaponId: "heavy-machine-gun" as const,
  seat: {
    socket: { x: 0, y: -pixels(6) },
    ejectionCandidates: [
      { x: pixels(30), y: 0 },
      { x: -pixels(30), y: 0 },
      { x: 0, y: -pixels(38) },
    ],
    boardingSensorShapeId: 16,
    boardingTimelineId: 130,
  },
};
export const TANK_PROFILE: TankProfile = {
  definition: tankDefinition,
  locomotion: tankActor,
  exitTimelineId: 131,
  fireTimelineIds: Array.from({ length: 8 }, (_, i) => 140 + i),
  attackId: 16,
  fireCadenceTicks: 5,
  turnTicks: 3,
  damageProtectionTicks: 30,
  reboardTicks: 30,
  exitProtectionTicks: 12,
  disconnectGraceTicks: 15,
  fallBoundary: pixels(248),
  hardpoint: { x: 0, y: -pixels(24) },
  headings: [
    [26, -24, 20, 0],
    [20, -44, 14, -14],
    [0, -50, 0, -20],
    [-20, -44, -14, -14],
    [-26, -24, -20, 0],
    [-20, -4, -14, 14],
    [0, 2, 0, 20],
    [20, -4, 14, 14],
  ].map(([x = 0, y = 0, vx = 0, vy = 0]) => ({
    muzzle: { x: pixels(x), y: pixels(y) },
    velocity: { x: pixels(vx), y: pixels(vy) },
  })),
};
COMBAT_CONTENT.actors = COMBAT_CONTENT.actors.map((actor) => (actor.id === 2 ? tankActor : actor));
COMBAT_CONTENT.vehicles = [tankDefinition];
COMBAT_CONTENT.shapes.push(
  { id: 15, rect: { x: -pixels(20), y: -pixels(24), w: pixels(40), h: pixels(24) } },
  { id: 16, rect: { x: -pixels(40), y: -pixels(40), w: pixels(80), h: pixels(40) } },
);
COMBAT_CONTENT.attacks.push({
  id: 16,
  kind: "swept-projectile",
  shapeId: 4,
  damage: 1,
  lifetimeTicks: 40,
  speed: pixels(20),
  maxTargets: 1,
  repeatDamageTicks: 0,
  material: "bullet",
});
for (const [id, duration] of [
  [130, 12],
  [131, 8],
] as const) {
  COMBAT_CONTENT.poses.push({
    id,
    frame: `engineering-tank-${id === 130 ? "board" : "exit"}`,
    durationTicks: duration,
    sockets: [
      { name: "seat", point: tankDefinition.seat.socket },
      { name: "ejection", point: { x: pixels(30), y: 0 } },
    ],
    hurtShapeIds: [15],
  });
  COMBAT_CONTENT.timelines.push({
    id,
    durationTicks: duration,
    poses: [id],
    markers: [
      {
        tickOffset: duration - 1,
        kind: "seat-transfer",
        payloadId: 1,
        socket: id === 130 ? "seat" : "ejection",
      },
    ],
  });
}
for (const [heading, exposure] of TANK_PROFILE.headings.entries()) {
  const id = 140 + heading;
  COMBAT_CONTENT.poses.push({
    id,
    frame: `engineering-tank-fire-${heading}`,
    durationTicks: 3,
    sockets: [{ name: "muzzle", point: exposure.muzzle }],
    hurtShapeIds: [15],
  });
  COMBAT_CONTENT.timelines.push({
    id,
    durationTicks: 3,
    poses: [id],
    markers: [
      { tickOffset: 0, kind: "spawn-attack", payloadId: 16, socket: "muzzle" },
      { tickOffset: 0, kind: "sound", payloadId: 16, socket: "muzzle" },
    ],
  });
}

validateContent(COMBAT_CONTENT);
for (const [id, profile] of AREA_PROFILES) {
  const definition = COMBAT_CONTENT.attacks.find((attack) => attack.id === id);
  if (!definition) throw new Error("Missing area attack definition");
  validateAreaProfile(profile, definition);
}
export const COMBAT_CATALOG: FirearmCatalog = {
  firearms: new Map(profiles.map((profile) => [profile.weapon.id, profile])),
  timelines: new Map(COMBAT_CONTENT.timelines.map((timeline) => [timeline.id, timeline])),
  poses: new Map(COMBAT_CONTENT.poses.map((pose) => [pose.id, pose])),
};
export const COMBAT_SHAPES = new Map(COMBAT_CONTENT.shapes.map((shape) => [shape.id, shape]));
validateTankProfile(TANK_PROFILE, COMBAT_SHAPES, COMBAT_CATALOG);
export const COMBAT_ATTACKS = new Map(
  COMBAT_CONTENT.attacks.map((definition) => [definition.id, definition]),
);

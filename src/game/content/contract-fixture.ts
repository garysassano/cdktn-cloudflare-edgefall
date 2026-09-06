import { pixels } from "../core/numeric.js";
import type { ContentDefinition } from "./schema.js";

/** Engineering fixture only. Frame/audio identifiers are not claims of final produced assets. */
export const CONTRACT_FIXTURE: ContentDefinition = {
  format: 1,
  simulationHz: 60,
  shapes: [
    { id: 1, rect: { x: pixels(-7), y: pixels(-34), w: pixels(14), h: pixels(34) } },
    { id: 2, rect: { x: pixels(-7), y: pixels(-20), w: pixels(14), h: pixels(20) } },
    { id: 3, rect: { x: pixels(-5), y: pixels(-32), w: pixels(10), h: pixels(30) } },
    { id: 4, rect: { x: pixels(-1), y: pixels(-1), w: pixels(2), h: pixels(2) } },
    { id: 5, rect: { x: pixels(-40), y: pixels(-32), w: pixels(80), h: pixels(32) } },
    { id: 6, rect: { x: pixels(-24), y: pixels(-30), w: pixels(48), h: pixels(30) } },
  ],
  poses: [
    {
      id: 1,
      frame: "fixture-operative-idle",
      durationTicks: 6,
      sockets: [
        { name: "muzzle", point: { x: pixels(15), y: pixels(-23) } },
        { name: "hand", point: { x: pixels(10), y: pixels(-20) } },
      ],
      hurtShapeIds: [3],
    },
    {
      id: 2,
      frame: "fixture-tank-idle",
      durationTicks: 12,
      sockets: [
        { name: "seat", point: { x: 0, y: pixels(-20) } },
        { name: "ejection", point: { x: pixels(-40), y: 0 } },
      ],
      hurtShapeIds: [6],
    },
  ],
  timelines: [
    {
      id: 1,
      durationTicks: 6,
      poses: [1],
      markers: [{ tickOffset: 0, kind: "spawn-attack", payloadId: 1, socket: "muzzle" }],
    },
    {
      id: 2,
      durationTicks: 12,
      poses: [2],
      markers: [{ tickOffset: 11, kind: "seat-transfer", payloadId: 1, socket: "seat" }],
    },
  ],
  attacks: [
    {
      id: 1,
      kind: "swept-projectile",
      shapeId: 4,
      damage: 1,
      lifetimeTicks: 30,
      speed: pixels(12),
      maxTargets: 1,
      repeatDamageTicks: 0,
      material: "bullet",
    },
  ],
  weapons: [
    {
      id: "sidearm",
      attackId: 1,
      timelineId: 1,
      cadenceTicks: 10,
      ammoPerAction: 0,
      pickupAmmo: "unlimited",
      aimPolicy: "cardinal",
      visualFamily: "fixture-sidearm",
      audioFamily: "fixture-sidearm",
    },
  ],
  actors: [
    {
      id: 1,
      locomotion: "grounded",
      standingShapeId: 1,
      crouchedShapeId: 2,
      idlePoseId: 1,
      runSpeed: 768,
      jumpVelocity: -1430,
      gravity: 55,
      terminalVelocity: 2048,
    },
    {
      id: 2,
      locomotion: "grounded",
      standingShapeId: 6,
      crouchedShapeId: 6,
      idlePoseId: 2,
      runSpeed: 640,
      jumpVelocity: -1200,
      gravity: 60,
      terminalVelocity: 2048,
    },
  ],
  vehicles: [
    {
      id: 1,
      kind: "tank",
      actorId: 2,
      armor: 3,
      weaponId: "sidearm",
      seat: {
        socket: { x: 0, y: pixels(-20) },
        ejectionCandidates: [
          { x: pixels(-40), y: 0 },
          { x: pixels(40), y: 0 },
        ],
        boardingSensorShapeId: 5,
        boardingTimelineId: 2,
      },
    },
  ],
  terrain: [
    {
      id: 100,
      kind: "solid",
      rect: { x: 0, y: pixels(200), w: pixels(384), h: pixels(16) },
      visibleSurfaceId: "fixture-floor",
    },
    {
      id: 101,
      kind: "one-way",
      rect: { x: pixels(100), y: pixels(145), w: pixels(80), h: pixels(8) },
      visibleSurfaceId: "fixture-platform",
    },
  ],
  encounters: [
    {
      id: 1,
      camera: { x: 0, y: 0, w: pixels(384), h: pixels(216) },
      killBounds: { x: pixels(-64), y: pixels(-64), w: pixels(512), h: pixels(320) },
      checkpoint: { x: pixels(32), y: pixels(200) },
      spawns: [
        {
          id: 102,
          actorId: 1,
          point: { x: pixels(50), y: pixels(200) },
          required: true,
          retreatAllowed: false,
        },
      ],
      vehicleSpawns: [{ id: 103, definitionId: 1, point: { x: pixels(250), y: pixels(200) } }],
    },
  ],
};

import type { Point, Rect, WeaponId } from "../state.js";

export interface ShapeDefinition {
  id: number;
  rect: Rect;
}
export interface PoseDefinition {
  id: number;
  frame: string;
  durationTicks: number;
  /** Feet/root-relative Q256 offsets. Atlas packing is not authoritative content. */
  sockets: Array<{ name: "muzzle" | "hand" | "seat" | "ejection"; point: Point }>;
  hurtShapeIds: number[];
}
export interface TimelineDefinition {
  id: number;
  durationTicks: number;
  poses: number[];
  markers: Array<{
    tickOffset: number;
    kind: "spawn-attack" | "activate-hitbox" | "seat-transfer" | "sound" | "face";
    payloadId: number;
    socket: "muzzle" | "hand" | "seat" | "ejection";
  }>;
}
export interface AttackDefinition {
  id: number;
  kind: "swept-projectile" | "shot-volume" | "beam" | "flame-volumes" | "melee" | "explosion";
  shapeId: number;
  damage: number;
  lifetimeTicks: number;
  speed: number;
  maxTargets: number;
  repeatDamageTicks: number;
  material: "bullet" | "explosive" | "heat" | "blade" | "blunt";
}
export interface WeaponDefinition {
  id: WeaponId;
  attackId: number;
  timelineId: number;
  cadenceTicks: number;
  ammoPerAction: number;
  pickupAmmo: number | "unlimited";
  aimPolicy: "cardinal" | "cardinal-sweep" | "turret";
  visualFamily: string;
  audioFamily: string;
}
export interface ActorDefinition {
  id: number;
  locomotion: "grounded" | "flying" | "mounted" | "anchored";
  standingShapeId: number;
  crouchedShapeId: number;
  idlePoseId: number;
  runSpeed: number;
  jumpVelocity: number;
  gravity: number;
  terminalVelocity: number;
}
export interface VehicleDefinition {
  id: number;
  kind: "tank" | "walker" | "aircraft";
  actorId: number;
  armor: number;
  weaponId: WeaponId;
  seat: {
    socket: Point;
    ejectionCandidates: Point[];
    boardingSensorShapeId: number;
    boardingTimelineId: number;
  };
}
export interface TerrainDefinition {
  id: number;
  rect: Rect;
  kind: "solid" | "one-way";
  visibleSurfaceId: string;
}
export interface EncounterDefinition {
  id: number;
  camera: Rect;
  killBounds: Rect;
  checkpoint: Point;
  spawns: Array<{
    id: number;
    actorId: number;
    point: Point;
    required: boolean;
    retreatAllowed: boolean;
  }>;
  vehicleSpawns: Array<{ id: number; definitionId: number; point: Point }>;
}
export interface ContentDefinition {
  format: 1;
  simulationHz: 60;
  shapes: ShapeDefinition[];
  poses: PoseDefinition[];
  timelines: TimelineDefinition[];
  attacks: AttackDefinition[];
  weapons: WeaponDefinition[];
  actors: ActorDefinition[];
  vehicles: VehicleDefinition[];
  terrain: TerrainDefinition[];
  encounters: EncounterDefinition[];
}

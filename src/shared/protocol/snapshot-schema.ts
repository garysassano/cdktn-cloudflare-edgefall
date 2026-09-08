import type { AreaExposure } from "../../game/combat/area-attack.js";
import type { DestructibleState } from "../../game/combat/destructible.js";
import type { WeaponPickupState } from "../../game/combat/pickups.js";
import type {
  EncounterFailure,
  EncounterState,
  Resolution,
} from "../../game/encounters/lifecycle.js";
import type { PlayerAcknowledgment } from "../../game/input/types.js";
import type { CampaignState, ControlledActor, Point, VehicleState } from "../../game/state.js";
import { MAX_COMBAT_BYTES } from "./combat-record.js";

export const ROOM_MODES = [
  "lobby",
  "loading",
  "playing",
  "intermission",
  "paused-empty",
  "recovering",
  "completed",
  "expired",
] as const;
export interface EnemySnapshot {
  id: number;
  definitionId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  shapeId: number;
  facing: -1 | 1;
  health: number;
  mode: number;
  stateStartTick: number;
  actionInstanceId: number;
  actionDefinitionId: number;
  modeTicks: number;
  supportId: number | null;
  geometryRevision: number;
}
export interface ProjectileSnapshot {
  id: number;
  ownerId: number;
  actionInstanceId: number;
  definitionId: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spawnTick: number;
  lifetimeTicks: number;
  heading: number;
  shapeId: number;
}
export interface PlatformSnapshot {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  shapeId: number;
  trajectoryId: number;
  trajectoryTick: number;
}
export interface ThreatSnapshot {
  actionInstanceId: number;
  sourceId: number;
  definitionId: number;
  telegraphTick: number;
  activeTick: number;
  endTick: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  targetId: number | null;
  motion: "linear" | "locked" | "authored";
  cancelled: boolean;
  stateVersion: number;
  shapeId: number;
}
export type CampaignSnapshot = Omit<CampaignState, "requiredEntities" | "resolvedEntities"> & {
  remainingEnemies: number;
};
/** Public encounter accounting. Private AI/watchdog/receipt state belongs in checkpoints. */
export interface CombatSnapshot {
  /** Registered authored scene; retained even after every destructible is removed. */
  scenarioId: number;
  props: DestructibleState[];
  pickups: WeaponPickupState["items"];
  volumes: AreaExposure[];
  nextEntityId: number;
  nextActionId: number;
  encounterEventCursor: number;
  encounterId: number;
  phase: EncounterState["phase"];
  members: Array<{
    id: number;
    required: boolean;
    critical: boolean;
    retreatAllowed: boolean;
    status: "pending" | "alive" | "resolved";
    activatedTick: number | null;
    resolvedTick: number | null;
    reason: Resolution | null;
    killerId: number | null;
  }>;
  objectives: EncounterState["objectives"];
  kills: EncounterState["kills"];
  failure: EncounterFailure | null;
}
export interface FullSnapshot {
  runEpoch: number;
  connectionEpoch: number;
  snapshotId: number;
  tick: number;
  baselineEventCursor: number;
  geometryRevision: number;
  /** Diagnostic FNV-1a value, not a content/authentication digest. */
  stateHash: number;
  roomMode: (typeof ROOM_MODES)[number];
  camera: Point;
  campaign: CampaignSnapshot;
  combat: CombatSnapshot | null;
  acknowledgments: PlayerAcknowledgment[];
  players: ControlledActor[];
  vehicles: VehicleState[];
  enemies: EnemySnapshot[];
  projectiles: ProjectileSnapshot[];
  platforms: PlatformSnapshot[];
  threats: ThreatSnapshot[];
  removedIds: number[];
}
export interface SnapshotContext {
  runEpoch: number;
  connectionEpoch: number;
  playerId: number;
  geometryRevision: number;
  /** The negotiated content's collision table must exist before decoding for prediction. */
  shapeIds: ReadonlySet<number>;
  /** Only fully loaded revisions may pass the header; validateGeometry checks their complete state. */
  geometryRevisions?: ReadonlySet<number>;
  validateGeometry?: (snapshot: FullSnapshot) => void;
}

export const SNAPSHOT_TYPE = 2;
export const SNAPSHOT_HEADER_BYTES = 64;
export const CAMPAIGN_BYTES = 40;
export const BODY_BYTES = 140;
export const PLAYER_BYTES = 304;
export const VEHICLE_BYTES = 364;
export const ENEMY_BYTES = 64;
export const PROJECTILE_BYTES = 48;
export const PLATFORM_BYTES = 32;
export const THREAT_BYTES = 64;
export const SNAPSHOT_CAPS = {
  players: 4,
  vehicles: 16,
  enemies: 128,
  projectiles: 256,
  platforms: 64,
  threats: 128,
  removedIds: 512,
} as const;
export const MIN_SNAPSHOT_BYTES = 448;
export const MAX_BASE_SNAPSHOT_BYTES = 40072;
export const MAX_SNAPSHOT_BYTES = MAX_BASE_SNAPSHOT_BYTES + MAX_COMBAT_BYTES;

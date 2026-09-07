import type { Aim, EdgeCursors } from "./input/types.js";
import type { RulesetId } from "./rules.js";

export type EntityId = number;
export type Tick = number;
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Point {
  x: number;
  y: number;
}
export interface Contact {
  otherId: EntityId;
  normalX: -1 | 0 | 1;
  normalY: -1 | 0 | 1;
  toiNumerator: number;
  toiDenominator: number;
  kind: "solid" | "one-way" | "platform";
}
export interface Body {
  id: EntityId;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Remainders from conservative integer motion integration. */
  remainderX: number;
  remainderY: number;
  shapeId: number;
  supportId: EntityId | null;
  grounded: boolean;
  contacts: Contact[];
}
export interface ActionClock {
  actionInstanceId: number;
  stateStartTick: Tick;
  definitionId: number;
  nextMarkerIndex: number;
}
export interface ActionState extends ActionClock {
  kind: "ready" | "fire" | "melee" | "grenade" | "enter" | "exit" | "hurt";
}
export type WeaponId =
  | "sidearm"
  | "heavy-machine-gun"
  | "shotgun"
  | "rocket-launcher"
  | "flamethrower"
  | "laser";
export interface WeaponState {
  id: WeaponId;
  ammo: number;
  cooldownTicks: number;
  shotOrdinal: number;
  lastActionInstanceId: number;
}
export interface FirearmAimState {
  /** Authored elevation index: -4 is down, 0 horizontal, 4 up; facing mirrors it. */
  pitch: number;
  nextStepTick: Tick;
}
/** Shared reversible locomotion; no player identity, inventory or transport cursors. */
export interface FootActor {
  body: Body;
  life: "alive" | "death" | "respawning" | "spectating";
  locomotion: "grounded" | "airborne" | "crouched" | "seated";
  action: ActionState;
  facing: -1 | 1;
  aim: Aim;
  jumpBufferTicks: number;
  coyoteTicks: number;
  ignoredSupportId: EntityId | null;
  ignoredSupportTicks: number;
  vehicleId: EntityId | null;
  geometryRevision: number;
}
/** Player-owned state extends shared locomotion with inventory and action continuation. */
export interface ControlledActor extends FootActor {
  playerId: number;
  slot: number;
  controlEpoch: number;
  /** Authoritative tick when the independent life phase began. */
  lifeStartTick: Tick;
  invulnerableTicks: number;
  reboardCooldownTicks: number;
  vehicleSpecialTicks: number;
  weapon: WeaponState;
  firearmAim: FirearmAimState;
  grenadeStock: number;
  grenadeCooldownTicks: number;
  meleeCooldownTicks: number;
  health: number;
  lives: number;
  lastRallyMission: number;
  processedEdgeIds: EdgeCursors;
}
export interface VehicleState {
  body: Body;
  definitionId: number;
  kind: "tank" | "walker" | "aircraft";
  lifecycle: "available" | "boarding" | "occupied" | "exiting" | "destroying" | "wreck";
  occupantId: EntityId | null;
  reservedBy: EntityId | null;
  controlEpoch: number;
  /** Vehicle lease generation and player input generation are independent counters. */
  ownerControlEpoch: number | null;
  facing: -1 | 1;
  heading: number;
  invulnerableTicks: number;
  armor: number;
  action: ActionState;
  components: Array<{ id: number; health: number; broken: boolean }>;
  weapon: WeaponState;
}
export interface CampaignState {
  ruleset: RulesetId;
  mission: number;
  checkpointId: number;
  continuesRemaining: number;
  continuesUsed: number;
  phase: "playing" | "wipe" | "intermission" | "victory" | "defeat";
  encounterId: number;
  requiredEntities: EntityId[];
  resolvedEntities: Array<{ id: EntityId; reason: "killed" | "retreated" | "out-of-bounds" }>;
}

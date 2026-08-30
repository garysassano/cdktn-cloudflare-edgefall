export const WORLD_WIDTH = 1600;
export const WORLD_HEIGHT = 900;
export const TICK_SECONDS = 0.05;

export type GamePhase = "lobby" | "wave" | "choice" | "boss" | "victory" | "defeat";
export type UpgradeId = "fury" | "fleet" | "reach" | "ward" | "second-wind";
export type EnemyKind = "wisp" | "brute" | "boss";
export type BossMode = "chase" | "windup-cleave" | "windup-slam" | "recover";

export interface InputFrame {
  aimX: number;
  aimY: number;
  attack: boolean;
  dash: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  sequence: number;
  up: boolean;
}

export interface PlayerState {
  angle: number;
  attackAnimation: number;
  attackCooldown: number;
  color: string;
  damage: number;
  dashCooldown: number;
  dashRemaining: number;
  hp: number;
  id: string;
  invulnerable: number;
  kills: number;
  lives: number;
  maxHp: number;
  name: string;
  range: number;
  respawnRemaining: number;
  speed: number;
  upgrades: UpgradeId[];
  x: number;
  y: number;
}

export interface EnemyState {
  angle: number;
  attackCycle: number;
  contactCooldown: number;
  hp: number;
  id: string;
  kind: EnemyKind;
  maxHp: number;
  mode: BossMode;
  modeTimer: number;
  radius: number;
  targetId?: string;
  x: number;
  y: number;
}

export type CombatEventType =
  | "boss-cleave"
  | "boss-slam"
  | "dash"
  | "enemy-down"
  | "hit"
  | "player-hit"
  | "respawn"
  | "slash";

export interface CombatEvent {
  amount?: number;
  id: string;
  sourceId?: string;
  targetId?: string;
  type: CombatEventType;
  x: number;
  y: number;
}

export interface GameState {
  elapsed: number;
  enemies: EnemyState[];
  events: CombatEvent[];
  phase: GamePhase;
  players: Record<string, PlayerState>;
  rng: number;
  roomCode: string;
  runId: string;
  seed: number;
  tick: number;
  upgradeChoices: UpgradeId[];
}

export type ClientMessage =
  | { type: "choose"; upgrade: UpgradeId }
  | { type: "input"; input: InputFrame }
  | { type: "restart" }
  | { type: "start" };

export type ServerMessage =
  | { type: "error"; message: string }
  | { type: "snapshot"; state: GameState }
  | { type: "welcome"; playerId: string; roomCode: string };

export const UPGRADE_COPY: Record<UpgradeId, { description: string; name: string }> = {
  fury: { name: "Rift Fury", description: "+35% weapon damage" },
  fleet: { name: "Ashstep", description: "+22% movement speed" },
  reach: { name: "Long Edge", description: "+30% attack reach" },
  ward: { name: "Iron Ward", description: "+45 maximum health and heal" },
  "second-wind": { name: "Second Wind", description: "+1 life and full heal" },
};

export function isUpgradeId(value: unknown): value is UpgradeId {
  return ["fury", "fleet", "reach", "ward", "second-wind"].includes(String(value));
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "start" || value.type === "restart") return true;
  if (value.type === "choose") return isUpgradeId(value.upgrade);
  if (value.type !== "input" || !isRecord(value.input)) return false;

  const input = value.input;
  return (
    finiteUnit(input.aimX) &&
    finiteUnit(input.aimY) &&
    Number.isSafeInteger(input.sequence) &&
    Number(input.sequence) >= 0 &&
    [input.attack, input.dash, input.down, input.left, input.right, input.up].every(
      (candidate) => typeof candidate === "boolean",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1;
}

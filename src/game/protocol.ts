export const PROTOCOL_VERSION = 2 as const;
export const LOGICAL_WIDTH = 640;
export const LOGICAL_HEIGHT = 360;
export const WORLD_HEIGHT = 360;
export const SIMULATION_HZ = 30;
export const TICK_SECONDS = 1 / SIMULATION_HZ;
export const MAX_PLAYERS = 4;
export const RECONNECT_RESERVATION_SECONDS = 90;

export const OPERATORS = ["rook", "vale"] as const;
export const PRIMARY_WEAPONS = ["carbine", "scattergun", "rivet-launcher", "beam"] as const;
export const ORDNANCE = ["cinder-bomb", "arc-mine"] as const;
export const RELICS = ["boiler-heart", "deadeye-lens", "slag-boots", "crew-standard"] as const;
export const WEAPON_MUTATIONS = [
  "carbine-ricochet",
  "scattergun-slug",
  "rivet-thermite",
  "beam-prism",
] as const;
export const ANIMATION_TAGS = [
  "idle",
  "run-start",
  "run",
  "run-stop",
  "jump",
  "fall",
  "land",
  "crouch",
  "dodge",
  "melee",
  "fire",
  "reload",
  "hurt",
  "downed",
  "revive",
  "ability",
  "victory",
] as const;

export type OperatorId = (typeof OPERATORS)[number];
export type PrimaryWeaponId = (typeof PRIMARY_WEAPONS)[number];
export type OrdnanceId = (typeof ORDNANCE)[number];
export type RelicId = (typeof RELICS)[number];
export type WeaponMutationId = (typeof WEAPON_MUTATIONS)[number];
export type AnimationTag = (typeof ANIMATION_TAGS)[number];
export type OutfitId = "field" | "foundry";
export type Facing = -1 | 1;
export type GamePhase = "lobby" | "combat" | "reward" | "boss" | "victory" | "defeat";
export type ModuleKind = "approach" | "foundry" | "freight-lift" | "fall" | "kilnheart";
export type EnemyKind =
  | "rifleman"
  | "rusher"
  | "shieldbearer"
  | "grenadier"
  | "drone"
  | "slag-warden"
  | "kilnheart";
export type EnemyMode = "advance" | "hold" | "telegraph" | "attack" | "recover" | "broken" | "vent";
export type ProjectileKind =
  | "bullet"
  | "pellet"
  | "rivet"
  | "beam"
  | "grenade"
  | "mine"
  | "enemy-bullet"
  | "boss-fire";
export type DestructibleKind = "crate" | "barrel" | "boss-platform";
export type HazardKind = "molten" | "steam" | "fall-zone";

export interface LoadoutSelection {
  operator: OperatorId;
  ordnance: OrdnanceId;
  outfit: OutfitId;
  primary: PrimaryWeaponId;
}

export interface InputFrame {
  ability: boolean;
  aimX: number;
  aimY: number;
  crouch: boolean;
  dodge: boolean;
  drop: boolean;
  fire: boolean;
  jump: boolean;
  left: boolean;
  melee: boolean;
  ordnance: boolean;
  reload: boolean;
  right: boolean;
  sequence: number;
}

export interface WeaponState {
  ammo: number;
  cooldown: number;
  heat: number;
  id: PrimaryWeaponId;
  reloadRemaining: number;
  reserve: number;
}

export interface PlayerState {
  acknowledgedInput: number;
  abilityCooldown: number;
  aimX: number;
  aimY: number;
  animation: AnimationTag;
  animationTime: number;
  color: string;
  connected: boolean;
  dodgeCooldown: number;
  dropThroughRemaining: number;
  downed: boolean;
  downedRemaining: number;
  facing: Facing;
  grounded: boolean;
  hp: number;
  id: string;
  invulnerable: number;
  kills: number;
  meleeCooldown: number;
  maxHp: number;
  name: string;
  ordnanceRemaining: number;
  ready: boolean;
  reentryRemaining: number;
  relics: RelicId[];
  reviveProgress: number;
  revives: number;
  score: number;
  selection: LoadoutSelection;
  slot: number;
  speed: number;
  mutations: WeaponMutationId[];
  vx: number;
  vy: number;
  weapon: WeaponState;
  x: number;
  y: number;
}

export interface EnemyState {
  attackCooldown: number;
  bossPhase: 0 | 1 | 2 | 3;
  facing: Facing;
  hp: number;
  id: string;
  kind: EnemyKind;
  maxHp: number;
  mode: EnemyMode;
  modeTimer: number;
  radius: number;
  targetId?: string;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

export interface BossComponentState {
  broken: boolean;
  hp: number;
  id: "left-feed" | "right-feed" | "crown-vent";
  maxHp: number;
  x: number;
  y: number;
}

export interface ProjectileState {
  bounces: number;
  damage: number;
  expires: number;
  id: string;
  kind: ProjectileKind;
  ownerId: string;
  radius: number;
  team: "players" | "enemies";
  vx: number;
  vy: number;
  x: number;
  y: number;
}

export interface PlatformState {
  collapsing: boolean;
  dropAt: number;
  h: number;
  id: string;
  oneWay: boolean;
  vx: number;
  vy: number;
  w: number;
  x: number;
  y: number;
}

export interface HazardState {
  active: boolean;
  h: number;
  id: string;
  kind: HazardKind;
  w: number;
  x: number;
  y: number;
}

export interface DestructibleState {
  destroyed: boolean;
  h: number;
  hp: number;
  id: string;
  kind: DestructibleKind;
  maxHp: number;
  reward?: "ammo" | "ordnance" | "score";
  w: number;
  x: number;
  y: number;
}

export type GameplayEventType =
  | "ability"
  | "boss-component-broken"
  | "boss-telegraph"
  | "destructible-broken"
  | "dodge"
  | "enemy-down"
  | "explosion"
  | "fall-start"
  | "fire"
  | "hit"
  | "land"
  | "melee"
  | "player-downed"
  | "player-hit"
  | "reentry"
  | "reload"
  | "revive"
  | "stage-clear";

export interface GameplayEvent {
  amount?: number;
  id: string;
  kind?: PrimaryWeaponId | OrdnanceId | EnemyKind;
  sourceId?: string;
  targetId?: string;
  type: GameplayEventType;
  x: number;
  y: number;
}

export interface RewardOffer {
  choices: Array<RelicId | WeaponMutationId>;
  picked?: RelicId | WeaponMutationId;
  playerId: string;
}

export interface RunModuleState {
  durationTarget: number;
  endX: number;
  id: string;
  kind: ModuleKind;
  name: string;
  startX: number;
}

export interface GameState {
  bossComponents: BossComponentState[];
  daily: boolean;
  destructibles: DestructibleState[];
  elapsed: number;
  enemies: EnemyState[];
  events: GameplayEvent[];
  hazards: HazardState[];
  moduleIndex: number;
  modules: RunModuleState[];
  phase: GamePhase;
  platforms: PlatformState[];
  players: Record<string, PlayerState>;
  projectiles: ProjectileState[];
  rewardOffers: Record<string, RewardOffer>;
  rng: number;
  roomCode: string;
  runId: string;
  score: number;
  seed: number;
  stageElapsed: number;
  tick: number;
}

export interface LobbyPlayer {
  connected: boolean;
  id: string;
  name: string;
  ready: boolean;
  selection: LoadoutSelection;
  slot: number;
}

export interface CompactSnapshot {
  bossComponents: BossComponentState[];
  destructibles: DestructibleState[];
  elapsed: number;
  enemies: EnemyState[];
  hazards: HazardState[];
  module: RunModuleState;
  phase: GamePhase;
  platforms: PlatformState[];
  players: PlayerState[];
  projectiles: ProjectileState[];
  runId: string;
  score: number;
  stageElapsed: number;
  tick: number;
}

export interface RunResultPlayer {
  kills: number;
  loadout: LoadoutSelection;
  name: string;
  relics: RelicId[];
  revives: number;
  score: number;
  mutations: WeaponMutationId[];
}

export interface RunResult {
  daily: boolean;
  elapsed: number;
  party: RunResultPlayer[];
  result: "victory" | "defeat";
  runId: string;
  score: number;
  seed: number;
}

export type ClientMessage =
  | { name: string; type: "join"; v: typeof PROTOCOL_VERSION }
  | { resumeToken: string; type: "resume"; v: typeof PROTOCOL_VERSION }
  | { selection: LoadoutSelection; type: "selection"; v: typeof PROTOCOL_VERSION }
  | { ready: boolean; type: "ready"; v: typeof PROTOCOL_VERSION }
  | { input: InputFrame; type: "input"; v: typeof PROTOCOL_VERSION }
  | {
      choice: RelicId | WeaponMutationId;
      type: "upgrade-choice";
      v: typeof PROTOCOL_VERSION;
    }
  | { type: "rematch"; v: typeof PROTOCOL_VERSION };

export type ServerMessage =
  | {
      locked: boolean;
      players: LobbyPlayer[];
      resumeToken?: string;
      roomCode: string;
      type: "lobby";
      v: typeof PROTOCOL_VERSION;
      you?: string;
    }
  | {
      acknowledgedInput: number;
      snapshot: CompactSnapshot;
      type: "snapshot";
      v: typeof PROTOCOL_VERSION;
    }
  | { events: GameplayEvent[]; tick: number; type: "gameplay-events"; v: typeof PROTOCOL_VERSION }
  | { offer: RewardOffer; type: "reward-choice"; v: typeof PROTOCOL_VERSION }
  | { result: RunResult; type: "results"; v: typeof PROTOCOL_VERSION }
  | { code: string; message: string; type: "error"; v: typeof PROTOCOL_VERSION };

export const OPERATOR_COPY: Record<
  OperatorId,
  { ability: string; description: string; name: string; passive: string }
> = {
  rook: {
    ability: "Bulwark pulse: block hostile shots and stagger nearby enemies.",
    description: "A defensive bruiser who owns the firing line.",
    name: "Rook",
    passive: "Brace: 35% less damage while crouched.",
  },
  vale: {
    ability: "Rift step: blink through danger and over low cover.",
    description: "An agile skirmisher built for flanks and rescue runs.",
    name: "Vale",
    passive: "Momentum: faster movement and reloads after a dodge.",
  },
};

export const WEAPON_COPY: Record<
  PrimaryWeaponId,
  { description: string; magazine: number; name: string }
> = {
  carbine: {
    description: "Reliable automatic fire at every range.",
    magazine: 30,
    name: "Morrow Carbine",
  },
  scattergun: {
    description: "Heavy close-range spread and knockback.",
    magazine: 6,
    name: "Breach Scattergun",
  },
  "rivet-launcher": {
    description: "Slow explosive rivets that punish armor.",
    magazine: 5,
    name: "Atlas Riveter",
  },
  beam: {
    description: "Continuous precision beam; vent before it overheats.",
    magazine: 100,
    name: "Kiln Beam",
  },
};

export const ORDNANCE_COPY: Record<OrdnanceId, { description: string; name: string }> = {
  "arc-mine": { description: "Personal mine that chains into nearby targets.", name: "Arc Mine" },
  "cinder-bomb": { description: "Shared-safe explosive with a wide blast.", name: "Cinder Bomb" },
};

export const REWARD_COPY: Record<
  RelicId | WeaponMutationId,
  { description: string; name: string }
> = {
  "beam-prism": {
    description: "Kiln Beam forks into a second nearby target.",
    name: "Prismatic Coil",
  },
  "boiler-heart": {
    description: "+35 maximum health and recover 35 health.",
    name: "Boiler Heart",
  },
  "carbine-ricochet": {
    description: "Carbine rounds bounce once from hard cover.",
    name: "Bankshot Feed",
  },
  "crew-standard": {
    description: "Revives complete 35% faster for the whole crew.",
    name: "Crew Standard",
  },
  "deadeye-lens": { description: "+20% damage while standing still.", name: "Deadeye Lens" },
  "rivet-thermite": {
    description: "Rivet explosions bloom into a much wider thermite splash.",
    name: "Thermite Caps",
  },
  "scattergun-slug": {
    description: "Scattergun fires one explosive high-impact slug.",
    name: "Foundry Slug",
  },
  "slag-boots": {
    description: "Molten hazards hurt less and dodges recharge faster.",
    name: "Slag Boots",
  },
};

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!isRecord(value) || value.v !== PROTOCOL_VERSION || typeof value.type !== "string")
    return false;
  if (value.type === "join") return typeof value.name === "string" && value.name.length <= 32;
  if (value.type === "resume") {
    return typeof value.resumeToken === "string" && value.resumeToken.length >= 16;
  }
  if (value.type === "selection") return isLoadoutSelection(value.selection);
  if (value.type === "ready") return typeof value.ready === "boolean";
  if (value.type === "upgrade-choice") return isRewardId(value.choice);
  if (value.type === "rematch") return true;
  return value.type === "input" && isInputFrame(value.input);
}

export function isLoadoutSelection(value: unknown): value is LoadoutSelection {
  if (!isRecord(value)) return false;
  return (
    isOneOf(value.operator, OPERATORS) &&
    isOneOf(value.outfit, ["field", "foundry"] as const) &&
    isOneOf(value.primary, PRIMARY_WEAPONS) &&
    isOneOf(value.ordnance, ORDNANCE)
  );
}

export function isRewardId(value: unknown): value is RelicId | WeaponMutationId {
  return isOneOf(value, [...RELICS, ...WEAPON_MUTATIONS]);
}

export function isInputFrame(value: unknown): value is InputFrame {
  if (!isRecord(value)) return false;
  const buttons = [
    value.ability,
    value.crouch,
    value.dodge,
    value.drop,
    value.fire,
    value.jump,
    value.left,
    value.melee,
    value.ordnance,
    value.reload,
    value.right,
  ];
  return (
    finiteUnit(value.aimX) &&
    finiteUnit(value.aimY) &&
    Number.isSafeInteger(value.sequence) &&
    Number(value.sequence) >= 0 &&
    buttons.every((candidate) => typeof candidate === "boolean")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

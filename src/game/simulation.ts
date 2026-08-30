import {
  type ModuleTemplate,
  describeRunModules,
  getModuleTemplate,
  selectRunModules,
} from "./content.js";
import {
  type CompactSnapshot,
  type DestructibleState,
  type EnemyKind,
  type EnemyState,
  type GameState,
  type GameplayEvent,
  type HazardState,
  type InputFrame,
  type LoadoutSelection,
  type PlatformState,
  type PlayerState,
  type PrimaryWeaponId,
  type ProjectileKind,
  type ProjectileState,
  type RelicId,
  type RunResult,
  TICK_SECONDS,
  WEAPON_COPY,
  WORLD_HEIGHT,
  type WeaponMutationId,
  type WeaponState,
} from "./protocol.js";

const PLAYER_COLORS = ["#ff6a2f", "#72e6c4", "#ffd166", "#a98cff"];
const GRAVITY = 980;
const MAX_FALL_SPEED = 580;
const PLAYER_HALF_WIDTH = 10;
const PLAYER_HEIGHT = 42;
const DOWNED_SECONDS = 12;
const REENTRY_SECONDS = 2.8;
const REVIVE_SECONDS = 1.25;

interface WeaponDefinition {
  cooldown: number;
  damage: number;
  magazine: number;
  projectile: ProjectileKind;
  projectileSpeed: number;
  reload: number;
  reserve: number;
}

const WEAPONS: Record<PrimaryWeaponId, WeaponDefinition> = {
  beam: {
    cooldown: 0.1,
    damage: 9,
    magazine: 100,
    projectile: "beam",
    projectileSpeed: 1_050,
    reload: 0.7,
    reserve: 0,
  },
  carbine: {
    cooldown: 0.13,
    damage: 14,
    magazine: 30,
    projectile: "bullet",
    projectileSpeed: 880,
    reload: 1.35,
    reserve: 180,
  },
  "rivet-launcher": {
    cooldown: 0.72,
    damage: 38,
    magazine: 5,
    projectile: "rivet",
    projectileSpeed: 520,
    reload: 1.8,
    reserve: 35,
  },
  scattergun: {
    cooldown: 0.62,
    damage: 8,
    magazine: 6,
    projectile: "pellet",
    projectileSpeed: 740,
    reload: 1.7,
    reserve: 42,
  },
};

export const EMPTY_INPUT: InputFrame = {
  ability: false,
  aimX: 1,
  aimY: 0,
  crouch: false,
  dodge: false,
  drop: false,
  fire: false,
  jump: false,
  left: false,
  melee: false,
  ordnance: false,
  reload: false,
  right: false,
  sequence: 0,
};

export interface CreateGameOptions {
  daily?: boolean;
  seed?: number;
}

export function hashSeed(value: string): number {
  let hash = 2_166_136_261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0 || 1;
}

export function dailySeed(date: string): number {
  return hashSeed(`edgefall-daily:${date}`);
}

export function createGame(roomCode: string, options: CreateGameOptions = {}): GameState {
  const seed = options.seed ?? hashSeed(roomCode);
  const game: GameState = {
    bossComponents: [],
    daily: options.daily ?? false,
    destructibles: [],
    elapsed: 0,
    enemies: [],
    events: [],
    hazards: [],
    moduleIndex: 0,
    modules: [],
    phase: "lobby",
    platforms: [],
    players: {},
    projectiles: [],
    rewardOffers: {},
    rng: seed,
    roomCode,
    runId: `${roomCode}-${seed.toString(36)}`,
    score: 0,
    seed,
    stageElapsed: 0,
    tick: 0,
  };
  game.modules = describeRunModules(selectRunModules(() => random(game)));
  return game;
}

export function addPlayer(
  game: GameState,
  id: string,
  requestedName: string,
  selection?: LoadoutSelection,
): PlayerState | undefined {
  const existing = game.players[id];
  if (existing) {
    existing.connected = true;
    return existing;
  }
  if (game.phase !== "lobby") return undefined;

  const usedSlots = new Set(Object.values(game.players).map((player) => player.slot));
  const slot = [0, 1, 2, 3].find((candidate) => !usedSlots.has(candidate));
  if (slot === undefined) return undefined;
  const nextSelection = selection ?? defaultSelection(slot);
  const player: PlayerState = {
    acknowledgedInput: 0,
    abilityCooldown: 0,
    aimX: 1,
    aimY: 0,
    animation: "idle",
    animationTime: 0,
    color: PLAYER_COLORS[slot] ?? "#ff6a2f",
    connected: true,
    dodgeCooldown: 0,
    dropThroughRemaining: 0,
    downed: false,
    downedRemaining: 0,
    facing: 1,
    grounded: true,
    hp: 140,
    id,
    invulnerable: 0,
    kills: 0,
    maxHp: 140,
    meleeCooldown: 0,
    name: sanitizeName(requestedName, slot + 1),
    ordnanceRemaining: 3,
    ready: false,
    reentryRemaining: 0,
    relics: [],
    reviveProgress: 0,
    revives: 0,
    score: 0,
    selection: nextSelection,
    slot,
    speed: nextSelection.operator === "vale" ? 174 : 148,
    mutations: [],
    vx: 0,
    vy: 0,
    weapon: createWeapon(nextSelection.primary),
    x: 70 + slot * 34,
    y: 328,
  };
  game.players[id] = player;
  return player;
}

export function removeLobbyPlayer(game: GameState, id: string): boolean {
  if (game.phase !== "lobby") return false;
  if (!game.players[id]) return false;
  delete game.players[id];
  return true;
}

export function setPlayerConnected(game: GameState, id: string, connected: boolean): void {
  const player = game.players[id];
  if (player) player.connected = connected;
}

export function updateSelection(
  game: GameState,
  playerId: string,
  selection: LoadoutSelection,
): boolean {
  if (game.phase !== "lobby") return false;
  const player = game.players[playerId];
  if (!player) return false;
  player.selection = selection;
  player.weapon = createWeapon(selection.primary);
  player.speed = selection.operator === "vale" ? 174 : 148;
  player.ready = false;
  return true;
}

export function setReady(game: GameState, playerId: string, ready: boolean): boolean {
  if (game.phase !== "lobby") return false;
  const player = game.players[playerId];
  if (!player?.connected) return false;
  player.ready = ready;
  return true;
}

export function canStartRun(game: GameState): boolean {
  const connected = Object.values(game.players).filter((player) => player.connected);
  return (
    game.phase === "lobby" && connected.length > 0 && connected.every((player) => player.ready)
  );
}

export function startRun(game: GameState, runId?: string): boolean {
  if (!canStartRun(game)) return false;
  game.bossComponents = [];
  game.destructibles = [];
  game.elapsed = 0;
  game.enemies = [];
  game.events = [];
  game.hazards = [];
  game.moduleIndex = 0;
  game.phase = "combat";
  game.platforms = [];
  game.projectiles = [];
  game.rewardOffers = {};
  game.rng = game.seed;
  game.runId = runId ?? `${game.roomCode}-${game.seed.toString(36)}-${game.tick.toString(36)}`;
  game.score = 0;
  game.stageElapsed = 0;
  game.tick = 0;
  const templates = selectRunModules(() => random(game));
  game.modules = describeRunModules(templates);

  for (const player of Object.values(game.players)) resetPlayer(player);
  materializeModule(game, templates[0] as ModuleTemplate);
  return true;
}

export function resetToLobby(game: GameState): void {
  game.phase = "lobby";
  game.enemies = [];
  game.projectiles = [];
  game.hazards = [];
  game.destructibles = [];
  game.platforms = [];
  game.bossComponents = [];
  game.rewardOffers = {};
  game.stageElapsed = 0;
  game.events = [];
  for (const player of Object.values(game.players)) {
    player.ready = false;
    player.animation = "idle";
    player.downed = false;
    player.reentryRemaining = 0;
  }
}

export function chooseReward(
  game: GameState,
  playerId: string,
  choice: RelicId | WeaponMutationId,
): boolean {
  if (game.phase !== "reward") return false;
  const player = game.players[playerId];
  const offer = game.rewardOffers[playerId];
  if (!player || !offer || offer.picked || !offer.choices.includes(choice)) return false;
  offer.picked = choice;
  applyReward(player, choice);
  if (Object.values(game.rewardOffers).every((candidate) => candidate.picked)) advanceModule(game);
  return true;
}

export function stepGame(
  game: GameState,
  inputs: Readonly<Record<string, InputFrame>>,
  delta = TICK_SECONDS,
): void {
  game.tick += 1;
  game.events = [];
  if (game.phase === "lobby" || game.phase === "victory" || game.phase === "defeat") return;

  if (game.phase === "reward") {
    game.stageElapsed += delta;
    if (game.stageElapsed >= 20) autoChooseRewards(game);
    return;
  }

  const previousStageElapsed = game.stageElapsed;
  game.elapsed += delta;
  game.stageElapsed += delta;
  updateSetPiece(game, previousStageElapsed, delta);

  for (const player of Object.values(game.players)) {
    updatePlayer(game, player, inputs[player.id] ?? EMPTY_INPUT, delta);
  }
  updateRevives(game, inputs, delta);

  for (const enemy of game.enemies) {
    if (enemy.hp > 0) updateEnemy(game, enemy, delta);
  }
  updateProjectiles(game, delta);
  updateHazards(game);

  const defeatedEnemies = game.enemies.filter((enemy) => enemy.hp <= 0);
  for (const enemy of defeatedEnemies) {
    emit(game, "enemy-down", enemy.x, enemy.y, { kind: enemy.kind, targetId: enemy.id });
  }
  game.enemies = game.enemies.filter((enemy) => enemy.hp > 0);
  game.projectiles = game.projectiles.filter((projectile) => projectile.expires > 0);

  if (game.phase === "boss" && !game.enemies.some((enemy) => enemy.kind === "kilnheart")) {
    game.phase = "victory";
    for (const player of Object.values(game.players)) player.animation = "victory";
    return;
  }

  if (game.phase === "boss") {
    const module = game.modules[game.moduleIndex];
    if (module && game.stageElapsed > module.durationTarget + 120) game.phase = "defeat";
    return;
  }

  if (isStageComplete(game)) beginReward(game);
}

export function createCompactSnapshot(game: GameState): CompactSnapshot {
  const module = game.modules[game.moduleIndex] ?? game.modules[0];
  if (!module) throw new Error("Game has no hand-authored modules");
  return {
    bossComponents: game.bossComponents,
    destructibles: game.destructibles,
    elapsed: game.elapsed,
    enemies: game.enemies,
    hazards: game.hazards,
    module,
    phase: game.phase,
    platforms: game.platforms,
    players: Object.values(game.players).sort((left, right) => left.slot - right.slot),
    projectiles: game.projectiles,
    runId: game.runId,
    score: game.score,
    stageElapsed: game.stageElapsed,
    tick: game.tick,
  };
}

export function createRunResult(game: GameState): RunResult {
  return {
    daily: game.daily,
    elapsed: game.elapsed,
    party: Object.values(game.players)
      .sort((left, right) => left.slot - right.slot)
      .map((player) => ({
        kills: player.kills,
        loadout: player.selection,
        name: player.name,
        relics: player.relics,
        revives: player.revives,
        score: player.score,
        mutations: player.mutations,
      })),
    result: game.phase === "victory" ? "victory" : "defeat",
    runId: game.runId,
    score: game.score,
    seed: game.seed,
  };
}

function resetPlayer(player: PlayerState): void {
  player.acknowledgedInput = 0;
  player.abilityCooldown = 0;
  player.aimX = 1;
  player.aimY = 0;
  player.animation = "idle";
  player.animationTime = 0;
  player.dodgeCooldown = 0;
  player.dropThroughRemaining = 0;
  player.downed = false;
  player.downedRemaining = 0;
  player.facing = 1;
  player.grounded = true;
  player.maxHp = player.selection.operator === "rook" ? 160 : 125;
  player.hp = player.maxHp;
  player.invulnerable = 0;
  player.kills = 0;
  player.meleeCooldown = 0;
  player.ordnanceRemaining = 3;
  player.reentryRemaining = 0;
  player.relics = [];
  player.reviveProgress = 0;
  player.revives = 0;
  player.score = 0;
  player.speed = player.selection.operator === "vale" ? 174 : 148;
  player.mutations = [];
  player.vx = 0;
  player.vy = 0;
  player.weapon = createWeapon(player.selection.primary);
}

function createWeapon(id: PrimaryWeaponId): WeaponState {
  const definition = WEAPONS[id];
  return {
    ammo: definition.magazine,
    cooldown: 0,
    heat: 0,
    id,
    reloadRemaining: 0,
    reserve: definition.reserve,
  };
}

function materializeModule(game: GameState, template: ModuleTemplate): void {
  const module = game.modules[game.moduleIndex];
  if (!module) throw new Error("Cannot materialize an unknown run module");
  const offset = module.startX;
  game.stageElapsed = 0;
  game.projectiles = [];
  game.bossComponents = [];
  game.platforms = template.platforms.map((platform, index) => ({
    collapsing: false,
    dropAt: template.kind === "fall" ? 8 + index * 12 : 0,
    h: platform.h,
    id: `${template.id}:${platform.id}`,
    oneWay: platform.oneWay ?? false,
    vx: 0,
    vy: 0,
    w: platform.w,
    x: offset + platform.x,
    y: platform.y,
  }));
  game.hazards = template.hazards.map((hazard) => ({
    active: hazard.kind !== "steam",
    h: hazard.h,
    id: `${template.id}:${hazard.id}`,
    kind: hazard.kind,
    w: hazard.w,
    x: offset + hazard.x,
    y: hazard.y,
  }));
  game.destructibles = template.destructibles.map((object) => ({
    destroyed: false,
    h: object.h,
    hp: object.hp,
    id: `${template.id}:${object.id}`,
    kind: object.kind,
    maxHp: object.hp,
    reward: object.reward,
    w: object.w,
    x: offset + object.x,
    y: object.y,
  }));

  const partyScale = 1 + Math.max(0, Object.keys(game.players).length - 1) * 0.35;
  game.enemies = template.enemies.map((spawn, index) =>
    createEnemy(spawn.kind, `${template.id}:${index}`, offset + spawn.x, spawn.y, partyScale),
  );
  if (Object.keys(game.players).length >= 3 && template.kind !== "kilnheart") {
    game.enemies.push(
      createEnemy("rusher", `${template.id}:reinforcement`, module.endX - 180, 286, partyScale),
    );
  }
  if (template.kind === "kilnheart") {
    game.phase = "boss";
    game.bossComponents = [
      createBossComponent("left-feed", offset + 385, 238, partyScale),
      createBossComponent("right-feed", offset + 515, 238, partyScale),
      createBossComponent("crown-vent", offset + 450, 170, partyScale),
    ];
  } else {
    game.phase = "combat";
  }

  const spawnY = findGroundY(game.platforms, offset + 70) ?? 328;
  for (const player of Object.values(game.players)) {
    player.x = offset + 70 + player.slot * 26;
    player.y = spawnY;
    player.vx = 0;
    player.vy = 0;
    player.grounded = true;
    if (player.reentryRemaining > 0 || player.downed) reenterPlayer(game, player);
  }
  if (template.kind === "fall") emit(game, "fall-start", offset + 80, 180);
}

function createEnemy(
  kind: EnemyKind,
  id: string,
  x: number,
  y: number,
  partyScale: number,
): EnemyState {
  const baseHealth: Record<EnemyKind, number> = {
    drone: 44,
    grenadier: 76,
    kilnheart: 1_500,
    rifleman: 62,
    rusher: 58,
    shieldbearer: 130,
    "slag-warden": 310,
  };
  const maxHp = Math.round(baseHealth[kind] * partyScale);
  return {
    attackCooldown: kind === "kilnheart" ? 1.8 : 0.4,
    bossPhase: kind === "kilnheart" ? 1 : 0,
    facing: -1,
    hp: maxHp,
    id,
    kind,
    maxHp,
    mode: kind === "kilnheart" ? "hold" : "advance",
    modeTimer: kind === "kilnheart" ? 1.8 : 0,
    radius: kind === "kilnheart" ? 54 : kind === "slag-warden" ? 26 : 16,
    vx: 0,
    vy: 0,
    x,
    y,
  };
}

function createBossComponent(
  id: "left-feed" | "right-feed" | "crown-vent",
  x: number,
  y: number,
  scale: number,
) {
  const hp = Math.round(180 * scale);
  return { broken: false, hp, id, maxHp: hp, x, y };
}

function updatePlayer(
  game: GameState,
  player: PlayerState,
  input: InputFrame,
  delta: number,
): void {
  player.acknowledgedInput = Math.max(player.acknowledgedInput, input.sequence);
  player.abilityCooldown = Math.max(0, player.abilityCooldown - delta);
  player.animationTime = Math.max(0, player.animationTime - delta);
  player.dodgeCooldown = Math.max(0, player.dodgeCooldown - delta);
  player.dropThroughRemaining = Math.max(0, player.dropThroughRemaining - delta);
  player.invulnerable = Math.max(0, player.invulnerable - delta);
  player.meleeCooldown = Math.max(0, player.meleeCooldown - delta);
  updateWeapon(player, delta);

  if (player.reentryRemaining > 0) {
    player.reentryRemaining = Math.max(0, player.reentryRemaining - delta);
    if (player.reentryRemaining === 0) reenterPlayer(game, player);
    return;
  }
  if (player.downed) {
    updateDownedPlayer(game, player, input, delta);
    return;
  }

  const aimLength = Math.hypot(input.aimX, input.aimY);
  if (aimLength > 0.05) {
    player.aimX = input.aimX / aimLength;
    player.aimY = input.aimY / aimLength;
  }
  if (aimLength > 0.15 && Math.abs(input.aimX) > 0.08) player.facing = input.aimX < 0 ? -1 : 1;
  const move = Number(input.right) - Number(input.left);
  if (move !== 0 && aimLength <= 0.15) player.facing = move < 0 ? -1 : 1;

  if (input.crouch && input.drop && player.grounded) {
    player.dropThroughRemaining = 0.24;
    player.grounded = false;
    player.y += 3;
  }
  if (input.jump && player.grounded && !input.crouch) {
    player.vy = player.selection.operator === "vale" ? -372 : -345;
    player.grounded = false;
    player.animation = "jump";
    player.animationTime = 0.18;
  }
  if (input.dodge && player.dodgeCooldown === 0) {
    player.dodgeCooldown = player.relics.includes("slag-boots") ? 1.0 : 1.35;
    player.invulnerable = 0.28;
    player.animation = "dodge";
    player.animationTime = 0.22;
    player.vx = player.facing * (player.selection.operator === "vale" ? 430 : 355);
    emit(game, "dodge", player.x, player.y - 20, { sourceId: player.id });
  }

  const dodging = player.animation === "dodge" && player.animationTime > 0;
  if (!dodging) {
    const crouchScale = input.crouch ? 0.45 : 1;
    const momentum = player.selection.operator === "vale" && player.invulnerable > 0 ? 1.15 : 1;
    player.vx = move * player.speed * crouchScale * momentum;
  }
  player.vy = Math.min(MAX_FALL_SPEED, player.vy + GRAVITY * delta);
  movePlayer(game, player, delta);

  if (input.reload) beginReload(game, player);
  if (input.fire) fireWeapon(game, player, input);
  if (input.melee && player.meleeCooldown === 0) performMelee(game, player);
  if (input.ordnance && player.ordnanceRemaining > 0) throwOrdnance(game, player, input);
  if (input.ability && player.abilityCooldown === 0) useAbility(game, player, input);
  updatePlayerAnimation(player, input, move);
}

function updateDownedPlayer(
  game: GameState,
  player: PlayerState,
  input: InputFrame,
  delta: number,
): void {
  player.downedRemaining = Math.max(0, player.downedRemaining - delta);
  player.animation = "downed";
  player.vx = (Number(input.right) - Number(input.left)) * player.speed * 0.28;
  player.vy = Math.min(MAX_FALL_SPEED, player.vy + GRAVITY * delta);
  movePlayer(game, player, delta);
  if (input.fire && player.weapon.cooldown === 0) {
    const aim = normalizeAim(input, player.facing);
    spawnProjectile(
      game,
      player.id,
      "bullet",
      "players",
      player.x,
      player.y - 16,
      aim.x * 650,
      aim.y * 650,
      7,
      0.8,
      0,
    );
    player.weapon.cooldown = 0.36;
    emit(game, "fire", player.x, player.y - 18, { kind: "carbine", sourceId: player.id });
  }
  if (player.downedRemaining === 0) {
    player.downed = false;
    player.reentryRemaining = REENTRY_SECONDS;
    player.reviveProgress = 0;
  }
}

function updateRevives(
  game: GameState,
  inputs: Readonly<Record<string, InputFrame>>,
  delta: number,
): void {
  for (const downed of Object.values(game.players).filter((player) => player.downed)) {
    const rescuer = Object.values(game.players).find((candidate) => {
      const input = inputs[candidate.id];
      return (
        candidate.id !== downed.id &&
        !candidate.downed &&
        candidate.reentryRemaining === 0 &&
        candidate.hp > 0 &&
        Boolean(input?.melee) &&
        distance(candidate, downed) <= 52
      );
    });
    if (!rescuer) {
      downed.reviveProgress = Math.max(0, downed.reviveProgress - delta * 0.3);
      continue;
    }
    const crewBoost = rescuer.relics.includes("crew-standard") ? 1.35 : 1;
    downed.reviveProgress += delta * crewBoost;
    downed.animation = "revive";
    if (downed.reviveProgress < REVIVE_SECONDS) continue;
    downed.downed = false;
    downed.downedRemaining = 0;
    downed.hp = Math.round(downed.maxHp * 0.45);
    downed.invulnerable = 1;
    downed.reviveProgress = 0;
    rescuer.revives += 1;
    rescuer.score += 200;
    game.score += 200;
    emit(game, "revive", downed.x, downed.y - 20, {
      sourceId: rescuer.id,
      targetId: downed.id,
    });
  }
}

function movePlayer(game: GameState, player: PlayerState, delta: number): void {
  const module = game.modules[game.moduleIndex];
  if (!module) return;
  player.x = clamp(
    player.x + player.vx * delta,
    module.startX + PLAYER_HALF_WIDTH,
    module.endX - PLAYER_HALF_WIDTH,
  );

  const previousY = player.y;
  const nextY = player.y + player.vy * delta;
  player.grounded = false;
  if (player.vy >= 0) {
    const landing = game.platforms
      .filter(
        (platform) =>
          !platform.collapsing &&
          player.x + PLAYER_HALF_WIDTH > platform.x &&
          player.x - PLAYER_HALF_WIDTH < platform.x + platform.w &&
          previousY <= platform.y + 4 &&
          nextY >= platform.y &&
          !(platform.oneWay && player.dropThroughRemaining > 0),
      )
      .sort((left, right) => left.y - right.y)[0];
    if (landing) {
      if (!player.grounded && player.vy > 180) {
        emit(game, "land", player.x, landing.y, { sourceId: player.id });
        player.animation = "land";
        player.animationTime = 0.12;
      }
      player.y = landing.y;
      player.vy = landing.vy;
      player.grounded = true;
      return;
    }
  }
  player.y = nextY;
  if (player.y > WORLD_HEIGHT + PLAYER_HEIGHT) {
    damagePlayer(game, player, Math.ceil(player.maxHp * 0.42), "fall");
    reenterPlayer(game, player);
  }
}

function updatePlayerAnimation(player: PlayerState, input: InputFrame, move: number): void {
  const previous = player.animation;
  if (
    player.animationTime > 0 &&
    ["ability", "dodge", "hurt", "land", "melee", "run-start", "run-stop"].includes(
      player.animation,
    )
  ) {
    return;
  }
  if (player.weapon.reloadRemaining > 0) player.animation = "reload";
  else if (!player.grounded) player.animation = player.vy < 0 ? "jump" : "fall";
  else if (input.crouch) player.animation = "crouch";
  else if (input.fire) player.animation = "fire";
  else if (move !== 0) {
    if (previous === "idle" || previous === "run-stop") {
      player.animation = "run-start";
      player.animationTime = 0.1;
    } else player.animation = "run";
  } else if (previous === "run" || previous === "run-start") {
    player.animation = "run-stop";
    player.animationTime = 0.1;
  } else player.animation = "idle";
}

function updateWeapon(player: PlayerState, delta: number): void {
  player.weapon.cooldown = Math.max(0, player.weapon.cooldown - delta);
  player.weapon.heat = Math.max(0, player.weapon.heat - delta * 24);
  if (player.weapon.reloadRemaining <= 0) return;
  player.weapon.reloadRemaining = Math.max(0, player.weapon.reloadRemaining - delta);
  if (player.weapon.reloadRemaining > 0) return;
  const definition = WEAPONS[player.weapon.id];
  const wanted = definition.magazine - player.weapon.ammo;
  const loaded = Math.min(wanted, player.weapon.reserve);
  player.weapon.ammo += loaded;
  player.weapon.reserve -= loaded;
}

function beginReload(game: GameState, player: PlayerState): void {
  const definition = WEAPONS[player.weapon.id];
  if (
    player.weapon.id === "beam" ||
    player.weapon.reloadRemaining > 0 ||
    player.weapon.ammo >= definition.magazine ||
    player.weapon.reserve <= 0
  ) {
    return;
  }
  const valeMomentum = player.selection.operator === "vale" && player.invulnerable > 0 ? 0.7 : 1;
  player.weapon.reloadRemaining = definition.reload * valeMomentum;
  player.animation = "reload";
  emit(game, "reload", player.x, player.y - 18, { kind: player.weapon.id, sourceId: player.id });
}

function fireWeapon(game: GameState, player: PlayerState, input: InputFrame): void {
  const weapon = player.weapon;
  const definition = WEAPONS[weapon.id];
  if (weapon.cooldown > 0 || weapon.reloadRemaining > 0) return;
  if (weapon.id === "beam") {
    if (weapon.heat >= 96) return;
    weapon.heat = Math.min(100, weapon.heat + 8.5);
  } else if (weapon.ammo <= 0) {
    beginReload(game, player);
    return;
  } else {
    weapon.ammo -= 1;
  }

  weapon.cooldown = definition.cooldown;
  const aim = normalizeAim(input, player.facing);
  const stationaryBonus =
    player.relics.includes("deadeye-lens") && Math.abs(player.vx) < 8 ? 1.2 : 1;
  const damage = Math.round(definition.damage * stationaryBonus);
  const originX = player.x + player.facing * 15;
  const originY = player.y - (input.crouch ? 15 : 25);
  if (weapon.id === "scattergun" && !player.mutations.includes("scattergun-slug")) {
    for (const spread of [-0.16, -0.08, 0, 0.08, 0.16]) {
      const direction = rotate(aim.x, aim.y, spread);
      spawnProjectile(
        game,
        player.id,
        "pellet",
        "players",
        originX,
        originY,
        direction.x * definition.projectileSpeed,
        direction.y * definition.projectileSpeed,
        damage,
        0.48,
        0,
      );
    }
  } else {
    const projectileKind =
      weapon.id === "scattergun" && player.mutations.includes("scattergun-slug")
        ? "rivet"
        : definition.projectile;
    const projectileDamage = projectileKind === "rivet" && weapon.id === "scattergun" ? 46 : damage;
    spawnProjectile(
      game,
      player.id,
      projectileKind,
      "players",
      originX,
      originY,
      aim.x * definition.projectileSpeed,
      aim.y * definition.projectileSpeed,
      projectileDamage,
      projectileKind === "beam" ? 0.16 : 1.2,
      player.mutations.includes("carbine-ricochet") ? 1 : 0,
    );
  }
  player.animation = "fire";
  emit(game, "fire", originX, originY, { kind: weapon.id, sourceId: player.id });
}

function performMelee(game: GameState, player: PlayerState): void {
  player.meleeCooldown = 0.58;
  player.animation = "melee";
  player.animationTime = 0.24;
  emit(game, "melee", player.x + player.facing * 20, player.y - 22, { sourceId: player.id });
  for (const enemy of game.enemies) {
    if (Math.abs(enemy.x - player.x) > 54 || Math.abs(enemy.y - (player.y - 20)) > 52) continue;
    if (Math.sign(enemy.x - player.x) !== player.facing && Math.abs(enemy.x - player.x) > 18)
      continue;
    damageEnemy(game, enemy, 28, player.id, player.x);
  }
  for (const object of game.destructibles) {
    if (!object.destroyed && distance(player, centerOf(object)) <= 58)
      damageDestructible(game, object, 32, player.id);
  }
}

function throwOrdnance(game: GameState, player: PlayerState, input: InputFrame): void {
  if (player.weapon.cooldown > 0.18) return;
  player.ordnanceRemaining -= 1;
  player.weapon.cooldown = Math.max(player.weapon.cooldown, 0.5);
  const aim = normalizeAim(input, player.facing);
  const kind: ProjectileKind = player.selection.ordnance === "cinder-bomb" ? "grenade" : "mine";
  spawnProjectile(
    game,
    player.id,
    kind,
    "players",
    player.x,
    player.y - 22,
    kind === "mine" ? player.facing * 80 : aim.x * 250,
    kind === "mine" ? -70 : aim.y * 180 - 130,
    kind === "mine" ? 52 : 74,
    kind === "mine" ? 8 : 1.15,
    0,
  );
}

function useAbility(game: GameState, player: PlayerState, input: InputFrame): void {
  player.animation = "ability";
  player.animationTime = 0.38;
  player.abilityCooldown = player.selection.operator === "rook" ? 8 : 6;
  player.invulnerable = Math.max(player.invulnerable, 0.35);
  if (player.selection.operator === "rook") {
    for (const projectile of game.projectiles) {
      if (projectile.team === "enemies" && distance(player, projectile) <= 145)
        projectile.expires = 0;
    }
    for (const enemy of game.enemies) {
      if (distance(player, enemy) <= 125) {
        damageEnemy(game, enemy, 18, player.id, player.x);
        enemy.mode = "recover";
        enemy.modeTimer = Math.max(enemy.modeTimer, 0.35);
      }
    }
  } else {
    const aim = normalizeAim(input, player.facing);
    const module = game.modules[game.moduleIndex];
    if (module) player.x = clamp(player.x + aim.x * 118, module.startX + 16, module.endX - 16);
    player.y = clamp(player.y + aim.y * 55, 80, 328);
    player.invulnerable = 0.52;
  }
  emit(game, "ability", player.x, player.y - 20, { sourceId: player.id });
}

function updateEnemy(game: GameState, enemy: EnemyState, delta: number): void {
  enemy.attackCooldown = Math.max(0, enemy.attackCooldown - delta);
  enemy.modeTimer = Math.max(0, enemy.modeTimer - delta);
  const target = nearestActivePlayer(game, enemy);
  if (!target) return;
  enemy.targetId = target.id;
  enemy.facing = target.x < enemy.x ? -1 : 1;
  if (enemy.kind === "kilnheart") {
    updateBoss(game, enemy);
    return;
  }

  const dx = target.x - enemy.x;
  const dy = target.y - 20 - enemy.y;
  const range = Math.abs(dx);
  const definitions: Record<Exclude<EnemyKind, "kilnheart">, { range: number; speed: number }> = {
    drone: { range: 230, speed: 72 },
    grenadier: { range: 260, speed: 48 },
    rifleman: { range: 220, speed: 58 },
    rusher: { range: 30, speed: 112 },
    shieldbearer: { range: 34, speed: 52 },
    "slag-warden": { range: 55, speed: 70 },
  };
  const definition = definitions[enemy.kind];
  if (range > definition.range) enemy.x += Math.sign(dx) * definition.speed * delta;
  else if (range < definition.range * 0.55 && enemy.kind !== "rusher") {
    enemy.x -= Math.sign(dx) * definition.speed * 0.45 * delta;
  }
  if (enemy.attackCooldown > 0) return;

  if (
    ["rusher", "shieldbearer", "slag-warden"].includes(enemy.kind) &&
    range <= definition.range + 12
  ) {
    damagePlayer(
      game,
      target,
      enemy.kind === "slag-warden" ? 28 : enemy.kind === "shieldbearer" ? 18 : 14,
      enemy.id,
    );
    enemy.attackCooldown = enemy.kind === "rusher" ? 0.75 : 1.05;
    return;
  }

  const aimLength = Math.hypot(dx, dy) || 1;
  if (enemy.kind === "grenadier") {
    spawnProjectile(
      game,
      enemy.id,
      "grenade",
      "enemies",
      enemy.x,
      enemy.y - 15,
      (dx / aimLength) * 180,
      -170,
      24,
      1.4,
      0,
    );
    enemy.attackCooldown = 2.2;
  } else if (enemy.kind === "drone" || enemy.kind === "rifleman" || enemy.kind === "slag-warden") {
    const speed = enemy.kind === "drone" ? 360 : 420;
    spawnProjectile(
      game,
      enemy.id,
      "enemy-bullet",
      "enemies",
      enemy.x,
      enemy.y - 12,
      (dx / aimLength) * speed,
      (dy / aimLength) * speed,
      enemy.kind === "slag-warden" ? 20 : 12,
      1.6,
      0,
    );
    enemy.attackCooldown = enemy.kind === "drone" ? 1.15 : 1.4;
  }
}

function updateBoss(game: GameState, boss: EnemyState): void {
  const ratio = boss.hp / boss.maxHp;
  boss.bossPhase = ratio > 0.66 ? 1 : ratio > 0.33 ? 2 : 3;
  if (boss.mode === "hold" && boss.modeTimer === 0) {
    boss.mode = "telegraph";
    boss.modeTimer = boss.bossPhase === 3 ? 0.85 : 1.15;
    emit(game, "boss-telegraph", boss.x, boss.y - 45, { kind: boss.kind, sourceId: boss.id });
    return;
  }
  if (boss.mode === "telegraph" && boss.modeTimer === 0) {
    boss.mode = "attack";
    executeBossAttack(game, boss);
    boss.mode = "vent";
    boss.modeTimer = boss.bossPhase === 1 ? 1.35 : 1.05;
    return;
  }
  if (boss.mode === "vent" && boss.modeTimer === 0) {
    boss.mode = "recover";
    boss.modeTimer = 0.5;
    return;
  }
  if (boss.mode === "recover" && boss.modeTimer === 0) {
    boss.mode = "hold";
    boss.modeTimer = boss.bossPhase === 3 ? 0.8 : 1.25;
  }
}

function executeBossAttack(game: GameState, boss: EnemyState): void {
  const target = nearestActivePlayer(game, boss);
  if (target) {
    const baseAngle = Math.atan2(target.y - 24 - boss.y, target.x - boss.x);
    const count = boss.bossPhase === 1 ? 3 : boss.bossPhase === 2 ? 5 : 9;
    for (let index = 0; index < count; index += 1) {
      const angle = baseAngle + (index - (count - 1) / 2) * 0.12;
      spawnProjectile(
        game,
        boss.id,
        "boss-fire",
        "enemies",
        boss.x,
        boss.y - 34,
        Math.cos(angle) * 330,
        Math.sin(angle) * 330,
        boss.bossPhase === 3 ? 24 : 18,
        2.2,
        0,
      );
    }
  }
  if (boss.bossPhase >= 2) {
    for (const player of Object.values(game.players)) {
      if (!player.downed && Math.abs(player.x - boss.x) < (boss.bossPhase === 3 ? 230 : 150)) {
        damagePlayer(game, player, boss.bossPhase === 3 ? 30 : 22, boss.id);
      }
    }
    emit(game, "explosion", boss.x, 320, { amount: boss.bossPhase, sourceId: boss.id });
  }
  if (boss.bossPhase === 3) {
    for (const object of game.destructibles.filter(
      (candidate) => candidate.kind === "boss-platform",
    )) {
      if (!object.destroyed) damageDestructible(game, object, object.hp, boss.id);
    }
  }
}

function updateProjectiles(game: GameState, delta: number): void {
  const module = game.modules[game.moduleIndex];
  if (!module) return;
  for (const projectile of game.projectiles) {
    if (projectile.expires <= 0) continue;
    projectile.expires -= delta;
    if (
      projectile.kind === "grenade" ||
      projectile.kind === "mine" ||
      projectile.kind === "rivet"
    ) {
      projectile.vy += GRAVITY * 0.62 * delta;
    }
    projectile.x += projectile.vx * delta;
    projectile.y += projectile.vy * delta;

    if (projectile.x < module.startX || projectile.x > module.endX) {
      if (projectile.bounces > 0) {
        projectile.vx *= -1;
        projectile.bounces -= 1;
        projectile.x = clamp(projectile.x, module.startX + 2, module.endX - 2);
      } else projectile.expires = 0;
    }

    const floor = findGroundY(game.platforms, projectile.x);
    if (floor !== undefined && projectile.y >= floor) {
      if (projectile.kind === "mine") {
        projectile.y = floor - 3;
        projectile.vx = 0;
        projectile.vy = 0;
      } else if (["grenade", "rivet"].includes(projectile.kind)) {
        explodeProjectile(game, projectile);
        continue;
      } else projectile.expires = 0;
    }

    if (projectile.kind === "mine") {
      const target = game.enemies.find((enemy) => distance(projectile, enemy) <= 78);
      if (target) explodeProjectile(game, projectile);
      continue;
    }

    if (projectile.team === "players") {
      const component = game.bossComponents.find(
        (candidate) =>
          !candidate.broken && distance(projectile, candidate) <= projectile.radius + 20,
      );
      if (component) {
        component.hp = Math.max(0, component.hp - projectile.damage);
        projectile.expires = 0;
        emit(game, "hit", component.x, component.y, {
          amount: projectile.damage,
          sourceId: projectile.ownerId,
          targetId: component.id,
        });
        if (component.hp === 0) {
          component.broken = true;
          game.score += 500;
          emit(game, "boss-component-broken", component.x, component.y, { targetId: component.id });
        }
        continue;
      }
      const enemy = game.enemies.find(
        (candidate) => distance(projectile, candidate) <= projectile.radius + candidate.radius,
      );
      if (enemy) {
        damageEnemy(game, enemy, projectile.damage, projectile.ownerId, projectile.x);
        if (projectile.kind === "rivet") explodeProjectile(game, projectile);
        else projectile.expires = 0;
        if (projectile.kind === "beam") applyBeamPrism(game, projectile, enemy);
        continue;
      }
      const object = game.destructibles.find(
        (candidate) => !candidate.destroyed && pointInRect(projectile, candidate),
      );
      if (object) {
        damageDestructible(game, object, projectile.damage, projectile.ownerId);
        if (projectile.kind === "rivet") explodeProjectile(game, projectile);
        else projectile.expires = 0;
      }
    } else {
      const player = Object.values(game.players).find(
        (candidate) =>
          !candidate.downed &&
          candidate.reentryRemaining === 0 &&
          distance(projectile, { x: candidate.x, y: candidate.y - PLAYER_HEIGHT / 2 }) <=
            projectile.radius + 12,
      );
      if (player) {
        damagePlayer(game, player, projectile.damage, projectile.ownerId);
        if (projectile.kind === "grenade") explodeProjectile(game, projectile);
        else projectile.expires = 0;
      }
    }

    if (projectile.expires <= 0 && ["grenade", "rivet"].includes(projectile.kind)) {
      explodeProjectile(game, projectile);
    }
  }
}

function applyBeamPrism(
  game: GameState,
  projectile: ProjectileState,
  firstTarget: EnemyState,
): void {
  const owner = game.players[projectile.ownerId];
  if (!owner?.mutations.includes("beam-prism")) return;
  const second = game.enemies.find(
    (enemy) => enemy.id !== firstTarget.id && enemy.hp > 0 && distance(enemy, firstTarget) <= 110,
  );
  if (second)
    damageEnemy(game, second, Math.ceil(projectile.damage * 0.65), owner.id, firstTarget.x);
}

function explodeProjectile(game: GameState, projectile: ProjectileState): void {
  if (projectile.expires < -1) return;
  projectile.expires = -2;
  const thermite =
    projectile.kind === "rivet" &&
    game.players[projectile.ownerId]?.mutations.includes("rivet-thermite");
  const radius =
    projectile.kind === "rivet" ? (thermite ? 104 : 58) : projectile.kind === "mine" ? 92 : 105;
  emit(game, "explosion", projectile.x, projectile.y, {
    amount: projectile.damage,
    sourceId: projectile.ownerId,
  });
  if (projectile.team === "players") {
    for (const enemy of game.enemies) {
      if (distance(projectile, enemy) <= radius + enemy.radius) {
        damageEnemy(game, enemy, projectile.damage, projectile.ownerId, projectile.x);
      }
    }
    for (const object of game.destructibles) {
      if (!object.destroyed && distance(projectile, centerOf(object)) <= radius) {
        damageDestructible(game, object, projectile.damage, projectile.ownerId);
      }
    }
  } else {
    for (const player of Object.values(game.players)) {
      if (!player.downed && distance(projectile, player) <= radius) {
        damagePlayer(game, player, projectile.damage, projectile.ownerId);
      }
    }
  }
}

function spawnProjectile(
  game: GameState,
  ownerId: string,
  kind: ProjectileKind,
  team: "players" | "enemies",
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  expires: number,
  bounces: number,
): void {
  game.projectiles.push({
    bounces,
    damage,
    expires,
    id: `p-${game.tick}-${game.projectiles.length}`,
    kind,
    ownerId,
    radius: kind === "grenade" || kind === "mine" ? 7 : kind === "rivet" ? 5 : 3,
    team,
    vx,
    vy,
    x,
    y,
  });
}

function damageEnemy(
  game: GameState,
  enemy: EnemyState,
  amount: number,
  sourceId: string,
  sourceX: number,
): void {
  if (enemy.hp <= 0) return;
  let multiplier = 1;
  if (enemy.kind === "shieldbearer" && Math.sign(sourceX - enemy.x) === enemy.facing)
    multiplier = 0.28;
  if (enemy.kind === "kilnheart") {
    if (game.bossComponents.some((component) => !component.broken)) multiplier = 0.08;
    else if (enemy.mode !== "vent") multiplier = 0.24;
  }
  const applied = Math.max(1, Math.round(amount * multiplier));
  enemy.hp = Math.max(0, enemy.hp - applied);
  const player = game.players[sourceId];
  if (player) {
    player.score += applied * 2;
    if (enemy.hp === 0) player.kills += 1;
  }
  game.score += applied * 2;
  emit(game, "hit", enemy.x, enemy.y, { amount: applied, sourceId, targetId: enemy.id });
}

function damagePlayer(
  game: GameState,
  player: PlayerState,
  amount: number,
  sourceId: string,
): void {
  if (player.invulnerable > 0 || player.downed || player.reentryRemaining > 0) return;
  let applied = amount;
  if (player.selection.operator === "rook" && player.animation === "crouch") applied *= 0.65;
  if (player.relics.includes("slag-boots") && sourceId === "hazard") applied *= 0.6;
  player.hp = Math.max(0, player.hp - Math.max(1, Math.round(applied)));
  player.invulnerable = 0.32;
  player.animation = "hurt";
  player.animationTime = 0.18;
  emit(game, "player-hit", player.x, player.y - 20, {
    amount: Math.round(applied),
    sourceId,
    targetId: player.id,
  });
  if (player.hp > 0) return;
  player.downed = true;
  player.downedRemaining = DOWNED_SECONDS;
  player.reviveProgress = 0;
  player.animation = "downed";
  emit(game, "player-downed", player.x, player.y - 20, { sourceId, targetId: player.id });
}

function damageDestructible(
  game: GameState,
  object: DestructibleState,
  amount: number,
  playerId: string,
): void {
  if (object.destroyed) return;
  object.hp = Math.max(0, object.hp - amount);
  if (object.hp > 0) return;
  object.destroyed = true;
  if (object.kind === "boss-platform") {
    const platform = game.platforms.find((candidate) => candidate.id === object.id);
    if (platform) platform.collapsing = true;
  }
  const crew = Object.values(game.players);
  if (object.reward === "ammo") {
    for (const player of crew) {
      const definition = WEAPONS[player.weapon.id];
      player.weapon.reserve = Math.min(
        definition.reserve,
        player.weapon.reserve + Math.ceil(definition.magazine * 1.5),
      );
    }
  }
  if (object.reward === "ordnance") {
    for (const player of crew) {
      player.ordnanceRemaining = Math.min(5, player.ordnanceRemaining + 1);
    }
  }
  if (object.reward === "score") {
    game.score += 250;
    const share = Math.floor(250 / Math.max(1, crew.length));
    for (const player of crew) player.score += share;
  }
  emit(game, "destructible-broken", object.x + object.w / 2, object.y + object.h / 2, {
    sourceId: playerId,
    targetId: object.id,
  });
}

function updateHazards(game: GameState): void {
  for (const hazard of game.hazards) {
    if (hazard.kind === "steam") hazard.active = Math.floor(game.stageElapsed / 1.6) % 2 === 1;
    if (!hazard.active) continue;
    for (const player of Object.values(game.players)) {
      if (player.downed || player.reentryRemaining > 0) continue;
      if (pointInRect({ x: player.x, y: player.y - 8 }, hazard)) {
        damagePlayer(game, player, hazard.kind === "fall-zone" ? 60 : 14, "hazard");
      }
    }
  }
}

function updateSetPiece(game: GameState, previousElapsed: number, delta: number): void {
  const module = game.modules[game.moduleIndex];
  if (!module) return;
  if (module.kind === "freight-lift") {
    const lift = game.platforms.find((platform) => platform.id.endsWith(":lift-platform"));
    if (lift) {
      const previousY = lift.y;
      lift.y = 278 + Math.sin(game.stageElapsed * 0.42) * 34;
      lift.vy = (lift.y - previousY) / delta;
      for (const player of Object.values(game.players)) {
        if (
          Math.abs(player.y - previousY) < 5 &&
          player.x >= lift.x &&
          player.x <= lift.x + lift.w
        ) {
          player.y = lift.y;
        }
      }
    }
    for (const waveTime of [28, 58, 88]) {
      if (previousElapsed < waveTime && game.stageElapsed >= waveTime)
        spawnLiftWave(game, waveTime);
    }
  }
  if (module.kind === "fall") {
    for (const platform of game.platforms) {
      if (!platform.collapsing && game.stageElapsed >= platform.dropAt) platform.collapsing = true;
    }
  }
  for (const platform of game.platforms) {
    if (!platform.collapsing) continue;
    platform.vy = Math.min(260, platform.vy + GRAVITY * 0.32 * delta);
    platform.y += platform.vy * delta;
  }
}

function spawnLiftWave(game: GameState, waveTime: number): void {
  const module = game.modules[game.moduleIndex];
  if (!module) return;
  const scale = 1 + Math.max(0, Object.keys(game.players).length - 1) * 0.35;
  const wave = Math.round(waveTime);
  game.enemies.push(
    createEnemy("rusher", `lift-wave-${wave}-a`, module.startX + 120, 238, scale),
    createEnemy("rifleman", `lift-wave-${wave}-b`, module.endX - 120, 238, scale),
  );
  if (Object.keys(game.players).length >= 2) {
    game.enemies.push(createEnemy("drone", `lift-wave-${wave}-c`, module.endX - 240, 130, scale));
  }
}

function isStageComplete(game: GameState): boolean {
  const module = game.modules[game.moduleIndex];
  if (!module) return false;
  if (module.kind === "freight-lift") return game.stageElapsed >= 105 && game.enemies.length === 0;
  if (module.kind === "fall") return game.stageElapsed >= 72;
  if (game.enemies.length > 0) return false;
  const activePlayers = Object.values(game.players).filter(
    (player) => player.reentryRemaining === 0,
  );
  return activePlayers.every((player) => player.x >= module.endX - 120);
}

function beginReward(game: GameState): void {
  const module = game.modules[game.moduleIndex];
  if (!module) return;
  game.phase = "reward";
  game.stageElapsed = 0;
  game.projectiles = [];
  game.rewardOffers = {};
  emit(game, "stage-clear", module.endX - 60, 180);
  for (const player of Object.values(game.players)) {
    const weaponMutation = mutationFor(player.weapon.id);
    const rewardPool: Array<RelicId | WeaponMutationId> = [
      weaponMutation,
      "boiler-heart",
      "deadeye-lens",
      "slag-boots",
      "crew-standard",
    ];
    const pool = rewardPool.filter(
      (choice) =>
        !player.relics.includes(choice as RelicId) &&
        !player.mutations.includes(choice as WeaponMutationId),
    );
    shuffle(game, pool);
    game.rewardOffers[player.id] = { choices: pool.slice(0, 3), playerId: player.id };
  }
}

function autoChooseRewards(game: GameState): void {
  for (const offer of Object.values(game.rewardOffers)) {
    if (offer.picked) continue;
    const choice = offer.choices[0];
    if (choice) chooseReward(game, offer.playerId, choice);
  }
}

function advanceModule(game: GameState): void {
  game.moduleIndex += 1;
  const module = game.modules[game.moduleIndex];
  if (!module) {
    game.phase = "victory";
    return;
  }
  materializeModule(game, getModuleTemplate(module.id));
}

function applyReward(player: PlayerState, choice: RelicId | WeaponMutationId): void {
  if (
    choice.includes("carbine-") ||
    choice.includes("scattergun-") ||
    choice.includes("rivet-") ||
    choice.includes("beam-")
  ) {
    player.mutations.push(choice as WeaponMutationId);
    return;
  }
  player.relics.push(choice as RelicId);
  if (choice === "boiler-heart") {
    player.maxHp += 35;
    player.hp = Math.min(player.maxHp, player.hp + 35);
  }
}

function mutationFor(weapon: PrimaryWeaponId): WeaponMutationId {
  if (weapon === "carbine") return "carbine-ricochet";
  if (weapon === "scattergun") return "scattergun-slug";
  if (weapon === "rivet-launcher") return "rivet-thermite";
  return "beam-prism";
}

function reenterPlayer(game: GameState, player: PlayerState): void {
  const module = game.modules[game.moduleIndex];
  if (!module) return;
  const anchor = Object.values(game.players).find(
    (candidate) =>
      candidate.id !== player.id && !candidate.downed && candidate.reentryRemaining === 0,
  );
  player.x = clamp(anchor?.x ?? module.startX + 80, module.startX + 24, module.endX - 24);
  player.y = findGroundY(game.platforms, player.x) ?? 328;
  player.vx = 0;
  player.vy = 0;
  player.hp = Math.max(1, Math.round(player.maxHp * 0.5));
  player.downed = false;
  player.downedRemaining = 0;
  player.reentryRemaining = 0;
  player.invulnerable = 1.6;
  player.animation = "idle";
  emit(game, "reentry", player.x, player.y - 20, { sourceId: player.id });
}

function nearestActivePlayer(
  game: GameState,
  source: Pick<EnemyState, "x" | "y">,
): PlayerState | undefined {
  return Object.values(game.players)
    .filter((player) => !player.downed && player.reentryRemaining === 0 && player.hp > 0)
    .sort((left, right) => distance(left, source) - distance(right, source))[0];
}

function findGroundY(platforms: readonly PlatformState[], x: number): number | undefined {
  return platforms
    .filter((platform) => !platform.collapsing && x >= platform.x && x <= platform.x + platform.w)
    .sort((left, right) => right.y - left.y)[0]?.y;
}

function defaultSelection(slot: number): LoadoutSelection {
  return {
    operator: slot % 2 === 0 ? "rook" : "vale",
    ordnance: slot % 2 === 0 ? "cinder-bomb" : "arc-mine",
    outfit: slot < 2 ? "field" : "foundry",
    primary: (["carbine", "scattergun", "rivet-launcher", "beam"] as const)[slot] ?? "carbine",
  };
}

function normalizeAim(input: Pick<InputFrame, "aimX" | "aimY">, facing: -1 | 1) {
  const length = Math.hypot(input.aimX, input.aimY);
  if (length < 0.05) return { x: facing, y: 0 };
  return { x: input.aimX / length, y: input.aimY / length };
}

function rotate(x: number, y: number, angle: number) {
  return {
    x: x * Math.cos(angle) - y * Math.sin(angle),
    y: x * Math.sin(angle) + y * Math.cos(angle),
  };
}

function centerOf(object: Pick<DestructibleState, "h" | "w" | "x" | "y">) {
  return { x: object.x + object.w / 2, y: object.y + object.h / 2 };
}

function pointInRect(
  point: Pick<ProjectileState | PlayerState, "x" | "y">,
  rectangle: Pick<DestructibleState | HazardState, "h" | "w" | "x" | "y">,
): boolean {
  return (
    point.x >= rectangle.x &&
    point.x <= rectangle.x + rectangle.w &&
    point.y >= rectangle.y &&
    point.y <= rectangle.y + rectangle.h
  );
}

function distance(left: { x: number; y: number }, right: { x: number; y: number }): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function emit(
  game: GameState,
  type: GameplayEvent["type"],
  x: number,
  y: number,
  detail: Partial<Omit<GameplayEvent, "id" | "type" | "x" | "y">> = {},
): void {
  game.events.push({ ...detail, id: `${game.tick}-${game.events.length}`, type, x, y });
}

function random(game: GameState): number {
  let value = game.rng;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  game.rng = value >>> 0;
  return game.rng / 0x1_0000_0000;
}

function shuffle<T>(game: GameState, values: T[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random(game) * (index + 1));
    [values[index], values[swap]] = [values[swap] as T, values[index] as T];
  }
}

function sanitizeName(value: string, fallbackIndex: number): string {
  const cleaned = value
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .slice(0, 18);
  return cleaned || `Operative ${fallbackIndex}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function weaponMagazine(id: PrimaryWeaponId): number {
  return WEAPON_COPY[id].magazine;
}

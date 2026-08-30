import {
  type CombatEvent,
  type EnemyState,
  type GameState,
  type InputFrame,
  type PlayerState,
  TICK_SECONDS,
  type UpgradeId,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./protocol.js";

const PLAYER_COLORS = ["#ff5e1f", "#55d6be", "#ffd166", "#9b8cff"];
const EMPTY_INPUT: InputFrame = {
  aimX: 1,
  aimY: 0,
  attack: false,
  dash: false,
  down: false,
  left: false,
  right: false,
  sequence: 0,
  up: false,
};

export function hashSeed(value: string): number {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 1;
}

export function createGame(roomCode: string): GameState {
  const seed = hashSeed(roomCode);
  return {
    elapsed: 0,
    enemies: [],
    events: [],
    phase: "lobby",
    players: {},
    rng: seed,
    roomCode,
    runId: `${roomCode}-${seed.toString(36)}`,
    seed,
    tick: 0,
    upgradeChoices: [],
  };
}

export function addPlayer(game: GameState, id: string, requestedName: string): PlayerState {
  const existing = game.players[id];
  if (existing) return existing;

  const index = Object.keys(game.players).length;
  const player: PlayerState = {
    angle: 0,
    attackAnimation: 0,
    attackCooldown: 0,
    color: PLAYER_COLORS[index % PLAYER_COLORS.length] ?? PLAYER_COLORS[0] ?? "#ff5e1f",
    damage: 24,
    dashCooldown: 0,
    dashRemaining: 0,
    hp: 120,
    id,
    invulnerable: 0,
    kills: 0,
    lives: 2,
    maxHp: 120,
    name: sanitizeName(requestedName, index + 1),
    range: 112,
    respawnRemaining: 0,
    speed: 285,
    upgrades: [],
    x: WORLD_WIDTH / 2 - 90 + index * 60,
    y: WORLD_HEIGHT / 2 + 240,
  };
  game.players[id] = player;
  return player;
}

export function removePlayer(game: GameState, id: string): void {
  delete game.players[id];
}

export function startRun(game: GameState): void {
  game.elapsed = 0;
  game.enemies = [];
  game.events = [];
  game.phase = "wave";
  game.rng = game.seed;
  game.runId = `${game.roomCode}-${Date.now().toString(36)}`;
  game.tick = 0;
  game.upgradeChoices = [];

  let index = 0;
  for (const player of Object.values(game.players)) {
    resetPlayer(player, index);
    index += 1;
  }
  spawnWave(game);
}

export function chooseUpgrade(game: GameState, playerId: string, upgrade: UpgradeId): boolean {
  if (game.phase !== "choice" || !game.upgradeChoices.includes(upgrade)) return false;
  const player = game.players[playerId];
  if (!player || player.upgrades.length > 0) return false;

  applyUpgrade(player, upgrade);
  if (Object.values(game.players).every((candidate) => candidate.upgrades.length > 0)) {
    game.phase = "boss";
    spawnBoss(game);
  }
  return true;
}

export function stepGame(
  game: GameState,
  inputs: Readonly<Record<string, InputFrame>>,
  delta = TICK_SECONDS,
): void {
  game.tick += 1;
  game.events = [];
  if (game.phase !== "wave" && game.phase !== "boss") return;

  game.elapsed += delta;
  for (const player of Object.values(game.players)) {
    updatePlayer(game, player, inputs[player.id] ?? EMPTY_INPUT, delta);
  }

  for (const enemy of game.enemies) {
    if (enemy.hp > 0) updateEnemy(game, enemy, delta);
  }

  const defeated = game.enemies.filter((enemy) => enemy.hp <= 0);
  for (const enemy of defeated) {
    emit(game, "enemy-down", enemy.x, enemy.y, { targetId: enemy.id });
  }
  game.enemies = game.enemies.filter((enemy) => enemy.hp > 0);

  if (game.enemies.length === 0) {
    if (game.phase === "wave") {
      game.phase = "choice";
      game.upgradeChoices = pickUpgrades(game);
    } else {
      game.phase = "victory";
    }
  }

  const players = Object.values(game.players);
  if (
    players.length > 0 &&
    players.every((player) => player.hp <= 0 && player.lives <= 0 && player.respawnRemaining <= 0)
  ) {
    game.phase = "defeat";
  }
}

function resetPlayer(player: PlayerState, index: number): void {
  player.angle = -Math.PI / 2;
  player.attackAnimation = 0;
  player.attackCooldown = 0;
  player.damage = 24;
  player.dashCooldown = 0;
  player.dashRemaining = 0;
  player.hp = 120;
  player.invulnerable = 0;
  player.kills = 0;
  player.lives = 2;
  player.maxHp = 120;
  player.range = 112;
  player.respawnRemaining = 0;
  player.speed = 285;
  player.upgrades = [];
  player.x = WORLD_WIDTH / 2 - 90 + index * 60;
  player.y = WORLD_HEIGHT / 2 + 240;
}

function updatePlayer(
  game: GameState,
  player: PlayerState,
  input: InputFrame,
  delta: number,
): void {
  player.attackAnimation = Math.max(0, player.attackAnimation - delta);
  player.attackCooldown = Math.max(0, player.attackCooldown - delta);
  player.dashCooldown = Math.max(0, player.dashCooldown - delta);
  player.invulnerable = Math.max(0, player.invulnerable - delta);

  if (player.hp <= 0) {
    if (player.respawnRemaining > 0) {
      player.respawnRemaining = Math.max(0, player.respawnRemaining - delta);
      if (player.respawnRemaining === 0 && player.lives > 0) {
        player.hp = player.maxHp;
        player.invulnerable = 1.5;
        player.x = WORLD_WIDTH / 2;
        player.y = WORLD_HEIGHT / 2 + 260;
        emit(game, "respawn", player.x, player.y, { sourceId: player.id });
      }
    }
    return;
  }

  const aimLength = Math.hypot(input.aimX, input.aimY);
  if (aimLength > 0.05) player.angle = Math.atan2(input.aimY, input.aimX);

  let moveX = Number(input.right) - Number(input.left);
  let moveY = Number(input.down) - Number(input.up);
  const moveLength = Math.hypot(moveX, moveY);
  if (moveLength > 0) {
    moveX /= moveLength;
    moveY /= moveLength;
  }

  if (input.dash && player.dashCooldown === 0 && moveLength > 0) {
    player.dashRemaining = 0.18;
    player.dashCooldown = 2.1;
    player.invulnerable = 0.28;
    emit(game, "dash", player.x, player.y, { sourceId: player.id });
  }

  const velocity = player.dashRemaining > 0 ? 870 : player.speed;
  player.x = clamp(player.x + moveX * velocity * delta, 54, WORLD_WIDTH - 54);
  player.y = clamp(player.y + moveY * velocity * delta, 54, WORLD_HEIGHT - 54);
  player.dashRemaining = Math.max(0, player.dashRemaining - delta);

  if (input.attack && player.attackCooldown === 0) {
    player.attackCooldown = 0.43;
    player.attackAnimation = 0.28;
    emit(game, "slash", player.x, player.y, { sourceId: player.id });
    for (const enemy of game.enemies) {
      if (enemy.hp <= 0 || !insideAttackArc(player, enemy)) continue;
      enemy.hp -= player.damage;
      player.kills += enemy.hp <= 0 ? 1 : 0;
      emit(game, "hit", enemy.x, enemy.y, {
        amount: player.damage,
        sourceId: player.id,
        targetId: enemy.id,
      });
    }
  }
}

function updateEnemy(game: GameState, enemy: EnemyState, delta: number): void {
  enemy.contactCooldown = Math.max(0, enemy.contactCooldown - delta);
  const target = nearestLivingPlayer(game, enemy);
  if (!target) return;
  enemy.targetId = target.id;

  if (enemy.kind === "boss") {
    updateBoss(game, enemy, target, delta);
    return;
  }

  const dx = target.x - enemy.x;
  const dy = target.y - enemy.y;
  const distance = Math.hypot(dx, dy) || 1;
  const speed = enemy.kind === "brute" ? 94 : 145;
  enemy.x += (dx / distance) * speed * delta;
  enemy.y += (dy / distance) * speed * delta;

  if (distance < enemy.radius + 30 && enemy.contactCooldown === 0) {
    damagePlayer(game, target, enemy.kind === "brute" ? 24 : 13, enemy.id);
    enemy.contactCooldown = enemy.kind === "brute" ? 1.05 : 0.72;
  }
}

function updateBoss(game: GameState, boss: EnemyState, target: PlayerState, delta: number): void {
  boss.modeTimer -= delta;
  const dx = target.x - boss.x;
  const dy = target.y - boss.y;
  const distance = Math.hypot(dx, dy) || 1;

  if (boss.mode === "chase") {
    boss.x += (dx / distance) * 88 * delta;
    boss.y += (dy / distance) * 88 * delta;
    if (boss.modeTimer <= 0) {
      boss.attackCycle += 1;
      boss.mode = boss.attackCycle % 2 === 0 ? "windup-slam" : "windup-cleave";
      boss.modeTimer = boss.mode === "windup-slam" ? 1.05 : 0.82;
      boss.angle = Math.atan2(dy, dx);
    }
    return;
  }

  if (boss.mode === "windup-cleave" && boss.modeTimer <= 0) {
    emit(game, "boss-cleave", boss.x, boss.y, { sourceId: boss.id });
    for (const player of Object.values(game.players)) {
      const playerAngle = Math.atan2(player.y - boss.y, player.x - boss.x);
      if (
        player.hp > 0 &&
        distanceBetween(player, boss) < 285 &&
        Math.abs(wrapAngle(playerAngle - boss.angle)) < 0.65
      ) {
        damagePlayer(game, player, 38, boss.id);
      }
    }
    boss.mode = "recover";
    boss.modeTimer = 0.62;
    return;
  }

  if (boss.mode === "windup-slam" && boss.modeTimer <= 0) {
    emit(game, "boss-slam", boss.x, boss.y, { sourceId: boss.id });
    for (const player of Object.values(game.players)) {
      const playerDistance = distanceBetween(player, boss);
      if (player.hp > 0 && playerDistance > 135 && playerDistance < 390) {
        damagePlayer(game, player, 32, boss.id);
      }
    }
    boss.mode = "recover";
    boss.modeTimer = 0.72;
    return;
  }

  if (boss.mode === "recover" && boss.modeTimer <= 0) {
    boss.mode = "chase";
    boss.modeTimer = boss.hp < boss.maxHp * 0.45 ? 0.72 : 1.18;
  }
}

function damagePlayer(
  game: GameState,
  player: PlayerState,
  amount: number,
  sourceId: string,
): void {
  if (player.invulnerable > 0 || player.hp <= 0) return;
  player.hp = Math.max(0, player.hp - amount);
  player.invulnerable = 0.34;
  emit(game, "player-hit", player.x, player.y, {
    amount,
    sourceId,
    targetId: player.id,
  });
  if (player.hp === 0 && player.lives > 0) {
    player.lives -= 1;
    player.respawnRemaining = 2.4;
  }
}

function spawnWave(game: GameState): void {
  const players = Math.max(1, Object.keys(game.players).length);
  const count = 4 + players * 2;
  for (let index = 0; index < count; index += 1) {
    const kind = index % 4 === 3 ? "brute" : "wisp";
    const angle = (index / count) * Math.PI * 2 + random(game) * 0.4;
    const radius = 270 + random(game) * 120;
    const hp = kind === "brute" ? 92 : 48;
    game.enemies.push({
      angle: 0,
      attackCycle: 0,
      contactCooldown: random(game),
      hp,
      id: `enemy-${game.tick}-${index}`,
      kind,
      maxHp: hp,
      mode: "chase",
      modeTimer: 0,
      radius: kind === "brute" ? 35 : 24,
      x: WORLD_WIDTH / 2 + Math.cos(angle) * radius,
      y: WORLD_HEIGHT / 2 + Math.sin(angle) * radius * 0.72,
    });
  }
}

function spawnBoss(game: GameState): void {
  const players = Math.max(1, Object.keys(game.players).length);
  const hp = 620 + (players - 1) * 300;
  game.enemies = [
    {
      angle: 0,
      attackCycle: 0,
      contactCooldown: 0,
      hp,
      id: "rift-warden",
      kind: "boss",
      maxHp: hp,
      mode: "chase",
      modeTimer: 1.3,
      radius: 72,
      x: WORLD_WIDTH / 2,
      y: WORLD_HEIGHT / 2 - 210,
    },
  ];
  for (const player of Object.values(game.players)) {
    player.hp = Math.min(player.maxHp, player.hp + player.maxHp * 0.45);
  }
}

function pickUpgrades(game: GameState): UpgradeId[] {
  const pool: UpgradeId[] = ["fury", "fleet", "reach", "ward", "second-wind"];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random(game) * (index + 1));
    [pool[index], pool[swap]] = [pool[swap] as UpgradeId, pool[index] as UpgradeId];
  }
  return pool.slice(0, 3);
}

function applyUpgrade(player: PlayerState, upgrade: UpgradeId): void {
  player.upgrades.push(upgrade);
  if (upgrade === "fury") player.damage = Math.round(player.damage * 1.35);
  if (upgrade === "fleet") player.speed = Math.round(player.speed * 1.22);
  if (upgrade === "reach") player.range = Math.round(player.range * 1.3);
  if (upgrade === "ward") {
    player.maxHp += 45;
    player.hp = player.maxHp;
  }
  if (upgrade === "second-wind") {
    player.lives += 1;
    player.hp = player.maxHp;
  }
}

function nearestLivingPlayer(game: GameState, enemy: EnemyState): PlayerState | undefined {
  return Object.values(game.players)
    .filter((player) => player.hp > 0)
    .sort((left, right) => distanceBetween(left, enemy) - distanceBetween(right, enemy))[0];
}

function insideAttackArc(player: PlayerState, enemy: EnemyState): boolean {
  const dx = enemy.x - player.x;
  const dy = enemy.y - player.y;
  const distance = Math.hypot(dx, dy);
  if (distance > player.range + enemy.radius) return false;
  const targetAngle = Math.atan2(dy, dx);
  return Math.abs(wrapAngle(targetAngle - player.angle)) < Math.PI * 0.42;
}

function emit(
  game: GameState,
  type: CombatEvent["type"],
  x: number,
  y: number,
  detail: Partial<Omit<CombatEvent, "id" | "type" | "x" | "y">> = {},
): void {
  game.events.push({
    ...detail,
    id: `${game.tick}-${game.events.length}`,
    type,
    x,
    y,
  });
}

function random(game: GameState): number {
  let value = game.rng;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  game.rng = value >>> 0;
  return game.rng / 0x1_0000_0000;
}

function sanitizeName(value: string, fallbackIndex: number): string {
  const cleaned = value
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .trim()
    .slice(0, 18);
  return cleaned || `Riftwalker ${fallbackIndex}`;
}

function distanceBetween(
  left: Pick<PlayerState | EnemyState, "x" | "y">,
  right: Pick<PlayerState | EnemyState, "x" | "y">,
): number {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function wrapAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

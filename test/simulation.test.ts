import { describe, expect, it } from "vitest";
import { getModuleTemplate } from "../src/game/content.js";
import {
  ANIMATION_TAGS,
  type GameState,
  type InputFrame,
  type LoadoutSelection,
  type PlayerState,
  type PrimaryWeaponId,
  TICK_SECONDS,
} from "../src/game/protocol.js";
import {
  EMPTY_INPUT,
  addPlayer,
  chooseReward,
  createCompactSnapshot,
  createGame,
  createRunResult,
  setReady,
  startRun,
  stepGame,
  updateSelection,
} from "../src/game/simulation.js";

describe("Edgefall deterministic side-scroller", () => {
  it("selects a deterministic run from hand-authored modules with every enemy role and set piece", () => {
    const first = createGame("module-seed");
    const second = createGame("module-seed");
    expect(first.modules).toEqual(second.modules);
    expect(first.modules).toHaveLength(5);
    expect(first.modules.map((module) => module.kind).slice(-3)).toEqual([
      "freight-lift",
      "fall",
      "kilnheart",
    ]);

    const roles = new Set(
      first.modules.flatMap((module) =>
        getModuleTemplate(module.id).enemies.map((enemy) => enemy.kind),
      ),
    );
    expect(roles).toEqual(
      new Set([
        "rifleman",
        "rusher",
        "shieldbearer",
        "grenadier",
        "drone",
        "slag-warden",
        "kilnheart",
      ]),
    );
    expect(first.modules.reduce((seconds, module) => seconds + module.durationTarget, 0)).toBe(690);
  });

  it("replays the same input stream into an identical compact snapshot", () => {
    const first = createStartedGame("determinism", 2);
    const second = createStartedGame("determinism", 2);
    for (let tick = 0; tick < 180; tick += 1) {
      const inputs = {
        p0: input(tick, { fire: tick % 9 === 0, jump: tick === 12, right: tick < 80 }),
        p1: input(tick, { ability: tick === 40, left: tick > 100, right: tick <= 100 }),
      };
      stepGame(first, inputs);
      stepGame(second, inputs);
    }
    expect(createCompactSnapshot(first)).toEqual(createCompactSnapshot(second));
  });

  it("keeps movement inside the module and supports jump and one-way-platform drops", () => {
    const game = createStartedGame("collision");
    game.enemies = [];
    const player = requirePlayer(game, "p0");
    for (let tick = 0; tick < 120; tick += 1) stepGame(game, { p0: input(tick, { left: true }) });
    const openingModule = game.modules[0];
    expect(openingModule).toBeDefined();
    if (!openingModule) return;
    expect(player.x).toBe(openingModule.startX + 10);

    player.grounded = true;
    player.y = 328;
    stepGame(game, { p0: input(121, { jump: true }) });
    expect(player.grounded).toBe(false);
    expect(player.vy).toBeLessThan(0);

    const oneWay = game.platforms.find((platform) => platform.oneWay);
    expect(oneWay).toBeDefined();
    if (!oneWay) return;
    player.x = oneWay.x + oneWay.w / 2;
    player.y = oneWay.y;
    player.vy = 0;
    player.grounded = true;
    stepGame(game, { p0: input(122, { crouch: true, drop: true }) });
    expect(player.dropThroughRemaining).toBeGreaterThan(0);
    expect(player.grounded).toBe(false);
    for (let tick = 0; tick < 12; tick += 1) stepGame(game, { p0: input(123 + tick) });
    expect(player.y).toBeGreaterThan(oneWay.y + oneWay.h);
  });

  it("transitions through authored run-start and run-stop states", () => {
    const game = createStartedGame("locomotion-animation");
    game.enemies = [];
    const player = requirePlayer(game, "p0");
    stepGame(game, { p0: input(1, { right: true }) });
    expect(player.animation).toBe("run-start");
    for (let tick = 2; tick < 8; tick += 1) stepGame(game, { p0: input(tick, { right: true }) });
    expect(player.animation).toBe("run");
    stepGame(game, { p0: input(8) });
    expect(player.animation).toBe("run-stop");
    for (let tick = 9; tick < 15; tick += 1) stepGame(game, { p0: input(tick) });
    expect(player.animation).toBe("idle");
  });

  it.each([
    ["carbine", 1, "bullet"],
    ["scattergun", 5, "pellet"],
    ["rivet-launcher", 1, "rivet"],
    ["beam", 1, "beam"],
  ] as const)("gives the %s a distinct projectile pattern", (weapon, count, projectile) => {
    const game = createStartedGameWithWeapon(`weapon-${weapon}`, weapon);
    game.enemies = [];
    const player = requirePlayer(game, "p0");
    stepGame(game, { p0: input(1, { fire: true }) });
    expect(game.projectiles).toHaveLength(count);
    expect(new Set(game.projectiles.map((candidate) => candidate.kind))).toEqual(
      new Set([projectile]),
    );
    if (weapon === "beam") expect(player.weapon.heat).toBeGreaterThan(0);
    else
      expect(player.weapon.ammo).toBe(
        player.weapon.id === "carbine" ? 29 : player.weapon.id === "scattergun" ? 5 : 4,
      );
  });

  it("never lets player fire or ordnance damage another player", () => {
    const game = createStartedGame("friendly-fire", 2);
    game.enemies = [];
    const shooter = requirePlayer(game, "p0");
    const ally = requirePlayer(game, "p1");
    ally.x = shooter.x + 28;
    ally.y = shooter.y;
    const hp = ally.hp;
    stepGame(game, { p0: input(1, { fire: true, ordnance: true }), p1: input(1) });
    for (let tick = 2; tick < 50; tick += 1) {
      stepGame(game, { p0: input(tick), p1: input(tick) });
    }
    expect(ally.hp).toBe(hp);
  });

  it("shares destructible supplies automatically across the crew", () => {
    const game = createStartedGame("shared-salvage", 2);
    game.enemies = [];
    const object = game.destructibles[0];
    expect(object).toBeDefined();
    if (!object) return;
    object.reward = "ammo";
    for (const player of Object.values(game.players)) player.weapon.reserve = 0;
    object.hp = 1;
    game.projectiles.push({
      bounces: 0,
      damage: 1,
      expires: 1,
      id: "shared-salvage-test",
      kind: "bullet",
      ownerId: "p0",
      radius: 3,
      team: "players",
      vx: 0,
      vy: 0,
      x: object.x + object.w / 2,
      y: object.y + object.h / 2,
    });
    stepGame(game, { p0: input(1), p1: input(1) });
    expect(object.destroyed).toBe(true);
    expect(Object.values(game.players).every((player) => player.weapon.reserve > 0)).toBe(true);
  });

  it("offers personal rewards and applies a behaviour-changing weapon mutation", () => {
    const game = createStartedGameWithWeapon("reward", "scattergun", 2);
    completeCurrentStage(game);
    expect(game.phase).toBe("reward");
    const rook = requirePlayer(game, "p0");
    const vale = requirePlayer(game, "p1");
    const rookOffer = game.rewardOffers[rook.id];
    const valeOffer = game.rewardOffers[vale.id];
    expect(rookOffer).toBeDefined();
    expect(valeOffer).toBeDefined();
    if (!rookOffer || !valeOffer) return;
    rookOffer.choices = ["scattergun-slug"];
    valeOffer.choices = ["boiler-heart"];
    expect(chooseReward(game, rook.id, "scattergun-slug")).toBe(true);
    expect(game.phase).toBe("reward");
    expect(rook.mutations).toContain("scattergun-slug");
    expect(vale.mutations).toEqual([]);
    expect(chooseReward(game, vale.id, "boiler-heart")).toBe(true);
    expect(game.phase).toBe("combat");
    expect(vale.relics).toContain("boiler-heart");

    game.enemies = [];
    stepGame(game, { p0: input(20, { fire: true }), p1: input(20) });
    expect(game.projectiles.filter((projectile) => projectile.ownerId === rook.id)).toHaveLength(1);
    expect(game.projectiles.find((projectile) => projectile.ownerId === rook.id)?.kind).toBe(
      "rivet",
    );
  });

  it("widens the rivet blast when Thermite Caps are equipped", () => {
    const normal = createRivetBlastGame("normal-rivet");
    const thermite = createRivetBlastGame("thermite-rivet");
    requirePlayer(thermite, "p0").mutations.push("rivet-thermite");
    const normalNearbyHp = normal.enemies[1]?.hp;
    const thermiteNearbyHp = thermite.enemies[1]?.hp;
    expect(normalNearbyHp).toBeDefined();
    expect(thermiteNearbyHp).toBeDefined();
    stepGame(normal, { p0: input(1) });
    stepGame(thermite, { p0: input(1) });
    expect(normal.enemies[1]?.hp).toBe(normalNearbyHp);
    expect(thermite.enemies[1]?.hp).toBeLessThan(thermiteNearbyHp ?? 0);
  });

  it("supports downed sidearm fire, ally revival, and quick re-entry", () => {
    const game = createStartedGame("recovery", 2);
    game.enemies = [];
    const downed = requirePlayer(game, "p0");
    const rescuer = requirePlayer(game, "p1");
    downPlayer(game, downed);
    expect(downed.downed).toBe(true);

    stepGame(game, { p0: input(2, { fire: true }), p1: input(2) });
    expect(game.events.some((event) => event.type === "fire" && event.sourceId === downed.id)).toBe(
      true,
    );
    rescuer.x = downed.x + 8;
    rescuer.y = downed.y;
    for (let tick = 3; tick < 46; tick += 1) {
      stepGame(game, { p0: input(tick), p1: input(tick, { melee: true }) });
    }
    expect(downed.downed).toBe(false);
    expect(downed.hp).toBeGreaterThan(0);
    expect(rescuer.revives).toBe(1);

    downed.invulnerable = 0;
    downPlayer(game, downed, 50);
    downed.downedRemaining = TICK_SECONDS / 2;
    stepGame(game, { p0: input(51), p1: input(51) });
    expect(downed.reentryRemaining).toBeGreaterThan(2);
    for (let tick = 52; tick < 145; tick += 1) {
      stepGame(game, { p0: input(tick), p1: input(tick) });
    }
    expect(downed.reentryRemaining).toBe(0);
    expect(downed.hp).toBeGreaterThan(0);
  });

  it("moves the freight lift and collapses the hand-authored Fall gantries", () => {
    const game = createStartedGame("set-pieces");
    advanceToKind(game, "freight-lift");
    const lift = game.platforms.find((platform) => platform.id.endsWith(":lift-platform"));
    expect(lift).toBeDefined();
    if (!lift) return;
    const initialY = lift.y;
    const initialEnemies = game.enemies.length;
    game.stageElapsed = 27.99;
    stepGame(game, { p0: input(100) }, 0.02);
    expect(lift.y).not.toBe(initialY);
    expect(game.enemies.length).toBeGreaterThan(initialEnemies);

    game.enemies = [];
    game.stageElapsed = 105;
    stepGame(game, { p0: input(101) });
    chooseEveryReward(game);
    expect(game.modules[game.moduleIndex]?.kind).toBe("fall");
    const firstGantry = game.platforms[0];
    expect(firstGantry).toBeDefined();
    if (!firstGantry) return;
    game.stageElapsed = firstGantry.dropAt;
    const gantryY = firstGantry.y;
    stepGame(game, { p0: input(102) });
    expect(firstGantry.collapsing).toBe(true);
    expect(firstGantry.y).toBeGreaterThan(gantryY);
  });

  it("runs the Kilnheart through three phases, breakable components, telegraphs, and platform destruction", () => {
    const game = createStartedGame("kilnheart");
    advanceToKind(game, "kilnheart");
    const boss = game.enemies.find((enemy) => enemy.kind === "kilnheart");
    expect(boss).toBeDefined();
    expect(game.bossComponents).toHaveLength(3);
    expect(game.destructibles.filter((object) => object.kind === "boss-platform")).toHaveLength(2);
    if (!boss) return;

    boss.mode = "hold";
    boss.modeTimer = 0;
    stepGame(game, { p0: input(200) });
    expect(boss.bossPhase).toBe(1);
    expect(boss.mode).toBe("telegraph");
    expect(game.events.some((event) => event.type === "boss-telegraph")).toBe(true);

    boss.hp = boss.maxHp * 0.5;
    boss.mode = "hold";
    boss.modeTimer = 1;
    stepGame(game, { p0: input(201) });
    expect(boss.bossPhase).toBe(2);

    const component = game.bossComponents[0];
    expect(component).toBeDefined();
    if (!component) return;
    game.projectiles.push({
      bounces: 0,
      damage: component.maxHp,
      expires: 1,
      id: "component-test",
      kind: "bullet",
      ownerId: "p0",
      radius: 3,
      team: "players",
      vx: 0,
      vy: 0,
      x: component.x,
      y: component.y,
    });
    stepGame(game, { p0: input(202) });
    expect(component.broken).toBe(true);

    boss.hp = boss.maxHp * 0.2;
    boss.mode = "telegraph";
    boss.modeTimer = 0;
    stepGame(game, { p0: input(203) });
    expect(boss.bossPhase).toBe(3);
    expect(
      game.destructibles
        .filter((object) => object.kind === "boss-platform")
        .every((object) => object.destroyed),
    ).toBe(true);
    expect(
      game.platforms
        .filter((platform) => platform.id.includes("boss-platform"))
        .every((platform) => platform.collapsing),
    ).toBe(true);

    boss.hp = 0;
    stepGame(game, { p0: input(204) });
    expect(game.phase).toBe("victory");
    expect(createRunResult(game).result).toBe("victory");
  });

  it("exposes every presentation animation state in the shared contract", () => {
    expect(ANIMATION_TAGS).toEqual([
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
    ]);
  });
});

function createStartedGame(seed: string, players = 1): GameState {
  const game = createGame(seed);
  for (let slot = 0; slot < players; slot += 1) {
    expect(addPlayer(game, `p${slot}`, `Operative ${slot + 1}`)).toBeDefined();
    expect(setReady(game, `p${slot}`, true)).toBe(true);
  }
  expect(startRun(game, `run-${seed}`)).toBe(true);
  return game;
}

function createStartedGameWithWeapon(
  seed: string,
  weapon: PrimaryWeaponId,
  players = 1,
): GameState {
  const game = createGame(seed);
  for (let slot = 0; slot < players; slot += 1) {
    const player = addPlayer(game, `p${slot}`, `Operative ${slot + 1}`);
    expect(player).toBeDefined();
    const selection: LoadoutSelection = {
      operator: slot % 2 === 0 ? "rook" : "vale",
      ordnance: slot % 2 === 0 ? "cinder-bomb" : "arc-mine",
      outfit: slot % 2 === 0 ? "field" : "foundry",
      primary: weapon,
    };
    expect(updateSelection(game, `p${slot}`, selection)).toBe(true);
    expect(setReady(game, `p${slot}`, true)).toBe(true);
  }
  expect(startRun(game, `run-${seed}`)).toBe(true);
  return game;
}

function requirePlayer(game: GameState, id: string): PlayerState {
  const player = game.players[id];
  expect(player).toBeDefined();
  if (!player) throw new Error(`Missing test player ${id}`);
  return player;
}

function input(sequence: number, overrides: Partial<InputFrame> = {}): InputFrame {
  return { ...EMPTY_INPUT, sequence, ...overrides };
}

function completeCurrentStage(game: GameState): void {
  const module = game.modules[game.moduleIndex];
  expect(module).toBeDefined();
  if (!module) return;
  game.enemies = [];
  if (module.kind === "freight-lift") game.stageElapsed = 105;
  else if (module.kind === "fall") game.stageElapsed = 72;
  else for (const player of Object.values(game.players)) player.x = module.endX - 60;
  stepGame(
    game,
    Object.fromEntries(Object.keys(game.players).map((id, index) => [id, input(500 + index)])),
  );
  expect(game.phase).toBe("reward");
}

function chooseEveryReward(game: GameState): void {
  for (const offer of Object.values(game.rewardOffers)) {
    const choice = offer.choices[0];
    expect(choice).toBeDefined();
    if (choice) expect(chooseReward(game, offer.playerId, choice)).toBe(true);
  }
}

function advanceToKind(game: GameState, kind: GameState["modules"][number]["kind"]): void {
  while (game.modules[game.moduleIndex]?.kind !== kind) {
    completeCurrentStage(game);
    chooseEveryReward(game);
  }
}

function downPlayer(game: GameState, player: PlayerState, sequence = 1): void {
  game.projectiles.push({
    bounces: 0,
    damage: player.maxHp * 2,
    expires: 1,
    id: `down-${sequence}`,
    kind: "enemy-bullet",
    ownerId: "test-enemy",
    radius: 3,
    team: "enemies",
    vx: 0,
    vy: 0,
    x: player.x,
    y: player.y - 21,
  });
  const inputs = Object.fromEntries(Object.keys(game.players).map((id) => [id, input(sequence)]));
  stepGame(game, inputs);
}

function createRivetBlastGame(seed: string): GameState {
  const game = createStartedGameWithWeapon(seed, "rivet-launcher");
  const first = game.enemies[0];
  const nearby = game.enemies[1];
  expect(first).toBeDefined();
  expect(nearby).toBeDefined();
  if (!first || !nearby) return game;
  first.x = 200;
  first.y = 250;
  first.radius = 10;
  first.attackCooldown = 999;
  nearby.x = 300;
  nearby.y = 250;
  nearby.radius = 10;
  nearby.attackCooldown = 999;
  game.enemies = [first, nearby];
  game.projectiles.push({
    bounces: 0,
    damage: 20,
    expires: 1,
    id: "rivet-blast-test",
    kind: "rivet",
    ownerId: "p0",
    radius: 5,
    team: "players",
    vx: 0,
    vy: 0,
    x: first.x,
    y: first.y,
  });
  return game;
}

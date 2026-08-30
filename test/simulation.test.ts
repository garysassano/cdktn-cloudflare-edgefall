import { describe, expect, it } from "vitest";
import { type InputFrame, isClientMessage } from "../src/game/protocol.js";
import {
  addPlayer,
  chooseUpgrade,
  createGame,
  startRun,
  stepGame,
} from "../src/game/simulation.js";

const idle: InputFrame = {
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

describe("Edgefall simulation", () => {
  it("builds the same opening wave from the same room seed", () => {
    const first = createGame("ember-test");
    const second = createGame("ember-test");
    addPlayer(first, "player", "Ash");
    addPlayer(second, "player", "Ash");
    startRun(first);
    startRun(second);

    expect(first.enemies).toEqual(second.enemies);
  });

  it("keeps authoritative player movement inside the arena", () => {
    const game = createGame("bounds");
    const player = addPlayer(game, "player", "Ash");
    startRun(game);
    player.x = 55;
    for (let index = 0; index < 20; index += 1) {
      stepGame(game, { player: { ...idle, left: true } });
    }
    expect(player.x).toBe(54);
  });

  it("applies a melee hit only inside the attack arc", () => {
    const game = createGame("combat");
    const player = addPlayer(game, "player", "Ash");
    startRun(game);
    const enemy = game.enemies[0];
    expect(enemy).toBeDefined();
    if (!enemy) return;
    enemy.x = player.x + 70;
    enemy.y = player.y;
    const startingHealth = enemy.hp;

    stepGame(game, { player: { ...idle, attack: true } });

    expect(enemy.hp).toBe(startingHealth - player.damage);
    expect(game.events.some((event) => event.type === "hit")).toBe(true);
  });

  it("offers three blessings after the opening wave", () => {
    const game = createGame("blessing");
    addPlayer(game, "player", "Ash");
    startRun(game);
    for (const enemy of game.enemies) enemy.hp = 0;

    stepGame(game, { player: idle });

    expect(game.phase).toBe("choice");
    expect(game.upgradeChoices).toHaveLength(3);
    expect(new Set(game.upgradeChoices).size).toBe(3);
  });

  it("starts the Rift Warden after every player chooses a blessing", () => {
    const game = createGame("warden");
    const player = addPlayer(game, "player", "Ash");
    startRun(game);
    for (const enemy of game.enemies) enemy.hp = 0;
    stepGame(game, { player: idle });
    const upgrade = game.upgradeChoices[0];
    expect(upgrade).toBeDefined();
    if (!upgrade) return;

    expect(chooseUpgrade(game, player.id, upgrade)).toBe(true);
    expect(game.phase).toBe("boss");
    expect(game.enemies).toHaveLength(1);
    expect(game.enemies[0]?.kind).toBe("boss");
  });

  it("makes a dash briefly invulnerable", () => {
    const game = createGame("dash");
    const player = addPlayer(game, "player", "Ash");
    startRun(game);

    stepGame(game, { player: { ...idle, dash: true, right: true } });

    expect(player.dashCooldown).toBeGreaterThan(2);
    expect(player.invulnerable).toBeGreaterThan(0);
    expect(game.events.some((event) => event.type === "dash")).toBe(true);
  });

  it("keeps players behind the Rift Warden safe from its cleave", () => {
    const game = createGame("cleave");
    const player = addPlayer(game, "player", "Ash");
    startRun(game);
    for (const enemy of game.enemies) enemy.hp = 0;
    stepGame(game, { player: idle });
    const upgrade = game.upgradeChoices[0];
    expect(upgrade).toBeDefined();
    if (!upgrade) return;
    chooseUpgrade(game, player.id, upgrade);

    const boss = game.enemies[0];
    expect(boss).toBeDefined();
    if (!boss) return;
    boss.mode = "windup-cleave";
    boss.modeTimer = 0;
    boss.angle = 0;
    player.x = boss.x - 100;
    player.y = boss.y;
    const startingHealth = player.hp;

    stepGame(game, { player: idle });

    expect(player.hp).toBe(startingHealth);
  });

  it("rejects malformed client input before it reaches the simulation", () => {
    expect(isClientMessage(null)).toBe(false);
    expect(isClientMessage({ type: "input", input: { ...idle, aimX: "right" } })).toBe(false);
    expect(isClientMessage({ type: "input", input: { ...idle, aimX: 4 } })).toBe(false);
    expect(isClientMessage({ type: "input", input: idle })).toBe(true);
  });
});

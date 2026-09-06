import type { GameState, InputFrame } from "../protocol.js";
import { EMPTY_INPUT, addPlayer, createGame, setReady, startRun, stepGame } from "../simulation.js";

export const BASELINE_SCENARIOS = ["enemy-ledge", "thin-obstacle", "jump-fire"] as const;
export type BaselineScenario = (typeof BASELINE_SCENARIOS)[number];

/** Frozen v2 reproductions. Keep these separate from the replacement arcade kernel. */
export function createBaselineScenario(scenario: BaselineScenario): GameState {
  const game = createGame("baseline", { seed: 47321 });
  const player = addPlayer(game, "p0", "Baseline operative");
  if (!player) throw new Error("Baseline player creation failed");
  setReady(game, player.id, true);
  startRun(game, "baseline-v2");
  game.enemies = [];
  game.hazards = [];
  game.destructibles = [];
  game.projectiles = [];
  game.platforms = [
    {
      id: "floor",
      x: 0,
      y: 328,
      w: 900,
      h: 32,
      oneWay: false,
      vx: 0,
      vy: 0,
      collapsing: false,
      dropAt: 0,
    },
  ];
  player.x = 500;
  player.y = 328;
  player.invulnerable = 999;
  if (scenario === "enemy-ledge") {
    game.platforms.push({
      id: "ledge",
      x: 80,
      y: 220,
      w: 80,
      h: 12,
      oneWay: false,
      vx: 0,
      vy: 0,
      collapsing: false,
      dropAt: 0,
    });
    game.enemies.push({
      id: "ledge-rusher",
      kind: "rusher",
      x: 150,
      y: 200,
      vx: 0,
      vy: 0,
      hp: 100,
      maxHp: 100,
      radius: 18,
      facing: 1,
      mode: "advance",
      modeTimer: 0,
      attackCooldown: 999,
      bossPhase: 0,
    });
  } else if (scenario === "thin-obstacle") {
    player.x = 200;
    game.destructibles.push({
      id: "thin-crate",
      kind: "crate",
      x: 111,
      y: 180,
      w: 4,
      h: 40,
      hp: 30,
      maxHp: 30,
      destroyed: false,
    });
    game.projectiles.push({
      id: "fast-shot",
      ownerId: "p0",
      kind: "bullet",
      team: "players",
      x: 100,
      y: 200,
      vx: 880,
      vy: 0,
      radius: 2,
      damage: 14,
      expires: 1,
      bounces: 0,
    });
  } else {
    player.x = 100;
  }
  return game;
}

export function advanceBaseline(game: GameState, scenario: BaselineScenario): void {
  const input: InputFrame = { ...EMPTY_INPUT, sequence: game.tick + 1 };
  if (scenario === "jump-fire") {
    input.right = game.tick < 60;
    input.jump = game.tick === 5;
    input.fire = game.tick >= 5 && game.tick < 45;
  }
  stepGame(game, { p0: input });
}
